"""Bake a supported chase cloud shader into a local native density grid.

The Geometry Nodes field evaluates the existing world-space atlas support
once per grid node. Paired blend ramps and sub-grid erosion remain analytic
shader terms when a rendering material is supplied. Cycles then samples its native volume
attribute instead of executing image-tile math for every volume event. This is
an additional bounded spatial resampling, not a change in weather provenance.
"""
from __future__ import annotations
import math
import numpy as np

MAX_GRID_VOXELS = 8_000_000
GRID_STORAGE_SCALE = 1_000_000.
NATIVE_CLIPPING_DEFAULT = .001
_NODE_TYPES = {
    'ShaderNodeMath':'ShaderNodeMath',
    'ShaderNodeSeparateXYZ':'ShaderNodeSeparateXYZ',
    'ShaderNodeCombineXYZ':'ShaderNodeCombineXYZ',
    'ShaderNodeMapRange':'ShaderNodeMapRange',
    'ShaderNodeTexNoise':'ShaderNodeTexNoise',
    'ShaderNodeMixRGB':'ShaderNodeMixRGB',
    'ShaderNodeValue':'ShaderNodeValue',
    'ShaderNodeRGB':'ShaderNodeRGB',
    'ShaderNodeTexImage':'GeometryNodeImageTexture',
    'ShaderNodeNewGeometry':'GeometryNodeInputPosition',
}
_PROPERTIES = {
    'ShaderNodeMath':('operation','use_clamp'),
    'ShaderNodeMapRange':('data_type','interpolation_type','clamp'),
    'ShaderNodeTexNoise':('noise_dimensions','noise_type','normalize'),
    'ShaderNodeMixRGB':('blend_type','use_alpha','use_clamp'),
    'ShaderNodeTexImage':('interpolation','extension'),
}


def grid_geometry(bounds, resolution):
    """Validate the bounded grid and return inclusive-node spacing in metres."""
    bounds = np.asarray(bounds, float)
    if bounds.shape != (2,3) or not np.isfinite(bounds).all() or np.any(bounds[1] <= bounds[0]):
        raise ValueError('Cloud grid bounds must be finite increasing XYZ corners')
    resolution = tuple(resolution)
    if len(resolution) != 3 or any(type(n) is not int or not 2 <= n <= 256 for n in resolution) or math.prod(resolution) > MAX_GRID_VOXELS:
        raise ValueError('Cloud grid needs 2..256 nodes per axis and at most 8000000 voxels')
    return bounds, resolution, (bounds[1]-bounds[0])/(np.asarray(resolution)-1)


def _matching_socket(sockets, old):
    return next((s for s in sockets if s.identifier == old.identifier), None)


def _clone_density_field(group, source_socket):
    """Translate the deliberately small supported shader graph into GN fields."""
    copied = {}
    visiting = set()
    nodes, links = group.nodes, group.links

    def clone_output(socket):
        old = socket.node
        kind = old.bl_idname
        if kind not in _NODE_TYPES:
            raise ValueError(f'Native cloud grid does not support density node {kind}')
        if old.mute:
            raise ValueError('Native cloud grid does not accept muted density nodes')
        if kind == 'ShaderNodeNewGeometry' and socket.name != 'Position':
            raise ValueError('Native cloud grid supports Geometry Position only')
        key = old.as_pointer()
        if key in visiting:
            raise ValueError('Native cloud grid density graph contains a cycle')
        if key not in copied:
            visiting.add(key)
            try:
                new = nodes.new(_NODE_TYPES[kind])
            except RuntimeError as error:
                raise RuntimeError('This Blender version lacks required Geometry Nodes volume/field support') from error
            copied[key] = new
            new.label = old.label or old.name
            for prop in _PROPERTIES.get(kind, ()):
                if hasattr(old,prop) and hasattr(new,prop):
                    setattr(new,prop,getattr(old,prop))
            if kind == 'ShaderNodeTexImage':
                if old.projection != 'FLAT' or old.image is None:
                    raise ValueError('Native cloud grid requires flat, loaded atlas images')
                new.inputs['Image'].default_value = old.image
            for old_input in old.inputs:
                destination = _matching_socket(new.inputs,old_input)
                if destination is None:
                    # Geometry Position has no inputs. Every linked data input
                    # of the other supported nodes must survive translation.
                    if old_input.is_linked:
                        raise ValueError(f'Cloud grid cannot translate input {kind}.{old_input.identifier}')
                    continue
                if old_input.is_linked:
                    if len(old_input.links) != 1:
                        raise ValueError('Cloud grid density inputs need one source link')
                    links.new(clone_output(old_input.links[0].from_socket),destination)
                elif hasattr(old_input,'default_value') and hasattr(destination,'default_value'):
                    destination.default_value = old_input.default_value
            # Value and RGB constants live on their output sockets.
            if kind in ('ShaderNodeValue','ShaderNodeRGB'):
                for old_output in old.outputs:
                    destination = _matching_socket(new.outputs,old_output)
                    destination.default_value = old_output.default_value
            visiting.remove(key)
        new = copied[key]
        output = new.outputs['Position'] if kind == 'ShaderNodeNewGeometry' else _matching_socket(new.outputs,socket)
        if output is None:
            raise ValueError(f'Cloud grid cannot translate output {kind}.{socket.identifier}')
        return output

    result = clone_output(source_socket)
    return result, len(copied)


def native_cloud_volume(ob, sigma_socket, bounds, resolution, *, render_material=None):
    """Replace a procedural cloud enclosure with a native density-grid modifier.

    `sigma_socket` is the base extinction field before LOD ramps and erosion.
    When render_material is supplied, its links from this base socket are
    replaced with native density after cloning the base into Geometry Nodes;
    downstream analytic masks and noise remain in that shader. Bounds and grid
    position are physical world metres. The
    object transform is reset to identity because the grid already uses those
    world coordinates. Call once after building the procedural density graph.
    """
    import bpy
    from mathutils import Matrix
    bounds, resolution, spacing = grid_geometry(bounds,resolution)
    if ob.modifiers:
        raise ValueError('Native cloud grid requires an object without modifiers')
    if ob.parent is not None:
        raise ValueError('Native cloud grid requires an unparented scene object')
    if sigma_socket.node.id_data.bl_idname != 'ShaderNodeTree':
        raise ValueError('Native cloud grid requires a material shader output socket')
    outgoing=list(sigma_socket.links)
    if render_material is not None:
        if render_material.node_tree != sigma_socket.node.id_data or not outgoing:
            raise ValueError('Native cloud rendering material must consume the base density socket')
    group = bpy.data.node_groups.new(f'{ob.name} density grid','GeometryNodeTree')
    try:
        group.interface.new_socket(name='Geometry',in_out='OUTPUT',socket_type='NodeSocketGeometry')
        density, node_count = _clone_density_field(group,sigma_socket)
        cube = group.nodes.new('GeometryNodeVolumeCube')
        cube.inputs['Background'].default_value = 0.
        cube.inputs['Min'].default_value = tuple(bounds[0])
        cube.inputs['Max'].default_value = tuple(bounds[1])
        for axis,n in zip('XYZ',resolution):cube.inputs[f'Resolution {axis}'].default_value=n
        # Native volumes default to a smoke-scale 0.001 clipping threshold.
        # Physical cloud extinction is commonly smaller than that, so store
        # scaled values and undo the scale in the scattering material. This
        # keeps the default threshold below 1e-9 per physical metre.
        encode=group.nodes.new('ShaderNodeMath');encode.operation='MULTIPLY'
        encode.inputs[1].default_value=GRID_STORAGE_SCALE
        group.links.new(density,encode.inputs[0])
        group.links.new(encode.outputs[0],cube.inputs['Density'])
        material=render_material or bpy.data.materials.new(f'{ob.name} native cloud scattering')
        material.use_nodes=True
        nodes,links=material.node_tree.nodes,material.node_tree.links
        if render_material is None:nodes.clear()
        attribute=nodes.new('ShaderNodeAttribute');attribute.attribute_name='density'
        decode=nodes.new('ShaderNodeMath');decode.operation='DIVIDE'
        decode.inputs[1].default_value=GRID_STORAGE_SCALE
        links.new(attribute.outputs['Fac'],decode.inputs[0])
        if render_material is not None:
            # The native field is already cloned above. Sever every outgoing
            # base link so runtime shading cannot reach the atlas image graph.
            for connection in outgoing:
                destination=connection.to_socket
                links.remove(connection)
                links.new(decode.outputs[0],destination)
        else:
            scatter=nodes.new('ShaderNodeVolumeScatter')
            scatter.inputs['Color'].default_value=(.995,.995,.995,1.)
            scatter.inputs['Anisotropy'].default_value=.55
            links.new(decode.outputs[0],scatter.inputs['Density'])
            output=nodes.new('ShaderNodeOutputMaterial')
            links.new(scatter.outputs[0],output.inputs['Volume'])
        set_material=group.nodes.new('GeometryNodeSetMaterial')
        set_material.inputs['Material'].default_value=material
        group.links.new(cube.outputs['Volume'],set_material.inputs['Geometry'])
        result=group.nodes.new('NodeGroupOutput')
        group.links.new(set_material.outputs['Geometry'],result.inputs['Geometry'])
    except Exception:
        bpy.data.node_groups.remove(group)
        raise
    ob.matrix_world=Matrix.Identity(4)
    modifier=ob.modifiers.new(name='Prepared native cloud grid',type='NODES')
    modifier.node_group=group
    ob.data.materials.clear()
    ob.data.materials.append(material)
    return {'representation':'native-volume-grid','grid_attribute':'density',
            'bounds_enu_m':bounds.tolist(),'resolution_xyz':list(resolution),
            'spacing_xyz_m':spacing.tolist(),'density_units':'inverse physical metre after shader decoding',
            'grid_storage_scale':GRID_STORAGE_SCALE,'grid_attribute_units':'inverse physical metre multiplied by storage scale',
            'native_default_clipping':NATIVE_CLIPPING_DEFAULT,
            'effective_physical_clipping_per_m':NATIVE_CLIPPING_DEFAULT/GRID_STORAGE_SCALE,
            'source_density_nodes':node_count,'object_transform':'identity',
            'post_density_shader':render_material is not None,
            'sampling':'inclusive node positions; zero background; additional trilinear grid resampling',
            'limits':['Native grid adds spatial discretization to the curved source atlas; its resolutions still differ between near and far.',
                      'When supplied, paired blend masks and sub-grid erosion remain analytic shader terms after native density sampling.',
                      'Native default clipping corresponds to about 1e-9 per metre after storage scaling; grid precision can also quantize density.']}

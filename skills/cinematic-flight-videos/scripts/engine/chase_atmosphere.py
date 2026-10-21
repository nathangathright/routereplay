"""Physical-scale spherical air shared by chase camera, lighting and clouds.

The pure functions are numerical references for the Blender node construction.
Unlike a sky background plus fog, this medium scatters the Sun once along every
path. Scene radiance is relative, not calibrated photometry. No downloads.
"""
import numpy as np

EARTH_M = 6_371_000.
TOP_M = 100_000.
RAYLEIGH = np.array([5.8e-6, 13.5e-6, 33.1e-6])
MIE_SCATTER = 3.e-6
MIE_ALBEDO = .9
RAYLEIGH_HEIGHT_M = 8000.
MIE_HEIGHT_M = 1200.


def radial_height(points):
    points = np.asarray(points, dtype=float)
    # Rationalized radius subtraction retains precision close to the surface.
    x, y, z = np.moveaxis(points, -1, 0)
    q = x*x + y*y + z*(2*EARTH_M+z)
    return q / (np.sqrt(q+EARTH_M**2)+EARTH_M)


def extinction(height_m):
    h = np.asarray(height_m, dtype=float)
    valid = (h >= 0) & (h <= TOP_M)
    h = np.maximum(h, 0)
    return valid[..., None] * (np.exp(-h[..., None]/RAYLEIGH_HEIGHT_M)*RAYLEIGH +
                              np.exp(-h[..., None]/MIE_HEIGHT_M)*MIE_SCATTER/MIE_ALBEDO)


def transmittance(start, end, samples=512):
    start, end = np.asarray(start, float), np.asarray(end, float)
    fractions = (np.arange(samples)+.5)/samples
    points = start + fractions[:, None]*(end-start)
    tau = extinction(radial_height(points)).mean(axis=0)*np.linalg.norm(end-start)
    return np.exp(-tau)


def build(scene):
    """Return diagnostics; Cycles handles view/solar extinction and Earth shadow."""
    import bpy
    if bpy.app.version < (5, 0, 0):
        raise ValueError("Shared spherical air requires Blender 5.0+ null-scattering integration; use --atmosphere sky on older versions")
    # The boundary is in negligible-density air. Mesh faceting there has no
    # visible horizon role; ground geometry, not this enclosure, defines Earth.
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32,
                                       radius=EARTH_M+TOP_M, location=(0, 0, -EARTH_M))
    atmosphere = bpy.context.object
    atmosphere.name = 'Shared spherical Rayleigh and aerosol atmosphere'
    material = bpy.data.materials.new('Physical air per metre')
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()

    def calc(operation, a, b=None):
        node = nodes.new('ShaderNodeMath')
        node.operation = operation
        for i, value in enumerate((a, b)):
            if value is None:
                continue
            if isinstance(value, (float, int)):
                node.inputs[i].default_value = value
            else:
                links.new(value, node.inputs[i])
        return node.outputs[0]

    coord = nodes.new('ShaderNodeNewGeometry')
    xyz = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coord.outputs['Position'], xyz.inputs[0])
    x, y, z = (xyz.outputs[axis] for axis in 'XYZ')
    q = calc('ADD', calc('ADD', calc('MULTIPLY', x, x), calc('MULTIPLY', y, y)),
             calc('MULTIPLY', z, calc('ADD', 2*EARTH_M, z)))
    height = calc('DIVIDE', q, calc('ADD', calc('SQRT', calc('ADD', q, EARTH_M**2)), EARTH_M))
    valid = calc('MULTIPLY', calc('GREATER_THAN', height, 0.), calc('LESS_THAN', height, TOP_M))
    height = calc('MAXIMUM', height, 0.)
    ray_density = calc('MULTIPLY', valid, calc('EXPONENT', calc('DIVIDE', height, -RAYLEIGH_HEIGHT_M)))
    aerosol = calc('MULTIPLY', valid, calc('EXPONENT', calc('DIVIDE', height, -MIE_HEIGHT_M)))
    rayleigh = nodes.new('ShaderNodeVolumeScatter')
    if hasattr(rayleigh, 'phase'):
        rayleigh.phase = 'RAYLEIGH'
    rayleigh.inputs['Color'].default_value = (*map(float, RAYLEIGH/RAYLEIGH.max()), 1.)
    links.new(calc('MULTIPLY', ray_density, float(RAYLEIGH.max())), rayleigh.inputs['Density'])
    mie = nodes.new('ShaderNodeVolumeScatter')
    mie.inputs['Color'].default_value = (1, 1, 1, 1)
    mie.inputs['Anisotropy'].default_value = .76
    links.new(calc('MULTIPLY', aerosol, MIE_SCATTER), mie.inputs['Density'])
    absorption = nodes.new('ShaderNodeVolumeAbsorption')
    # In Cycles the absorption coefficient is (1 - Color) * Density.
    absorption.inputs['Color'].default_value = (0, 0, 0, 1)
    links.new(calc('MULTIPLY', aerosol, MIE_SCATTER*(1/MIE_ALBEDO-1)), absorption.inputs['Density'])
    combined = nodes.new('ShaderNodeAddShader')
    links.new(rayleigh.outputs[0], combined.inputs[0])
    links.new(mie.outputs[0], combined.inputs[1])
    total = nodes.new('ShaderNodeAddShader')
    links.new(combined.outputs[0], total.inputs[0])
    links.new(absorption.outputs[0], total.inputs[1])
    output = nodes.new('ShaderNodeOutputMaterial')
    links.new(total.outputs[0], output.inputs['Volume'])
    atmosphere.data.materials.append(material)

    # The curved geographic patch supplies visible terrain. A buried sphere
    # closes the rest of Earth for long sunlight paths and night-side views.
    bpy.ops.mesh.primitive_uv_sphere_add(segments=256, ring_count=128,
                                       radius=EARTH_M-2000, location=(0, 0, -EARTH_M))
    planet = bpy.context.object
    planet.name = 'Buried planet for distant occlusion'
    ground = bpy.data.materials.new('Distant planet neutral albedo')
    ground.use_nodes = True
    ground.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (.025, .035, .045, 1)
    ground.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = 1
    planet.data.materials.append(ground)

    # All sky radiance now comes from the same air volume. No second sky model,
    # pre-attenuated lamp or camera-facing fog is added to the transport.
    scene.world.use_nodes = True
    scene.world.node_tree.nodes.clear()
    background = scene.world.node_tree.nodes.new('ShaderNodeBackground')
    background.inputs['Strength'].default_value = 0.
    output = scene.world.node_tree.nodes.new('ShaderNodeOutputWorld')
    scene.world.node_tree.links.new(background.outputs[0], output.inputs['Surface'])
    return {'model': 'shared-spherical-volume', 'volume_integration': 'Cycles null scattering (Blender 5.0+)', 'earth_radius_m': EARTH_M,
            'top_m': TOP_M, 'rayleigh_phase': getattr(rayleigh, 'phase', 'isotropic fallback'),
            'mie_anisotropy': .76, 'mie_single_scattering_albedo': MIE_ALBEDO,
            'rayleigh_per_m': RAYLEIGH.tolist(), 'mie_scatter_per_m': MIE_SCATTER,
            'limits': ['RGB scattering, exponential molecular/aerosol profiles; no ozone absorption.',
                       'Finite Cycles scattering bounce budget; relative radiance and artistic exposure.',
                       'Buried coarse planet supplies distant solar occlusion outside the terrain patch.']}

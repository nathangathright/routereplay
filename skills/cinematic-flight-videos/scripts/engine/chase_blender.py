"""Experimental full-scene chase render. Invoked by chase_preview.py in Blender.

Every object and volume uses one metre-scale ENU world and one perspective
camera. This deliberately does not reuse the overhead sprite/depth compositor.
"""
from pathlib import Path
import argparse
import json
import math
import os
import sys
import time
import numpy as np
import bpy
from mathutils import Matrix, Vector

sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parents[1])]
from chase_weather import tiled_rgba


def mesh(name, vertices, faces):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    ob = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(ob)
    return ob


def math_node(nodes, links, operation, a, b=None):
    node = nodes.new('ShaderNodeMath')
    node.operation = operation
    for index, value in enumerate((a, b)):
        if value is None:
            continue
        if isinstance(value, (float, int)):
            node.inputs[index].default_value = value
        else:
            links.new(value, node.inputs[index])
    return node.outputs[0]


def cloud_volume(job, work, record=None, layer='local'):
    """Trilinearly sample a guttered, float, linear extinction atlas in Cycles."""
    record = job['cloud_atlas'] if record is None else record
    if not record:
        return None
    bounds = np.asarray(record['bounds_enu_m'], float)
    bpy.ops.mesh.primitive_cube_add(size=1, location=tuple(bounds.mean(axis=0)))
    ob = bpy.context.object
    ob.name = 'Dated reconstructed weather volume'
    ob.scale = tuple(bounds[1] - bounds[0])
    material = bpy.data.materials.new('Shared weather extinction for every ray')
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()
    output = nodes.new('ShaderNodeOutputMaterial')
    coord = nodes.new('ShaderNodeTexCoord')
    separate = nodes.new('ShaderNodeSeparateXYZ')
    curved = record.get('coordinate_system') == 'enu_xy_radial_height'
    if curved:
        from chase_cloudscape import validate_layer_blend
        blend=validate_layer_blend(record.get('layer_blend_m'))
    mask = 1.
    world_xyz = None
    if curved:
        geometry = nodes.new('ShaderNodeNewGeometry')
        world_xyz = nodes.new('ShaderNodeSeparateXYZ')
        links.new(geometry.outputs['Position'], world_xyz.inputs[0])
        x, y, z = (world_xyz.outputs[axis] for axis in 'XYZ')
        calc = lambda op, a, b=None: math_node(nodes, links, op, a, b)
        # Stable spherical radial height: avoids subtracting two ~6.4m values.
        q = calc('ADD', calc('ADD', calc('MULTIPLY', x, x), calc('MULTIPLY', y, y)),
                 calc('MULTIPLY', z, calc('ADD', 12_742_000., z)))
        h = calc('DIVIDE', q, calc('ADD', calc('SQRT', calc('ADD', q, 6_371_000.**2)), 6_371_000.))
        atlas_xyz = nodes.new('ShaderNodeCombineXYZ')
        for axis, value, bound in zip('XYZ', (x, y, h), record['bounds_xyh_m']):
            normalized = calc('DIVIDE', calc('SUBTRACT', value, bound[0]), bound[1]-bound[0])
            links.new(normalized, atlas_xyz.inputs[axis])
            mask = calc('MULTIPLY', mask, calc('MULTIPLY', calc('GREATER_THAN', normalized, 0.),
                                             calc('LESS_THAN', normalized, 1.)))
        links.new(atlas_xyz.outputs[0], separate.inputs[0])
    else:
        links.new(coord.outputs['Generated'], separate.inputs[0])
    with np.load(work / record['npz_path']) as data:
        atlas = data['density']
    nz, ny, nx = atlas.shape
    pixels, layout = tiled_rgba(atlas)
    columns, rows = layout['tiles_x'], layout['tiles_y']
    sx, sy = layout['slice_stride_xy']
    image = bpy.data.images.new('Local physical extinction atlas', width=columns*sx,
                               height=rows*sy, alpha=True, float_buffer=True)
    image.colorspace_settings.name = 'Non-Color'
    image.pixels.foreach_set(pixels.ravel())
    image.update()
    image.pack()
    z_normalized = math_node(nodes, links, 'MINIMUM', 1., math_node(nodes, links, 'MAXIMUM', 0., separate.outputs['Z']))
    z = math_node(nodes, links, 'MULTIPLY', z_normalized, nz - 1)
    lower = math_node(nodes, links, 'FLOOR', z)
    upper = math_node(nodes, links, 'MINIMUM', math_node(nodes, links, 'ADD', lower, 1), nz-1)
    fraction = math_node(nodes, links, 'SUBTRACT', z, lower)

    def lookup(index):
        col = math_node(nodes, links, 'MODULO', index, columns)
        row = math_node(nodes, links, 'FLOOR', math_node(nodes, links, 'DIVIDE', index, columns))
        xy = nodes.new('ShaderNodeCombineXYZ')
        for axis, cell, stride, count, size in (('X', col, sx, nx, columns*sx),
                                               ('Y', row, sy, ny, rows*sy)):
            pixel = math_node(nodes, links, 'ADD', math_node(nodes, links, 'MULTIPLY', cell, stride),
                              math_node(nodes, links, 'ADD', 1.5,
                                        math_node(nodes, links, 'MULTIPLY', separate.outputs[axis], count-1)))
            links.new(math_node(nodes, links, 'DIVIDE', pixel, size), xy.inputs[axis])
        texture = nodes.new('ShaderNodeTexImage')
        texture.image = image
        texture.interpolation = 'Linear'
        texture.extension = 'EXTEND'
        links.new(xy.outputs[0], texture.inputs['Vector'])
        return texture.outputs['Color']

    mix = nodes.new('ShaderNodeMixRGB')
    links.new(fraction, mix.inputs[0])
    links.new(lookup(lower), mix.inputs[1])
    links.new(lookup(upper), mix.inputs[2])
    def smooth_ramp(value, low, high):
        ramp = nodes.new('ShaderNodeMapRange')
        ramp.clamp = True
        ramp.interpolation_type = 'SMOOTHERSTEP'
        links.new(value, ramp.inputs['Value'])
        ramp.inputs['From Min'].default_value = low
        ramp.inputs['From Max'].default_value = high
        return ramp.outputs['Result']
    # Complementary overlap owns the density once. Far volume starts where
    # near fades; its outer limit lies beyond this shot's geometric horizon.
    fade = mask
    base_sigma = math_node(nodes, links, 'MULTIPLY', mix.outputs[0], mask) if curved else mix.outputs[0]
    if curved:
        radius = calc('MAXIMUM', calc('ABSOLUTE', world_xyz.outputs['X']), calc('ABSOLUTE', world_xyz.outputs['Y']))
        transition = smooth_ramp(radius, blend['near_fade_start_m'], blend['near_extent_m'])
        weight = (calc('MULTIPLY', transition, calc('SUBTRACT', 1., smooth_ramp(radius, blend['far_fade_start_m'], blend['far_extent_m'])))
                  if layer == 'far' else calc('SUBTRACT', 1., transition))
        fade = calc('MULTIPLY', mask, weight)
    else:
        for axis in ('X', 'Y'):
            edge = math_node(nodes, links, 'MINIMUM', separate.outputs[axis],
                             math_node(nodes, links, 'SUBTRACT', 1., separate.outputs[axis]))
            fade = math_node(nodes, links, 'MULTIPLY', fade, smooth_ramp(edge, 0., .12))
    sigma = math_node(nodes, links, 'MULTIPLY', base_sigma, fade)
    # The globe field has 24 km billows. A close camera needs explicitly
    # modeled sub-grid erosion, fixed in physical world space for every ray.
    # Multiplication never creates cloud where the dated macro field is empty.
    detail = job.get('cloud_detail', 0.) if layer != 'far' else 0.
    if detail:
        geometry = nodes.new('ShaderNodeNewGeometry')
        noise = nodes.new('ShaderNodeTexNoise')
        links.new(geometry.outputs['Position'], noise.inputs['Vector'])
        noise.inputs['Scale'].default_value = 1/750
        noise.inputs['Detail'].default_value = 2.
        noise.inputs['Roughness'].default_value = .65
        ramp = nodes.new('ShaderNodeMapRange')
        ramp.clamp = True
        ramp.interpolation_type = 'SMOOTHERSTEP'
        links.new(noise.outputs['Fac'], ramp.inputs['Value'])
        ramp.inputs['From Min'].default_value = .32
        ramp.inputs['From Max'].default_value = .68
        ramp.inputs['To Min'].default_value = 1 - .95*detail
        ramp.inputs['To Max'].default_value = 1 + .95*detail
        sigma = math_node(nodes, links, 'MULTIPLY', sigma, ramp.outputs['Result'])
    scatter = nodes.new('ShaderNodeVolumeScatter')
    scatter.inputs['Color'].default_value = (.995, .995, .995, 1)
    scatter.inputs['Anisotropy'].default_value = .55
    links.new(sigma, scatter.inputs['Density'])
    links.new(scatter.outputs[0], output.inputs['Volume'])
    ob.data.materials.append(material)
    if curved:
        from chase_cloud_grid import native_cloud_volume
        return native_cloud_volume(ob, base_sigma, bounds,
                                   (160,160,192) if layer == 'far' else (160,160,64),
                                   render_material=material)
    return {'representation': 'procedural-local-atlas'}


def ground(job, work):
    with np.load(work / 'terrain.npz') as data:
        ob = mesh('Curved geographic terrain', data['vertices'].tolist(), data['faces'].tolist())
        uv = ob.data.uv_layers.new(name='Geographic surface UV')
        coordinates = data['uv']
        for polygon in ob.data.polygons:
            polygon.use_smooth = True
            for loop_index in polygon.loop_indices:
                uv.data[loop_index].uv = coordinates[ob.data.loops[loop_index].vertex_index]
    material = bpy.data.materials.new('Historical seasonal surface')
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    texture = nodes.new('ShaderNodeTexImage')
    texture.image = bpy.data.images.load(job['surface_path'], check_existing=True)
    links.new(texture.outputs['Color'], nodes.get('Principled BSDF').inputs['Base Color'])
    nodes.get('Principled BSDF').inputs['Roughness'].default_value = .85
    ob.data.materials.append(material)


def update_sky(texture, sun_direction, altitude_m):
    # Blender's Nishita UI rotation is clockwise from +Y; its compiler reverses
    # this before spherical sampling. The same ENU direction drives the Sun lamp.
    texture.sun_elevation = math.asin(float(np.clip(sun_direction[2], -1., 1.)))
    texture.sun_rotation = math.atan2(sun_direction[0], sun_direction[1])
    texture.altitude = altitude_m


def sky(scene, sun_direction, altitude_m):
    scene.world.use_nodes = True
    nodes, links = scene.world.node_tree.nodes, scene.world.node_tree.links
    nodes.clear()
    output = nodes.new('ShaderNodeOutputWorld')
    background = nodes.new('ShaderNodeBackground')
    texture = nodes.new('ShaderNodeTexSky')
    choices = {item.identifier for item in texture.bl_rna.properties['sky_type'].enum_items}
    texture.sky_type = 'SINGLE_SCATTERING' if 'SINGLE_SCATTERING' in choices else 'NISHITA'
    texture.sun_disc = False  # Direct sunlight comes from the one Sun lamp.
    texture.air_density = 1.
    if hasattr(texture, 'aerosol_density'):
        texture.aerosol_density = .3
    else:
        texture.dust_density = .3
    texture.ozone_density = 1.
    update_sky(texture, sun_direction, altitude_m)
    background.inputs['Strength'].default_value = .35
    links.new(texture.outputs['Color'], background.inputs['Color'])
    links.new(background.outputs[0], output.inputs['Surface'])
    return texture


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('job', type=Path)
    parser.add_argument('--frames', default='all')
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    work = args.job.resolve().parent
    job = json.loads(args.job.read_text())
    os.environ['FLIGHT_AIRCRAFT_DIR'] = str(work / 'aircraft')
    import aircraft_blender as aircraft
    aircraft.VARIANT = job['aircraft']
    aircraft.CINEMATIC = True
    scene, sun = aircraft.create_scene()
    scene.render.resolution_x, scene.render.resolution_y = job['size']
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.threads = job['threads']
    scene.cycles.samples = job['samples']
    scene.cycles.max_bounces = 8
    scene.cycles.volume_bounces = 6
    scene.cycles.volume_step_rate = .5
    scene.cycles.volume_max_steps = 512
    scene.view_settings.exposure = job.get('exposure_ev', 0.)
    from cycles_device import select_device
    device = select_device(bpy, job['device'])
    (work / 'device.json').write_text(json.dumps(device, indent=2)+'\n')
    metres_per_unit = aircraft.AIRFRAME_SPECS[job['aircraft']]['length_m'] / 12.01
    aircraft.aircraft.scale = (metres_per_unit,)*3
    # Scale lamp positions with the parent; photometric powers remain illustrative.
    ground(job, work)
    cloud_reports = [cloud_volume(job, work)]
    if job.get('far_cloud_atlas'):
        cloud_reports.append(cloud_volume(job, work, job['far_cloud_atlas'], layer='far'))
    shared_air = job.get('atmosphere', 'sky') == 'volume'
    atmosphere_report = None
    if shared_air:
        from chase_atmosphere import build
        atmosphere_report = build(scene)
        sky_texture = None
    else:
        sky_texture = sky(scene, job['frames'][0]['sun_enu'], job['frames'][0]['camera_position_m'][2])
    camera = scene.camera
    camera.name = 'Shared rear-quarter perspective camera'
    camera.data.sensor_fit = 'HORIZONTAL'
    camera.data.sensor_width = 36.
    camera.data.lens = 36 / (2*math.tan(math.radians(job['horizontal_fov_deg']/2)))
    camera.data.clip_start = .5
    camera.data.clip_end = 20_000_000 if shared_air else 1_000_000
    frames = range(len(job['frames'])) if args.frames == 'all' else [int(x) for x in args.frames.split(',')]
    if any(i < 0 or i >= len(job['frames']) for i in frames):
        raise ValueError('Frame index lies outside the prepared shot')
    output = work / 'frames'
    output.mkdir(exist_ok=True)
    started = time.monotonic()
    timings = []
    for index in frames:
        sample = job['frames'][index]
        aircraft.aircraft.location = sample['aircraft_position_m']
        aircraft.aircraft.rotation_mode = 'QUATERNION'
        aircraft.aircraft.rotation_quaternion = Matrix(sample['aircraft_rotation']).to_quaternion()
        camera.location = sample['camera_position_m']
        camera.rotation_mode = 'QUATERNION'
        camera.rotation_quaternion = Matrix(sample['camera_rotation']).to_quaternion()
        direction = Vector(sample['sun_enu'])
        sun.rotation_euler = (-direction).to_track_quat('-Z', 'Y').to_euler()
        sun.data.energy = math.pi if shared_air else math.pi * sample['sun_visibility']
        sun.data.color = (1., 1., 1.) if shared_air else sample['sun_rgb']
        if sky_texture is not None:
            update_sky(sky_texture, direction, sample['camera_position_m'][2])
        bpy.context.view_layer.update()
        scene.render.filepath = str(output/f'{index:06d}.png')
        tick = time.monotonic()
        bpy.ops.render.render(write_still=True)
        timings.append({'frame': index, 'seconds': time.monotonic()-tick})
        print('CHASE_FRAME='+json.dumps(timings[-1]), flush=True)
    (work/'render-report.json').write_text(json.dumps({'device': device, 'frames': timings,
        'seconds': time.monotonic()-started, 'shared_scene_camera': True,
        'blender_version': bpy.app.version_string,
        'sky_model': 'shared-spherical-volume' if shared_air else sky_texture.sky_type,
        'atmosphere': atmosphere_report,
        'cloud_volumes': cloud_reports,
        'size': job['size'], 'samples': job['samples']}, indent=2)+'\n')


if __name__ == '__main__':
    main()

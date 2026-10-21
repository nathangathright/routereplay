"""Local Cycles device selection; never saves Blender user preferences.

Run with Blender to probe a tiny actual render before assigning a cache key.
A later failure is fatal, avoiding a mixed CPU/GPU cache after partial output.
"""
from __future__ import annotations
import argparse
import json
import sys

MARKER = 'FLIGHT_CYCLES_DEVICE='


def select_device(bpy, requested):
    if requested not in ('cpu', 'metal', 'auto'):
        raise ValueError('Cycles device must be cpu, metal or auto.')
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    record = {'backend': 'cpu', 'devices': [{'name': 'CPU', 'type': 'CPU'}]}
    if requested == 'cpu':
        scene.cycles.device = 'CPU'
        return record
    try:
        preferences = bpy.context.preferences.addons['cycles'].preferences
        preferences.compute_device_type = 'METAL'
        if hasattr(preferences,'refresh_devices'):
            preferences.refresh_devices()
        else:
            preferences.get_devices()
        metal = [device for device in preferences.devices if device.type == 'METAL']
        if not metal:
            raise RuntimeError('Blender reported no Metal device.')
        for device in preferences.devices:
            device.use = device.type == 'METAL'
        scene.cycles.device = 'GPU'
        return {'backend': 'metal', 'devices': sorted(
            [{'name': device.name, 'type': device.type, 'id': device.id} for device in metal],
            key=lambda item: item['id'])}
    except Exception as exc:
        scene.cycles.device = 'CPU'
        if requested == 'metal':
            raise RuntimeError(f'Cycles Metal is unavailable: {exc}') from exc
        record['fallback_reason'] = str(exc)
        return record


def probe(bpy, requested):
    record = select_device(bpy, requested)
    if record['backend'] == 'metal':
        try:
            bpy.ops.object.select_all(action='SELECT')
            bpy.ops.object.delete(use_global=False)
            bpy.ops.mesh.primitive_cube_add()
            material=bpy.data.materials.new('Metal availability probe')
            material.use_nodes=True
            shader=material.node_tree.nodes.get('Principled BSDF')
            shader.inputs['Roughness'].default_value=.25
            for name,value in [('Coat Weight',.3),('Transmission Weight',.15)]:
                if shader.inputs.get(name):shader.inputs[name].default_value=value
            bpy.context.object.data.materials.append(material)
            bpy.ops.object.light_add(type='SUN',location=(2,1,3))
            bpy.context.object.data.energy=3.
            bpy.ops.object.camera_add(location=(0, 0, 5))
            scene = bpy.context.scene
            scene.camera = bpy.context.object
            scene.render.resolution_x = scene.render.resolution_y = 16
            scene.render.resolution_percentage = 100
            scene.cycles.samples = 1
            scene.cycles.use_denoising = True
            bpy.ops.render.render(write_still=False)
        except Exception as exc:
            if requested == 'metal':
                raise RuntimeError(f'Cycles Metal render probe failed: {exc}') from exc
            record = select_device(bpy, 'cpu')
            record['fallback_reason'] = f'Metal render probe failed: {exc}'
    return record


def main():
    import bpy
    parser = argparse.ArgumentParser()
    parser.add_argument('--device', choices=('cpu', 'metal', 'auto'), default='cpu')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    print(MARKER + json.dumps(probe(bpy, args.device), sort_keys=True), flush=True)


if __name__ == '__main__':
    main()

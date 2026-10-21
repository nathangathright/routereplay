"""Local accelerator selection, fallback and output identity contracts."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch, Mock

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/route-replay/scripts'
sys.path[:0]=[str(SCRIPTS),str(SCRIPTS/'engine')]
from acceleration import cycles_device, encoding_arguments, probe_encoder
from cycles_device import select_device, MARKER


def fake_blender(devices):
    prefs=NS(compute_device_type='NONE',devices=devices,refresh_devices=Mock())
    scene=NS(render=NS(engine=''),cycles=NS(device='CPU'))
    return NS(context=NS(scene=scene,preferences=NS(addons={'cycles':NS(preferences=prefs)})))


class AccelerationTests(unittest.TestCase):
    def test_optional_atmosphere_kernel_is_probed_only_when_selected(self):
        from acceleration import compute_device
        atmosphere=Mock(side_effect=RuntimeError('atmosphere kernel unavailable'))
        modules={'metal_compute':NS(device_info=lambda:{'backend':'metal'},optical_depth=Mock()),
                 'metal_clouds':NS(probe=Mock()),'metal_weather':NS(probe=Mock()),
                 'metal_atmosphere':NS(probe=atmosphere)}
        with patch.dict(sys.modules,modules):
            self.assertEqual(compute_device('cpu',atmosphere_view='batched')['backend'],'cpu')
            self.assertEqual(compute_device('metal')['backend'],'metal')
            atmosphere.assert_not_called()
            selected=compute_device('auto',atmosphere_view='batched')
            self.assertEqual(selected['backend'],'cpu')
            self.assertIn('atmosphere kernel unavailable',selected['fallback_reason'])
            with self.assertRaisesRegex(RuntimeError,'atmosphere kernel unavailable'):
                compute_device('metal',atmosphere_view='batched')
        with self.assertRaises(ValueError):compute_device('cpu',atmosphere_view='invalid')

    def test_metal_enables_only_gpu_and_scene_without_saving_preferences(self):
        cpu=NS(name='CPU',type='CPU',id='cpu',use=True)
        gpu=NS(name='GPU',type='METAL',id='gpu',use=False)
        bpy=fake_blender([cpu,gpu]);result=select_device(bpy,'metal')
        self.assertEqual(bpy.context.scene.cycles.device,'GPU')
        self.assertFalse(cpu.use);self.assertTrue(gpu.use)
        self.assertEqual(result['backend'],'metal')
        self.assertEqual(select_device(bpy,'cpu')['backend'],'cpu')
        self.assertEqual(bpy.context.scene.cycles.device,'CPU')

    def test_auto_falls_back_and_explicit_metal_fails(self):
        bpy=fake_blender([])
        self.assertIn('fallback_reason',select_device(bpy,'auto'))
        with self.assertRaisesRegex(RuntimeError,'unavailable'):select_device(bpy,'metal')
        with patch('acceleration.subprocess.run',side_effect=subprocess.TimeoutExpired('blender',180)):
            self.assertEqual(cycles_device('blender','auto')['backend'],'cpu')
            with self.assertRaisesRegex(RuntimeError,'probe failed'):cycles_device('blender','metal')

    def test_probe_reads_only_one_marker_and_returns_device_identity(self):
        record={'backend':'metal','devices':[{'name':'M1','type':'METAL','id':'stable-id'}]}
        with patch('acceleration.subprocess.run',return_value=NS(stdout='Blender log\n'+MARKER+json.dumps(record))) as run:
            self.assertEqual(cycles_device('blender','metal'),record)
            self.assertIn('--factory-startup',run.call_args.args[0])
            self.assertIn('--python-exit-code',run.call_args.args[0])
        with patch('acceleration.subprocess.run',return_value=NS(stdout='No result')):
            self.assertEqual(cycles_device('blender','auto')['backend'],'cpu')

    def test_cpu_does_not_start_a_probe_and_hardware_encoding_is_explicit(self):
        with patch('acceleration.subprocess.run',side_effect=AssertionError('probe started')):
            self.assertEqual(cycles_device('blender','cpu')['backend'],'cpu')
        arguments=encoding_arguments('videotoolbox')
        self.assertEqual(arguments[arguments.index('-allow_sw')+1],'0')
        self.assertEqual(encoding_arguments('x264'),['-c:v','libx264','-preset','medium','-crf','16'])
        with self.assertRaises(ValueError):encoding_arguments('unknown')
        with patch('acceleration.subprocess.run',side_effect=subprocess.CalledProcessError(1,'ffmpeg',stderr='no hardware')):
            with self.assertRaisesRegex(RuntimeError,'--encoder x264'):probe_encoder('ffmpeg','videotoolbox')

    def test_cache_separates_devices_but_not_fallback_diagnostics(self):
        from flight_video import cache_key
        from trip import load_trip
        trip=load_trip(SCRIPTS.parent/'examples/sample-single-leg.json')
        environment={'packages':{'Pillow':'test'},'compute_device':{'backend':'cpu','fallback_reason':'one'}}
        first=cache_key(trip,{},'diagram',environment)
        environment['compute_device']['fallback_reason']='two'
        self.assertEqual(first,cache_key(trip,{},'diagram',environment))
        environment['compute_device']={'backend':'metal','device_name':'M1','mlx_version':'0.32.2'}
        self.assertNotEqual(first,cache_key(trip,{},'diagram',environment))
        environment['blender_threads']=2
        two_threads=cache_key(trip,{},'diagram',environment)
        environment['blender_threads']=10
        self.assertNotEqual(two_threads,cache_key(trip,{},'diagram',environment))

    def test_invalid_acceleration_limits_fail_before_data_access(self):
        from contextlib import redirect_stderr
        from flight_video import main
        import io
        for flag,values in [('--blender-threads',['0','1025','-1']),
                            ('--blender-probe-timeout',['nan','0','inf','-1','86401'])]:
            for value in values:
                with self.subTest(flag=flag,value=value),patch('data.validate_bundle',side_effect=AssertionError('data accessed')), \
                     redirect_stderr(io.StringIO()),self.assertRaises(SystemExit) as result:
                    main(['preview',str(SCRIPTS.parent/'examples/sample-single-leg.json'),
                          '--assets','unused',flag,value])
                self.assertEqual(result.exception.code,2)

    def test_aircraft_child_checks_selected_device_and_threads(self):
        from flight_video import prepare_aircraft
        from trip import load_trip
        trip=load_trip(SCRIPTS.parent/'examples/sample-single-leg.json')
        record={'backend':'metal','devices':[{'name':'GPU','type':'METAL','id':'gpu'}]}
        with tempfile.TemporaryDirectory() as temporary,patch('flight_video.lighting_samples',return_value=[]), \
             patch('flight_video.valid_aircraft',side_effect=[False,True]), \
             patch('flight_video.subprocess.run',return_value=NS(returncode=0)) as run:
            prepare_aircraft(trip,Path(temporary),[0],'blender',device=record,threads=5)
            command=run.call_args.args[0]
            self.assertEqual(command[command.index('--flight-cycles-device')+1],'metal')
            self.assertEqual(command[command.index('--threads')+1],'5')
            self.assertEqual(json.loads(Path(command[command.index('--device-record')+1]).read_text()),record)
            self.assertNotIn('--cycles-device',command) # Reserved by Blender before script parsing.


if __name__=='__main__':unittest.main()

"""Compositor regression checks without a private asset bundle or Blender.

Load the actual orchestration functions with fake rendering backends so cache
selection and single-instant behavior are exercised without expensive pixel work.
"""
import ast
from datetime import datetime, timezone
from functools import lru_cache
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np

SCRIPTS=Path(__file__).resolve().parents[1]/'skills'/'cinematic-flight-videos'/'scripts'
sys.path[:0]=[str(SCRIPTS),str(SCRIPTS/'engine')]
from radiometry import TransportLayer, source_over
from camera_geometry import distance,focal_length
from motion import Motion
from trip import load_trip,trip_from_dict


def compositor_function(name,globals):
    path=SCRIPTS/'engine'/'render.py'
    if name == 'frame':
        compositor_function('_composite_scene', globals)
        overlay_path=SCRIPTS/'engine'/'scene_overlays.py'
        node=next(node for node in ast.parse(overlay_path.read_text()).body
                  if isinstance(node,ast.FunctionDef) and node.name=='composite')
        exec(compile(ast.Module(body=[node],type_ignores=[]),str(overlay_path),'exec'),globals)
        globals['composite_overlays']=globals['composite']
        globals['cached_scene']=lambda t,compute:compute()
    node=next(node for node in ast.parse(path.read_text()).body if isinstance(node,ast.FunctionDef) and node.name==name)
    module=ast.Module(body=[node],type_ignores=[])
    exec(compile(module,str(path),'exec'),globals)
    return globals[name]


def generated_render_assets(root):
    from PIL import Image
    from scipy.io import netcdf_file
    Image.new('RGB',(8,4),(0,255,0)).save(root/'land.png')
    Image.new('RGB',(8,4),(50,80,100)).save(root/'surface.png')
    with netcdf_file(root/'terrain.nc','w') as nc:
        nc.createDimension('latitude',4);nc.createDimension('longitude',8)
        nc.createVariable('latitude','f8',('latitude',))[:]=np.linspace(-90,90,4)
        nc.createVariable('longitude','f8',('longitude',))[:]=np.arange(-180,180,45)
        nc.createVariable('z','f4',('latitude','longitude'))[:]=np.zeros((4,8))
    bundle={'assets':{name:{'path':path} for name,path in
                      [('land_mask','land.png'),('surface','surface.png'),('terrain','terrain.nc')]}}
    (root/'bundle.json').write_text(json.dumps(bundle))
    return bundle


class PipelineTests(unittest.TestCase):
    def test_volume_reconstruction_uses_effective_mode_for_both_caches(self):
        from flight_video import configure
        trip=load_trip(SCRIPTS.parent/'examples/sample-single-leg.json')
        for backend in ('cpu','metal'):
            for transport in ('layered','joint'):
                with self.subTest(backend=backend,transport=transport), \
                     tempfile.TemporaryDirectory() as temp,patch.dict(os.environ), \
                     patch('acceleration.compute_device',return_value={'backend':backend}):
                    args=SimpleNamespace(workdir=temp,assets=temp,aircraft='diagram',compute=backend,
                                         quality='preview',transport=transport)
                    keys=[];scene_keys=[]
                    for mode in ('reference','adaptive','full'):
                        args.volume_reconstruction=mode
                        effective=mode if transport=='layered' else 'reference'
                        with configure(args,trip,{'assets':{}}) as (work,_):
                            record=json.loads((work/'provenance.json').read_text())
                            self.assertEqual(record['environment']['volume_reconstruction'],effective)
                            self.assertEqual(record['requested_render_options']['volume_reconstruction'],mode)
                            self.assertEqual(os.environ['FLIGHT_VOLUME_RECONSTRUCTION'],effective)
                            self.assertEqual('volume_reconstruction' in record.get('render_option_fallbacks',{}),
                                             transport=='joint' and mode!='reference')
                            keys.append(work);scene_keys.append(record['scene_cache']['key'])
                    self.assertEqual(len(set(keys)),3 if transport=='layered' else 1)
                    self.assertEqual(len(set(scene_keys)),3 if transport=='layered' else 1)
                    del args.volume_reconstruction
                    os.environ['FLIGHT_VOLUME_RECONSTRUCTION']='full'
                    with configure(args,trip,{'assets':{}}):
                        self.assertEqual(os.environ['FLIGHT_VOLUME_RECONSTRUCTION'],'reference')
                    args.volume_reconstruction='temporal'
                    with self.assertRaisesRegex(ValueError,'Volume reconstruction'):
                        with configure(args,trip,{'assets':{}}):
                            pass

    def test_air_and_cloud_source_selectors_use_effective_modes_and_reset_ambient_flags(self):
        from flight_video import configure
        original=load_trip(SCRIPTS.parent/'examples/sample-single-leg.json')
        for backend,transport,gain,weather,expected in [
            ('cpu','layered',1.,'forecast',('reference','reference')),
            ('metal','joint',1.,'forecast',('reference','reference')),
            ('metal','layered',.5,'forecast',('batched','reference')),
            ('metal','layered',1.,'clear',('batched','reference')),
            ('metal','layered',1.,'forecast',('batched','batched')),
        ]:
            with self.subTest(backend=backend,transport=transport,gain=gain,weather=weather), \
                 tempfile.TemporaryDirectory() as temp,patch.dict(os.environ), \
                 patch('acceleration.compute_device',return_value={'backend':backend}) as probe:
                raw=original.to_dict();raw['style']['cloud_lighting']=gain;raw['weather']['mode']=weather
                trip=trip_from_dict(raw)
                args=SimpleNamespace(workdir=temp,assets=temp,aircraft='diagram',compute='auto',
                    quality='preview',transport=transport,atmosphere_view='batched',cloud_source='batched')
                with configure(args,trip,{'assets':{}}) as (work,_):
                    record=json.loads((work/'provenance.json').read_text())
                    for name,effective in zip(('atmosphere_view','cloud_source'),expected):
                        self.assertEqual(record['environment'][name],effective)
                        self.assertEqual(os.environ['FLIGHT_'+name.upper()],effective)
                        self.assertEqual(record['requested_render_options'][name],'batched')
                    scene=record['scene_cache']['key']
                self.assertEqual(probe.call_args.kwargs['atmosphere_view'],
                                 'reference' if transport=='joint' else 'batched')
                args.atmosphere_view,args.cloud_source=expected
                with configure(args,trip,{'assets':{}}) as (normalized,_):
                    self.assertEqual(work,normalized)
                    self.assertEqual(scene,json.loads((normalized/'provenance.json').read_text())['scene_cache']['key'])
                del args.atmosphere_view;del args.cloud_source
                with configure(args,trip,{'assets':{}}):
                    self.assertEqual(os.environ['FLIGHT_ATMOSPHERE_VIEW'],'reference')
                    self.assertEqual(os.environ['FLIGHT_CLOUD_SOURCE'],'reference')

    def test_cloud_view_provenance_and_caches_follow_effective_backend(self):
        from flight_video import configure
        original=load_trip(SCRIPTS.parent/'examples/sample-single-leg.json')
        for compute,backend,transport,gain,weather,effective in [
            ('cpu','cpu','layered',1.,'forecast','reference'),
            ('auto','cpu','layered',1.,'forecast','reference'),
            ('metal','metal','joint',1.,'forecast','reference'),
            ('metal','metal','layered',.5,'forecast','reference'),
            ('metal','metal','layered',1.,'clear','reference'),
            ('metal','metal','layered',1.,'forecast','batched'),
        ]:
            with self.subTest(compute=compute,transport=transport,gain=gain,weather=weather), \
                 tempfile.TemporaryDirectory() as temp,patch.dict(os.environ), \
                 patch('acceleration.compute_device',return_value={'backend':backend}):
                raw=original.to_dict();raw['style']['cloud_lighting']=gain
                raw['weather']['mode']=weather
                trip=trip_from_dict(raw)
                args=SimpleNamespace(workdir=temp,assets=temp,aircraft='diagram',quality='preview',
                                     compute=compute,transport=transport,cloud_view='batched')
                with configure(args,trip,{'assets':{}}) as (work,_):
                    provenance=json.loads((work/'provenance.json').read_text())
                    self.assertEqual(os.environ['FLIGHT_CLOUD_VIEW'],effective)
                    self.assertEqual(provenance['environment']['cloud_view'],effective)
                    self.assertEqual(provenance['requested_render_options']['cloud_view'],'batched')
                    scene_key=provenance['scene_cache']['key']
                self.assertEqual('render_option_fallbacks' in provenance,effective=='reference')
                args.cloud_view=effective
                with configure(args,trip,{'assets':{}}) as (normalized,_):
                    normalized_provenance=json.loads((normalized/'provenance.json').read_text())
                    self.assertEqual(work,normalized)
                    self.assertEqual(scene_key,normalized_provenance['scene_cache']['key'])

    def test_blender_budget_is_configurable_and_timeout_reports_diagnostics(self):
        from flight_video import prepare_aircraft
        trip=load_trip(SCRIPTS.parent/'examples'/'sample-single-leg.json')
        with tempfile.TemporaryDirectory() as temp, patch('flight_video.lighting_samples',return_value=[]), \
             patch('flight_video.subprocess.run',side_effect=subprocess.TimeoutExpired('blender',900)) as run:
            with self.assertRaisesRegex(RuntimeError,'diagnostics:'):
                prepare_aircraft(trip,Path(temp),[0,1],'blender',frame_timeout=450.)
            self.assertEqual(run.call_args.kwargs['timeout'],1200.)

    def test_invalid_blender_timeout_fails_before_data_work(self):
        from flight_video import main
        from contextlib import redirect_stderr
        import io
        for value in ['nan','inf','0','-1','86401']:
            with self.subTest(value=value),patch('data.validate_bundle',side_effect=AssertionError('data accessed')), \
                 redirect_stderr(io.StringIO()),self.assertRaises(SystemExit) as result:
                main(['preview',str(SCRIPTS.parent/'examples/sample-single-leg.json'),
                      '--assets','unused','--blender-frame-timeout',value])
            self.assertEqual(result.exception.code,2)

    def test_complete_aircraft_cache_skips_lunar_prepass_and_blender(self):
        from flight_video import prepare_aircraft
        trip=load_trip(SCRIPTS.parent/'examples/sample-single-leg.json')
        with tempfile.TemporaryDirectory() as temp,\
             patch('flight_video.valid_aircraft',return_value=True),\
             patch('flight_video.lighting_samples',side_effect=AssertionError('Cached frames queried weather')) as lighting,\
             patch('flight_video.subprocess.run',side_effect=AssertionError('Cached frames started Blender')) as run:
            prepare_aircraft(trip,Path(temp),[0,1],'blender')
        lighting.assert_not_called();run.assert_not_called()

    def test_partial_aircraft_cache_prepares_only_missing_lighting_frames(self):
        from flight_video import prepare_aircraft
        trip=load_trip(SCRIPTS.parent/'examples/sample-single-leg.json')
        with tempfile.TemporaryDirectory() as temp,\
             patch('flight_video.valid_aircraft',side_effect=[True,False,True]),\
             patch('flight_video.lighting_samples',return_value=[]) as lighting,\
             patch('flight_video.subprocess.run',return_value=SimpleNamespace(returncode=0)) as run:
            prepare_aircraft(trip,Path(temp),[0,1],'blender')
        self.assertEqual(lighting.call_args.kwargs['frames'],[1])
        self.assertEqual(run.call_count,1)
        command=run.call_args.args[0]
        self.assertEqual(command[command.index('--start')+1],'1')
        self.assertEqual(command[command.index('--end')+1],'2')

    def test_joint_background_applies_one_medium_with_the_weather_clock(self):
        size=(2,2)
        identity=TransportLayer(np.zeros((*size,3)),np.ones((*size,1)))
        joint=Mock(return_value=TransportLayer(np.ones((*size,3)),np.full((*size,1),.5)))
        forbidden=Mock(side_effect=AssertionError('Separate transport was applied again'))
        environment={'np':np,'TRANSPORT':'joint','lru_cache':lru_cache,'zoom':lambda t:500.,
                     'camera':lambda t:np.eye(3),'travel_time':lambda t:t,
                     'TRIP':SimpleNamespace(weather_time=lambda t:t+10),'sun_direction':lambda t:np.array([0,0,1.]),
                     'star_radiance':lambda *args:np.full((*size,3),2.),'moon_transport':lambda *args:identity,
                     'globe_radiance':lambda *args,**kwargs:(identity,np.ones(size,np.float32)),
                     'aircraft_altitude':lambda *args:1000.,'WITH_WEATHER':True,
                     'render_cloud_volume':forbidden,'atmosphere_transport':forbidden}
        scene=compositor_function('_scene',environment)
        with patch.dict(sys.modules,{'jointtransport':SimpleNamespace(joint_transport=joint)}):
            result,cloud,_,plane=scene(2.,with_aircraft=False)
        np.testing.assert_array_equal(result,2.)
        self.assertIsNone(cloud);self.assertIsNone(plane);forbidden.assert_not_called()
        self.assertEqual(joint.call_args.args[2],12.)
        self.assertEqual(joint.call_args.kwargs['physical_dt'],2.)
        self.assertTrue(joint.call_args.kwargs['with_clouds'])

    def test_background_only_scene_does_not_load_aircraft_or_foreground(self):
        size=(2,2)
        identity=TransportLayer(np.zeros((*size,3)),np.ones((*size,1)))
        cloud=Mock(return_value=SimpleNamespace(layer=identity))
        airplane=Mock(side_effect=FileNotFoundError('Prior-aircraft tick was never prepared'))
        environment={'np':np,'TRANSPORT':'layered','lru_cache':lru_cache,'zoom':lambda t:500.,'camera':lambda t:np.eye(3),
                     'travel_time':lambda t:t,'TRIP':SimpleNamespace(weather_time=lambda t:t+10),
                     'sun_direction':lambda t:np.array([0,0,1.]),
                     'star_radiance':lambda *args:np.zeros((*size,3),np.float32),
                     'moon_transport':lambda *args:identity,
                     'globe_radiance':lambda *args,**kwargs:(identity,np.ones(size,np.float32)),
                     'aircraft_altitude':lambda *args:1000.,'WITH_WEATHER':True,
                     'render_cloud_volume':cloud,'atmosphere_transport':lambda *args,**kwargs:identity}
        scene=compositor_function('_scene',environment)
        with patch.dict(sys.modules,{'aircraft':SimpleNamespace(plane_radiance=airplane)}):
            _,_,_,plane=scene(1.875,with_aircraft=False)
        airplane.assert_not_called()
        self.assertIsNone(plane)
        self.assertFalse(cloud.call_args.kwargs['include_foreground'])
        self.assertEqual(cloud.call_args.args[2],11.875)
        self.assertEqual(cloud.call_args.kwargs['physical_dt'],1.875)

    def test_joint_aircraft_crop_receives_physical_weather_clocks_and_depth(self):
        physical=datetime(2030,11,17,tzinfo=timezone.utc)
        weather=datetime(2026,10,18,tzinfo=timezone.utc)
        size=(224,224)
        depth=np.full(size,.02,np.float32)
        plane=SimpleNamespace(radiance=np.zeros((*size,3),np.float32),
                              alpha=np.ones((*size,1),np.float32),depth=depth)
        identity=TransportLayer(np.zeros((*size,3)),np.ones((*size,1)))
        joint=Mock(return_value=identity)
        class DisplayReached(Exception):pass
        def display(*args):raise DisplayReached
        environment={'np':np,'TRANSPORT':'joint',
                     '_scene':lambda t:(np.zeros((*size,3),np.float32),None,np.ones(size),plane),
                     'zoom':lambda t:500.,'camera':lambda t:np.eye(3),'CX':112,'CY':112,
                     'aircraft_altitude':lambda *args:1000.,'RELIEF_EXAGGERATION':12.,
                     'TERRAIN_SAMPLER':SimpleNamespace(sample=lambda world:0.),
                     'travel_time':lambda t:physical,'TRIP':SimpleNamespace(weather_time=lambda t:weather),
                     'sun_direction':lambda dt:np.array([0,0,1.]),'WITH_WEATHER':True,
                     'source_over':source_over,'display_image':display,'exposure_at':lambda t:1.}
        frame=compositor_function('frame',environment)
        aircraft=SimpleNamespace(anchor_depth=lambda *args:np.ones(size),
                                 terrain_visibility=lambda *args:np.ones(size,bool))
        with patch.dict(sys.modules,{'aircraft':aircraft,'jointtransport':SimpleNamespace(joint_transport=joint)}):
            with self.assertRaises(DisplayReached):frame(29.)
        self.assertEqual(joint.call_args.args[2],weather)
        self.assertEqual(joint.call_args.kwargs['physical_dt'],physical)
        np.testing.assert_array_equal(joint.call_args.kwargs['depth'],depth)
        self.assertTrue(joint.call_args.kwargs['with_clouds'])
        self.assertEqual(joint.call_args.kwargs['size'],size)

    def test_zero_hold_type_cut_uses_only_one_coherent_instant(self):
        raw=load_trip(SCRIPTS.parent/'examples'/'sample-three-leg.json').to_dict()
        raw['video'].update(layover_hold_s=0,departure_hold_s=.5,arrival_hold_s=.5,fps=2)
        angles=np.sqrt([leg.angle for leg in trip_from_dict(raw).legs])
        raw['video']['duration_s']=1+1.5/(angles[0]/sum(angles))
        trip=trip_from_dict(raw);motion=Motion(trip);t=2.;prior=t-1/(trip.fps*4)
        current={trip.legs[i].aircraft for i,_ in motion.aircraft_mix(t)}
        previous={trip.legs[i].aircraft for i,_ in motion.aircraft_mix(prior)}
        self.assertTrue(previous-current)  # The old shutter path required a missing NPZ.
        size=(224,224)
        plane=SimpleNamespace(radiance=np.zeros((*size,3),np.float32),
                              alpha=np.zeros((*size,1),np.float32),depth=np.full(size,np.inf,np.float32))
        calls=[]
        def scene(when,with_aircraft=True):
            calls.append((when,with_aircraft))
            if when==prior and with_aircraft:
                raise FileNotFoundError('A different aircraft type has no NPZ at this tick')
            return np.zeros((*size,3),np.float32),None,np.ones(size,np.float32),plane
        class DisplayReached(Exception):pass
        def display(*args):raise DisplayReached
        identity=TransportLayer(np.zeros((*size,3)),np.ones((*size,1)))
        environment={'np':np,'TRIP':trip,'WITH_WEATHER':False,'TRANSPORT':'layered','math':math,'_scene':scene,'FPS':trip.fps,'camera':motion.camera,
                     'zoom':motion.zoom,'focal_length':focal_length,'camera_distance':distance,
                     'CY':112,'CX':112,'aircraft_altitude':lambda *args:0.,'RELIEF_EXAGGERATION':12.,
                     'TERRAIN_SAMPLER':SimpleNamespace(sample=lambda world:0.),
                     'travel_time':trip.travel_time,'sun_direction':lambda *args:np.array([0,0,1.]),
                     'atmosphere_transport':lambda *args,**kwargs:identity,'source_over':source_over,
                     'display_image':display,'exposure_at':lambda t:1.}
        frame=compositor_function('frame',environment)
        with patch.dict(sys.modules,{'aircraft':SimpleNamespace(anchor_depth=lambda *args:np.ones(size),
                                                               terrain_visibility=lambda *args:np.ones(size,bool))}):
            with self.assertRaises(DisplayReached):frame(t)
        self.assertEqual(calls,[(t,True)])

    def test_ground_graphics_stay_behind_cloud_obscured_aircraft(self):
        from PIL import Image,ImageDraw,ImageFilter
        size=(224,224)
        alpha=np.zeros((*size,1),np.float32);alpha[64:160,64:160]=1.
        plane=SimpleNamespace(radiance=alpha*np.array([.2,.6,.1],np.float32),
                              alpha=alpha,depth=np.full(size,.5,np.float32))
        clouds=SimpleNamespace(foreground_layer=TransportLayer(
            np.full((*size,3),.03,np.float32),np.full((*size,1),.2,np.float32)))
        haze=TransportLayer(np.full((*size,3),.01,np.float32),np.full((*size,1),.8,np.float32))
        def display(rgb,*args):
            return Image.fromarray(np.rint(np.clip(rgb,0,1)*255).astype(np.uint8)).convert('RGBA')
        def route(draw,*args):
            draw.line([(0,112),(223,112)],fill=(255,0,0,255),width=3)
        environment={'np':np,'WITH_WEATHER':True,'TRANSPORT':'layered','Image':Image,'ImageDraw':ImageDraw,'ImageFilter':ImageFilter,
                     '_scene':lambda t:(np.full((*size,3),.08,np.float32),clouds,np.ones(size),plane),
                     'zoom':lambda t:1300.,'camera':lambda t:np.eye(3),'W':224,'H':224,'CX':112,'CY':112,
                     'aircraft_altitude':lambda *args:0.,'RELIEF_EXAGGERATION':12.,
                     'TERRAIN_SAMPLER':SimpleNamespace(sample=lambda world:0.),'TRIP':SimpleNamespace(weather_time=lambda t:t,telemetry=None,moments=()),
                     'travel_time':lambda t:t,'sun_direction':lambda *args:np.array([0,0,1.]),
                     'atmosphere_transport':lambda *args,**kwargs:haze,'source_over':source_over,
                     'display_image':display,'exposure_at':lambda t:1.,'LEGS':[(0.,0.)],
                     'arcpoints':lambda *args:(np.empty((0,3)),np.empty(0)),
                     'project':lambda *args:np.empty((0,3)),'line_visible':lambda *args:None,
                     'flight_progress':lambda *args:1.,'route':route,'V':np.empty((0,3))}
        frame=compositor_function('frame',environment)
        fake=SimpleNamespace(anchor_depth=lambda *args:np.ones(size),terrain_visibility=lambda *args:np.ones(size,bool))
        with patch.dict(sys.modules,{'aircraft':fake}):
            result=np.asarray(frame(3.))
        expected=np.rint((.01+.8*(.03+.2*np.array([.2,.6,.1])))*255).astype(np.uint8)
        np.testing.assert_array_equal(result[112,112],expected)
        np.testing.assert_array_equal(result[112,20],[255,0,0])
        # Visible cloud attenuation remains; this is not a crisp aircraft
        # pasted over weather as part of restoring the graphic-free pixels.
        self.assertLess(int(result[112,112,1]),int(.6*255))
        # Screen typography stays in front even under an overlapping custom
        # layout; only the geographic route/dot/leader graphics are occluded.
        environment.update(V=np.array([[112.,112.,1.]]),ACCENT=(255,100,20),
            LABELS=SimpleNamespace(active=lambda *args:True,state=lambda *args:(100,100,24,24,1),appearances=[0]),
            AIRPORTS=[('ORD',)],PANEL_W=24,PANEL_H=24,visible=lambda *args:True,
            project=lambda points,*args:points,split_flap_panel=lambda *args:Image.new('RGBA',(24,24),(255,255,0,255)))
        with patch.dict(sys.modules,{'aircraft':fake}):
            labeled=np.asarray(frame(3.))
        np.testing.assert_array_equal(labeled[112,112],[255,255,0])

    def test_context_prepass_prepares_exact_frame_times(self):
        from flight_video import prepare_contexts
        trip=load_trip(SCRIPTS.parent/'examples'/'sample-three-leg.json')
        terrain=SimpleNamespace(sample=lambda position:0.)
        prepare=Mock(return_value={'sampling':'fixture'})
        modules={'terrain_detail':SimpleNamespace(terrain_sampler=lambda *args:terrain),
                 'nightlighting':SimpleNamespace(prepare_city_lights=prepare)}
        with tempfile.TemporaryDirectory() as temporary, patch.dict(sys.modules,modules):
            prepare_contexts(trip,Path(temporary),{'assets':{'terrain':{'path':'unused'}}},temporary)
        self.assertEqual(prepare.call_args.kwargs['physical_times'],
                         sorted(set(trip.travel_time(tick/trip.fps) for tick in range(trip.frame_count))))

    def test_actual_render_import_and_camera_contract_with_generated_assets(self):
        with tempfile.TemporaryDirectory(prefix='flight-render-import-') as temporary:
            root=Path(temporary)
            generated_render_assets(root)
            trip=load_trip(SCRIPTS.parent/'examples'/'sample-three-leg.json')
            (root/'trip.json').write_text(json.dumps(trip.to_dict()))
            env=dict(os.environ,FLIGHT_TRIP=str(root/'trip.json'),FLIGHT_ASSET_DIR=temporary,
                     FLIGHT_WORK_DIR=temporary,FLIGHT_AIRCRAFT_MODE='diagram',
                     PYTHONPATH=os.pathsep.join([str(SCRIPTS),str(SCRIPTS/'engine')]))
            code=('import render; from runtime import BUNDLE; from camera_geometry import pixel_rays; '
                  'origin,rays=pixel_rays(500,size=(8,6),center=(4,3),sensor_width=1080); '
                  'assert rays.shape==(6,8,3); assert render.DEM.shape==(4,8); '
                  'assert BUNDLE["assets"]["terrain"]["path"]=="terrain.nc"; '
                  'assert render.TERRAIN_SAMPLER.sample([1,0,0])==0; print("actual import passed")')
            result=subprocess.run([sys.executable,'-c',code],env=env,cwd=temporary,
                                  capture_output=True,text=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertIn('actual import passed',result.stdout)

    def test_selected_lighting_prepass_uses_real_lunar_runtime_and_extinction(self):
        with tempfile.TemporaryDirectory(prefix='flight-lunar-prepass-') as temporary:
            root=Path(temporary);bundle=generated_render_assets(root)
            raw=load_trip(SCRIPTS.parent/'examples/sample-single-leg.json').to_dict()
            raw['flights'][0].update(departure='2024-11-15T21:30:00-08:00',arrival='2024-11-17T07:30:00+13:00')
            raw['weather']={'mode':'illustrative_replay','sample_start':'2026-10-17T23:00:00Z',
                            'sample_end':'2026-10-18T20:00:00Z'}
            raw['style']['moonlight']=4000.
            (root/'trip.json').write_text(json.dumps(trip_from_dict(raw).to_dict()))
            (root/'weather').mkdir()
            (root/'weather/runtime.json').write_text(json.dumps({
                'initialization':'2026-10-17T21:00:00+00:00','valid_start':'2026-10-17T23:00:00+00:00',
                'valid_end':'2026-10-18T20:00:00+00:00','profile_hours':[3,6,9,12,15,18,21,24]}))
            bundle['weather']={'runtime_path':'weather/runtime.json'}
            (root/'bundle.json').write_text(json.dumps(bundle))
            env=dict(os.environ,FLIGHT_TRIP=str(root/'trip.json'),FLIGHT_ASSET_DIR=temporary,
                     FLIGHT_WORK_DIR=temporary,FLIGHT_AIRCRAFT_MODE='diagram',FLIGHT_QUALITY='preview',
                     FLIGHT_COMPUTE='cpu',PYTHONPATH=os.pathsep.join([str(SCRIPTS),str(SCRIPTS/'engine')]))
            code='''
import json
from unittest.mock import patch
import numpy as np
import render
import runtime
import cloudvolume as cloud
import atmosphere as air
from celestial import ephemeris,EARTH_KM
from frame_context import context_at
from flight_video import lighting_samples
from moonlighting import lunar_illumination
from motion import Motion
from quality import get_quality
trip=runtime.TRIP;motion=Motion(trip);terrain=render.TERRAIN_SAMPLER
for tick in (trip.frame_count//2,trip.frame_count//3,2*trip.frame_count//3,0,trip.frame_count-1):
    ctx=context_at(motion,tick/trip.fps,terrain);basis=np.asarray(ctx.camera_basis)
    point=basis[2:3]*(1+ctx.aircraft_altitude_m/6371000.)
    state=lunar_illumination(point,ctx.physical_utc)
    if state.visibility[0]>.5 and state.ratio[0]>1e-8:break
else:raise AssertionError('Fixture has no lit lunar sample')
cloud_calls=[];air_calls=[];air_rgb=np.array([.8,.4,.2])
def cloud_depth(points,directions,when,**kwargs):
    cloud_calls.append((points.copy(),directions.copy(),when,kwargs))
    return np.full(len(points),np.log(2.))
def air_depth(points,directions,length,**kwargs):
    air_calls.append((points.copy(),directions.copy(),length.copy(),kwargs))
    return np.broadcast_to(-np.log(air_rgb),(len(points),3)).copy()
with patch.object(cloud,'_cloud_optical_depth',side_effect=cloud_depth),patch.object(air,'optical_depth',side_effect=air_depth):
    samples=lighting_samples(trip,terrain,frames=[tick])
sample=samples[tick]
assert sum(value is not None for value in samples)==1
assert len(cloud_calls)==len(air_calls)==1
assert cloud_calls[0][2]==ctx.weather_utc and ctx.weather_utc!=ctx.physical_utc
assert cloud_calls[0][3]['samples']==get_quality().cloud_sun_steps
assert air_calls[0][3]['samples']==get_quality().atmosphere_sun_steps
expected_point=basis[2:3]*(1+ctx.aircraft_altitude_m*trip.style['relief_exaggeration']/6371000.)
np.testing.assert_allclose(cloud_calls[0][0],expected_point,rtol=0,atol=1e-12)
observer=basis[2]*(EARTH_KM+ctx.aircraft_altitude_m/1000.)
direction=ephemeris(ctx.physical_utc)[0]-observer;direction/=np.linalg.norm(direction)
np.testing.assert_allclose(sample['moon_camera'],basis@direction,rtol=0,atol=1e-12)
np.testing.assert_allclose(sample['moon_rgb'],trip.style['moonlight']*state.ratio[0]*state.visibility[0]*.5*air_rgb,rtol=2e-6)
assert min(sample['moon_rgb'])>0
assert sample['utc']==ctx.physical_utc.isoformat()
print(json.dumps({'frame':tick,'moon_rgb':sample['moon_rgb'],'weather_clock_forwarded':True,'actual_lunar_runtime':True}))
'''
            result=subprocess.run([sys.executable,'-c',code],env=env,cwd=temporary,
                                  capture_output=True,text=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            record=json.loads(result.stdout.strip().splitlines()[-1])
            self.assertTrue(record['actual_lunar_runtime'])
            self.assertTrue(record['weather_clock_forwarded'])
            self.assertGreater(min(record['moon_rgb']),0.)


class CacheValidationTests(unittest.TestCase):
    def test_cache_lock_contends_across_processes_and_releases_on_exit(self):
        from flight_video import configure
        trip_path=SCRIPTS.parent/'examples'/'sample-three-leg.json'
        trip=load_trip(trip_path)
        # Exercise actual configure writes and an owner that exits without
        # running Python cleanup, as well as ordinary context-manager release.
        code='''
import os,sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from flight_video import configure
from trip import load_trip
args=SimpleNamespace(workdir=sys.argv[1],assets=sys.argv[1],aircraft='diagram',quality='preview')
with patch('flight_video.cache_key',return_value='a'*64):
    with configure(args,load_trip(sys.argv[2]),{}) as (work,environment):
        Path(sys.argv[3]).write_text('locked')
        sys.stdin.readline()
        if sys.argv[4]=='exit':
            os._exit(0)
'''
        env=dict(os.environ,PYTHONPATH=os.pathsep.join([str(SCRIPTS),str(SCRIPTS/'engine')]))
        with tempfile.TemporaryDirectory(prefix='flight-lock-') as temporary, patch.dict(os.environ):
            root=Path(temporary)
            args=SimpleNamespace(workdir=temporary,assets=temporary,aircraft='diagram',quality='preview')
            for release in ('normal','exit'):
                with self.subTest(release=release):
                    ready=root/('ready-'+release)
                    owner=subprocess.Popen([sys.executable,'-c',code,temporary,str(trip_path),str(ready),release],
                                           env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE,text=True)
                    try:
                        deadline=time.monotonic()+10
                        while not ready.exists() and owner.poll() is None and time.monotonic()<deadline:
                            time.sleep(.01)
                        self.assertTrue(ready.exists(),'Owner failed to acquire the cache lock')
                        snapshot=(root/('a'*20)/'trip.json').read_bytes()
                        provenance=(root/('a'*20)/'provenance.json').read_bytes()
                        with patch('flight_video.cache_key',return_value='a'*64):
                            with self.assertRaisesRegex(RuntimeError,'already in use'):
                                with configure(args,trip,{}) as unused:
                                    self.fail('A second process acquired the same cache')
                        self.assertEqual((root/('a'*20)/'trip.json').read_bytes(),snapshot)
                        self.assertEqual((root/('a'*20)/'provenance.json').read_bytes(),provenance)
                        with patch('flight_video.cache_key',return_value='b'*64):
                            with configure(args,trip,{}) as (work,_):
                                self.assertEqual(work.name,'b'*20)
                        _,errors=owner.communicate('release\n',timeout=10)
                        self.assertEqual(owner.returncode,0,errors)
                        with patch('flight_video.cache_key',return_value='a'*64):
                            with configure(args,trip,{}) as (work,_):
                                self.assertEqual(work.name,'a'*20)
                    finally:
                        if owner.poll() is None:
                            owner.kill()
                        owner.communicate(timeout=10)

    def test_any_covered_pixel_requires_finite_depth(self):
        from flight_video import valid_aircraft
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'frame.npz'
            rgb=np.zeros((384,384,3),np.float32)
            alpha=np.zeros((384,384,1),np.float32)
            depth=np.full((384,384),np.inf,np.float32)
            alpha[10,10,0]=.0005
            np.savez_compressed(path,bank_deg=0.,pitch_deg=0.,schema_version=2,model_camera_height_m=100.,ground_clearance_m=0.,radiance=rgb,alpha=alpha,depth=depth)
            self.assertFalse(valid_aircraft(path))
            depth[10,10]=.5
            np.savez_compressed(path,bank_deg=0.,pitch_deg=0.,schema_version=2,model_camera_height_m=100.,ground_clearance_m=0.,radiance=rgb,alpha=alpha,depth=depth)
            self.assertTrue(valid_aircraft(path))
            for schema,height,clearance in [(1,100.,0.),(2.5,100.,0.),(2,0.,0.),(2,float('nan'),0.),
                                             (2,100.,-1.),(2,100.,float('inf'))]:
                np.savez_compressed(path,bank_deg=0.,pitch_deg=0.,schema_version=schema,model_camera_height_m=height,
                                    ground_clearance_m=clearance,radiance=rgb,alpha=alpha,depth=depth)
                self.assertFalse(valid_aircraft(path))
            depth[20,20]=np.nan
            np.savez_compressed(path,bank_deg=0.,pitch_deg=0.,schema_version=2,model_camera_height_m=100.,ground_clearance_m=0.,radiance=rgb,alpha=alpha,depth=depth)
            self.assertFalse(valid_aircraft(path))


if __name__=='__main__':unittest.main()

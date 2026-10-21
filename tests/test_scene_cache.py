"""Scene reuse preserves physical inputs and never reuses stale display pixels."""
from contextlib import redirect_stderr
import errno
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import zipfile

import numpy as np

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/route-replay/scripts'
sys.path[:0]=[str(SCRIPTS),str(SCRIPTS/'engine')]
import scene_cache as cache
from trip import load_trip,trip_from_dict


def trip():
    return load_trip(SCRIPTS.parent/'examples/sample-single-leg.json')


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.trip=trip()
        self.bundle={'assets':{'surface':{'sha256':'original'}},'created_at':'irrelevant'}
        self.environment={'packages':{'Pillow':'test'},'compute_device':{'backend':'cpu'},
                          'atmosphere_method':'integrate','cloud_view':'reference'}

    def identity(self,trip=None,bundle=None,environment=None,quality='delivery',transport='layered',**kwargs):
        return cache.identity(trip or self.trip,bundle or self.bundle,'diagram',environment or self.environment,
                              quality,transport,**kwargs)['key']

    def test_display_settings_reuse_but_every_physical_setting_invalidates(self):
        baseline=self.identity()
        for field,value in [('title','Renamed'),('telemetry',{'enabled':True,'units':'metric'}),
                            ('moments',[{'path':'not-loaded-in-identity'}])]:
            raw=self.trip.to_dict();raw[field]=value
            # A validated media object's path/content is deliberately absent
            # from scene identity; its final overlay cache validates those bytes.
            variant=SimpleNamespace(to_dict=lambda raw=raw:raw)
            self.assertEqual(self.identity(variant),baseline)
        for field in ('exposure_ev','adaptation_s'):
            raw=self.trip.to_dict();raw['style'][field]+=.5
            self.assertEqual(self.identity(trip_from_dict(raw)),baseline)
        for field in ('ground_radius','star_strength','relief_exaggeration','moonlight'):
            raw=self.trip.to_dict();raw['style'][field]+=.5
            self.assertNotEqual(self.identity(trip_from_dict(raw)),baseline)
        self.assertNotEqual(self.identity(quality='preview'),baseline)
        self.assertNotEqual(self.identity(transport='joint'),baseline)
        self.assertNotEqual(self.identity(bundle={'assets':{'surface':{'sha256':'changed'}}}),baseline)
        for field,value in [('compute_device',{'backend':'metal'}),('atmosphere_method','lookup'),
                            ('cloud_view','batched'),('atmosphere_view','batched'),('cloud_source','batched'),
                            ('volume_reconstruction','adaptive'),('volume_reconstruction','full')]:
            self.assertNotEqual(self.identity(environment={**self.environment,field:value}),baseline)
        raw=self.trip.to_dict()
        for leg in raw['flights']:
            from datetime import datetime,timedelta
            leg['departure']=(datetime.fromisoformat(leg['departure'])+timedelta(days=1)).isoformat()
            leg['arrival']=(datetime.fromisoformat(leg['arrival'])+timedelta(days=1)).isoformat()
        # Sample is a fixed local-time itinerary: retain validated date handling.
        self.assertNotEqual(self.identity(trip_from_dict(raw)),baseline)

    def test_overlay_font_sources_reuse_unknown_or_physical_source_changes_invalidate(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'engine').mkdir()
            physical=root/'engine/render.py';physical.write_text('physical = 1\n')
            overlay=root/'engine/scene_overlays.py';overlay.write_text('label_size = 42\n')
            font=root/'engine/fonts.py';font.write_text('font = "first"\n')
            baseline=self.identity(scripts=root)
            overlay.write_text('label_size = 84\n');font.write_text('font = "second"\n')
            self.assertEqual(self.identity(scripts=root),baseline)
            physical.write_text('physical = 2\n')
            self.assertNotEqual(self.identity(scripts=root),baseline)
            physical.write_text('physical = 1\n')
            (root/'unknown.py').write_text('unknown = True\n')
            self.assertNotEqual(self.identity(scripts=root),baseline)

    def test_configure_final_identity_changes_but_scene_and_current_provenance_are_correct(self):
        from flight_video import configure
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ):
            args=SimpleNamespace(workdir=temp,assets=temp,aircraft='diagram',quality='preview')
            with configure(args,self.trip,self.bundle) as (first,_):
                first_provenance=json.loads((first/'provenance.json').read_text())
                first_scene=os.environ['FLIGHT_SCENE_KEY']
            raw=self.trip.to_dict();raw['title']='New overlay variant';raw['telemetry']={'enabled':True,'units':'metric'}
            raw['style']['exposure_ev']+=.5
            variant=trip_from_dict(raw)
            # Prior ambient experimental selectors must never contaminate defaults.
            os.environ['FLIGHT_ATMOSPHERE_METHOD']='lookup';os.environ['FLIGHT_CLOUD_VIEW']='batched'
            with configure(args,variant,self.bundle) as (second,_):
                current=json.loads((second/'provenance.json').read_text())
                self.assertNotEqual(first,second)
                self.assertEqual(os.environ['FLIGHT_SCENE_KEY'],first_scene)
                self.assertEqual(os.environ['FLIGHT_ATMOSPHERE_METHOD'],'integrate')
                self.assertEqual(os.environ['FLIGHT_CLOUD_VIEW'],'reference')
                self.assertEqual(current['plan']['title'],'New overlay variant')
                self.assertEqual(current['scene_cache']['key'],first_scene)
                self.assertNotEqual(current['cache_key'],first_provenance['cache_key'])
            self.assertEqual(json.loads((first/'provenance.json').read_text()),first_provenance)


    def test_real_font_bytes_change_final_cache_but_reuse_physical_scene(self):
        from flight_video import configure
        from fonts import telemetry_font
        raw=self.trip.to_dict();raw['telemetry']={'enabled':True,'units':'aviation'}
        selected=trip_from_dict(raw)
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ):
            args=SimpleNamespace(workdir=temp,assets=temp,aircraft='diagram',quality='preview')
            os.environ.pop('FLIGHT_TELEMETRY_FONT',None)
            with configure(args,selected,self.bundle) as (first,_):
                first_scene=os.environ['FLIGHT_SCENE_KEY']
            alternate=Path(temp)/'font.ttf'
            alternate.write_bytes(Path(telemetry_font(54).path).read_bytes()+b'font identity proof')
            os.environ['FLIGHT_TELEMETRY_FONT']=str(alternate)
            with configure(args,selected,self.bundle) as (second,_):
                self.assertNotEqual(first,second)
                self.assertEqual(first_scene,os.environ['FLIGHT_SCENE_KEY'])


    def test_cli_off_avoids_scene_storage_preserves_pixels_identity_and_resets_stale_environment(self):
        from flight_video import configure
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ):
            args=SimpleNamespace(workdir=temp,assets=temp,aircraft='diagram',quality='preview',scene_cache='off')
            os.environ.update(FLIGHT_SCENE_DIR='stale',FLIGHT_SCENE_KEY='b'*64,FLIGHT_SCENE_FPS='60')
            with patch.object(cache,'initialize',side_effect=AssertionError('Off initialized cache')):
                with configure(args,self.trip,self.bundle) as (off,_):
                    record=json.loads((off/'provenance.json').read_text())
                    self.assertFalse(record['scene_cache']['enabled'])
                    self.assertEqual(record['scene_cache']['requested'],'off')
                    self.assertIsNone(cache.configured())
                    self.assertNotIn('FLIGHT_SCENE_DIR',os.environ)
                    off_budget=os.environ['FLIGHT_BUDGET_FINGERPRINT']
            self.assertFalse((Path(temp)/'scenes').exists())
            args.scene_cache='on'
            with configure(args,self.trip,self.bundle) as (on,_):
                self.assertEqual(off,on)  # Storage policy cannot change pixels.
                self.assertNotEqual(off_budget,os.environ['FLIGHT_BUDGET_FINGERPRINT'])
                self.assertTrue(json.loads((on/'provenance.json').read_text())['scene_cache']['enabled'])

    def test_cli_cache_initialization_disk_failure_is_nonfatal_and_recorded(self):
        from flight_video import configure
        warning=io.StringIO()
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ),redirect_stderr(warning),\
             patch.object(cache,'initialize',side_effect=OSError(errno.ENOSPC,'No space left on device')):
            args=SimpleNamespace(workdir=temp,assets=temp,aircraft='diagram',quality='preview')
            with configure(args,self.trip,self.bundle) as (work,_):
                record=json.loads((work/'provenance.json').read_text())
                self.assertFalse(record['scene_cache']['enabled'])
                self.assertEqual(record['scene_cache']['requested'],'on')
                self.assertIn('No space left',record['scene_cache']['storage_error'])
                self.assertIsNone(cache.configured())
                self.assertTrue((work/'trip.json').is_file())
        self.assertEqual(warning.getvalue().count('Warning:'),1)


class StorageTests(unittest.TestCase):
    def setUp(self):
        cache.reset_invocation()
        self.shape=patch.object(cache,'RADIANCE_SHAPE',(8,6,3));self.shape.start()
        self.coverage=patch.object(cache,'COVERAGE_SHAPE',(2,2,1));self.coverage.start()
        self.addCleanup(self.shape.stop);self.addCleanup(self.coverage.stop)
        self.rgb=np.linspace(0,100,8*6*3,dtype=np.float32).reshape(8,6,3)
        self.alpha=np.array([0,.25,.5,1],np.float32).reshape(2,2,1)
        self.key='a'*64

    def test_hdr_roundtrip_is_exact_readonly_and_wrong_identity_time_is_a_miss(self):
        with tempfile.TemporaryDirectory() as temp:
            cache.store_scene(temp,self.key,3,.125,self.rgb,self.alpha)
            rgb,alpha=cache.load_scene(temp,self.key,3,.125)
            np.testing.assert_array_equal(rgb,self.rgb);np.testing.assert_array_equal(alpha,self.alpha)
            self.assertFalse(rgb.flags.writeable);self.assertFalse(alpha.flags.writeable)
            self.assertIsNone(cache.load_scene(temp,'b'*64,3,.125))
            self.assertIsNone(cache.load_scene(temp,self.key,3,.126))
            self.assertIsNone(cache.load_scene(temp,self.key,4,.125))

    def test_corrupt_truncated_invalid_and_wrong_shape_entries_are_misses(self):
        with tempfile.TemporaryDirectory() as temp:
            target=Path(temp)/'000003.npz'
            for payload in (b'not-a-zip',b'PK\x03\x04'):
                target.write_bytes(payload);self.assertIsNone(cache.load_scene(temp,self.key,3,.125))
            metadata=np.asarray(json.dumps(cache._metadata(self.key,3,.125)))
            for rgb,alpha in ((self.rgb.astype(np.float64),self.alpha),(self.rgb[:1],self.alpha),
                              (self.rgb,np.full_like(self.alpha,np.nan)),(self.rgb,np.full_like(self.alpha,2.)),
                              (np.full_like(self.rgb,-1.),self.alpha),(np.full_like(self.rgb,np.inf),self.alpha)):
                np.savez(target,metadata=metadata,radiance=rgb,coverage=alpha)
                self.assertIsNone(cache.load_scene(temp,self.key,3,.125))
            with zipfile.ZipFile(target,'w') as z:
                z.writestr('invented.npy',b'a'*4096)
            self.assertIsNone(cache.load_scene(temp,self.key,3,.125))

    def test_interrupted_atomic_write_preserves_existing_entry(self):
        with tempfile.TemporaryDirectory() as temp:
            cache.store_scene(temp,self.key,3,.125,self.rgb,self.alpha)
            target=Path(temp)/'000003.npz';before=target.read_bytes()
            with patch('scene_cache.np.lib.format.write_array',side_effect=OSError('write interrupted')):
                with self.assertRaisesRegex(OSError,'interrupted'):
                    cache.store_scene(temp,self.key,3,.125,self.rgb+1,self.alpha)
            self.assertEqual(target.read_bytes(),before)
            self.assertFalse(list(Path(temp).glob('*.tmp')))
            self.assertIsNotNone(cache.load_scene(temp,self.key,3,.125))

    def test_cached_scene_skips_compute_and_non_frame_times_bypass(self):
        compute=Mock(return_value=(self.rgb,self.alpha))
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{
                'FLIGHT_SCENE_CACHE':'on','FLIGHT_SCENE_DIR':temp,'FLIGHT_SCENE_KEY':self.key,'FLIGHT_SCENE_FPS':'24'}):
            cache.cached_scene(3/24,compute)
            self.assertEqual(cache.last_event()['status'],'miss')
            cache.cached_scene(3/24,compute)
            self.assertEqual(cache.last_event()['status'],'hit');self.assertEqual(compute.call_count,1)
            cache.cached_scene(3/24+1e-9,compute)
            self.assertEqual(cache.last_event()['status'],'non-frame-time');self.assertEqual(compute.call_count,2)
            self.assertEqual(cache.missing_frames([2,3,4]),[2,4])
            (Path(temp)/'000003.npz').write_bytes(b'broken')
            cache.cached_scene(3/24,compute)
            self.assertEqual(compute.call_count,3);self.assertEqual(cache.last_event()['status'],'miss')

    def test_stale_scene_environment_never_skips_preparation_for_another_trip(self):
        raw=trip().to_dict();raw['video']['fps']=24
        selected=trip_from_dict(raw)
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{
                'FLIGHT_SCENE_CACHE':'on','FLIGHT_SCENE_DIR':temp,'FLIGHT_SCENE_KEY':self.key,'FLIGHT_SCENE_FPS':'24'}):
            cache.initialize(temp,{'key':self.key,'record':{'trip':cache.physical_trip(selected)}})
            cache.store_scene(temp,self.key,3,.125,self.rgb,self.alpha)
            self.assertEqual(cache.missing_frames([3],trip=selected),[])
            raw['title']='Only a display title'
            self.assertEqual(cache.missing_frames([3],trip=trip_from_dict(raw)),[])
            raw['style']['star_strength']+=1
            self.assertEqual(cache.missing_frames([3],trip=trip_from_dict(raw)),[3])
            (Path(temp)/'identity.json').write_text('{}')
            self.assertEqual(cache.missing_frames([3],trip=selected),[3])

    def test_disk_full_keeps_computed_scene_and_warns_once(self):
        compute=Mock(return_value=(self.rgb,self.alpha));warning=io.StringIO()
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{
                'FLIGHT_SCENE_CACHE':'on','FLIGHT_SCENE_DIR':temp,'FLIGHT_SCENE_KEY':self.key,'FLIGHT_SCENE_FPS':'24'}),\
             patch.object(cache,'store_scene',side_effect=OSError(errno.ENOSPC,'No space left on device')) as write,\
             redirect_stderr(warning):
            first=cache.cached_scene(3/24,compute)
            self.assertIs(first[0],self.rgb);self.assertIs(first[1],self.alpha)
            self.assertEqual(cache.last_event()['storage'],'failed')
            second=cache.cached_scene(4/24,compute)
            self.assertIs(second[0],self.rgb)
            self.assertEqual(cache.last_event()['storage'],'unavailable')
        self.assertEqual(compute.call_count,2);self.assertEqual(write.call_count,1)
        self.assertEqual(warning.getvalue().count('Warning:'),1)
        self.assertIn('--scene-cache off',warning.getvalue())

    def test_lock_directory_failure_falls_back_but_renderer_errors_still_propagate(self):
        compute=Mock(return_value=(self.rgb,self.alpha));warning=io.StringIO()
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{
                'FLIGHT_SCENE_CACHE':'on','FLIGHT_SCENE_DIR':temp,'FLIGHT_SCENE_KEY':self.key,'FLIGHT_SCENE_FPS':'24'}):
            with patch.object(Path,'mkdir',side_effect=PermissionError(errno.EACCES,'Cache is read-only')),redirect_stderr(warning):
                result=cache.cached_scene(3/24,compute)
                self.assertIs(result[0],self.rgb)
            self.assertEqual(compute.call_count,1);self.assertIn('read-only',warning.getvalue())
            cache.reset_invocation();warning=io.StringIO()
            failure=OSError(errno.ENOENT,'Renderer input is missing')
            failing_compute=Mock(side_effect=failure)
            with redirect_stderr(warning),self.assertRaises(OSError) as raised:
                cache.cached_scene(3/24,failing_compute)
            self.assertIs(raised.exception,failure);self.assertEqual(failing_compute.call_count,1)
            self.assertEqual(warning.getvalue(),'')
            with patch.object(cache,'store_scene',side_effect=ValueError('Invalid computed HDR')),\
                 self.assertRaisesRegex(ValueError,'Invalid computed HDR'):
                cache.cached_scene(3/24,compute)

    def test_environment_off_ignores_stale_cache_paths(self):
        compute=Mock(return_value=(self.rgb,self.alpha))
        with patch.dict(os.environ,{'FLIGHT_SCENE_CACHE':'off','FLIGHT_SCENE_DIR':'stale',
                                   'FLIGHT_SCENE_KEY':self.key,'FLIGHT_SCENE_FPS':'24'}),\
             patch.object(cache,'load_scene',side_effect=AssertionError('Cache read while off')):
            self.assertIs(cache.cached_scene(3/24,compute)[0],self.rgb)
            self.assertEqual(cache.last_event()['status'],'disabled')
            self.assertEqual(cache.missing_frames([3,4]),[3,4])

    def test_planning_memo_is_stat_guarded_bounded_and_does_not_replace_render_validation(self):
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{
                'FLIGHT_SCENE_CACHE':'on','FLIGHT_SCENE_DIR':temp,'FLIGHT_SCENE_KEY':self.key,'FLIGHT_SCENE_FPS':'24'}),\
             patch.object(cache,'load_scene',wraps=cache.load_scene) as load:
            cache.store_scene(temp,self.key,3,.125,self.rgb,self.alpha)
            self.assertEqual(cache.missing_frames([3]),[])
            self.assertEqual(cache.missing_frames([3]),[])
            self.assertEqual(load.call_count,1)
            cache.cached_scene(.125,Mock(side_effect=AssertionError('Scene recomputed')))
            self.assertEqual(load.call_count,2)  # Real loads always validate payloads.
            target=Path(temp)/'000003.npz';stamp=target.stat();payload=bytearray(target.read_bytes())
            payload[len(payload)//2]^=0x40;target.write_bytes(payload)
            os.utime(target,ns=(stamp.st_atime_ns,stamp.st_mtime_ns))
            self.assertEqual(target.stat().st_size,stamp.st_size)
            self.assertEqual(cache.missing_frames([3]),[3])
            self.assertEqual(load.call_count,3)
            self.assertEqual(cache.missing_frames([3]),[3]);self.assertEqual(load.call_count,3)
            cache.store_scene(temp,self.key,3,.125,self.rgb,self.alpha)
            self.assertEqual(cache.missing_frames([3]),[]);self.assertEqual(load.call_count,4)
            cache.reset_invocation()
            self.assertEqual(cache.missing_frames([3]),[]);self.assertEqual(load.call_count,5)
            with patch.object(cache,'_VALIDATION_LIMIT',2):
                for tick in (4,5):cache.store_scene(temp,self.key,tick,tick/24,self.rgb,self.alpha)
                self.assertEqual(cache.missing_frames([3,4,5]),[])
                self.assertEqual(len(cache._VALIDATED),2)
                self.assertTrue(all(type(value) is bool for value in cache._VALIDATED.values()))

    def test_file_changed_during_validation_is_not_memoized_as_valid(self):
        with tempfile.TemporaryDirectory() as temp:
            cache.store_scene(temp,self.key,3,.125,self.rgb,self.alpha)
            stamp=cache._file_stamp(Path(temp)/'000003.npz')
            changed=(*stamp[:-1],stamp[-1]+1)
            with patch.object(cache,'_file_stamp',side_effect=[stamp,changed]):
                self.assertFalse(cache._valid_for_planning(temp,self.key,3,.125))
            self.assertEqual(len(cache._VALIDATED),0)

    @unittest.skipIf(os.name=='nt','POSIX advisory-lock subprocess coverage')
    def test_concurrent_overlay_jobs_compute_shared_scene_once(self):
        code='''
import json,os,sys,time
from pathlib import Path
import numpy as np
import scene_cache as cache
cache.RADIANCE_SHAPE=(8,6,3);cache.COVERAGE_SHAPE=(2,2,1)
def compute():
    with (Path(sys.argv[1])/'computed.txt').open('a') as handle:handle.write('computed\\n')
    time.sleep(.15)
    return np.ones(cache.RADIANCE_SHAPE,np.float32),np.ones(cache.COVERAGE_SHAPE,np.float32)
cache.cached_scene(.125,compute)
print(json.dumps(cache.last_event()))
'''
        with tempfile.TemporaryDirectory() as temp:
            env={**os.environ,'PYTHONPATH':os.pathsep.join([str(SCRIPTS),str(SCRIPTS/'engine')]),
                 'FLIGHT_SCENE_CACHE':'on','FLIGHT_SCENE_DIR':temp,'FLIGHT_SCENE_KEY':self.key,'FLIGHT_SCENE_FPS':'24'}
            processes=[subprocess.Popen([sys.executable,'-c',code,temp],env=env,text=True,
                                        stdout=subprocess.PIPE,stderr=subprocess.PIPE) for _ in range(2)]
            results=[]
            for process in processes:
                output,error=process.communicate(timeout=10)
                self.assertEqual(process.returncode,0,error);results.append(json.loads(output))
            self.assertEqual(sorted(result['status'] for result in results),['hit','miss'])
            self.assertEqual((Path(temp)/'computed.txt').read_text(),'computed\n')
            self.assertIsNotNone(cache.load_scene(temp,self.key,3,.125))


class PreparationTests(unittest.TestCase):
    def test_all_scene_hits_skip_aircraft_and_city_prepass_but_preserve_contexts(self):
        from flight_video import prepare_aircraft,prepare_contexts
        selected=trip()
        terrain=SimpleNamespace(sample=lambda world:0.)
        with tempfile.TemporaryDirectory() as temp,patch('scene_cache.missing_frames',return_value=[]),\
             patch('flight_video.lighting_samples',side_effect=AssertionError('lighting computed')),\
             patch('flight_video.subprocess.run',side_effect=AssertionError('Blender started')),\
             patch.dict(sys.modules,{'terrain_detail':SimpleNamespace(terrain_sampler=lambda *args:terrain),
                 'nightlighting':SimpleNamespace(prepare_city_lights=Mock(side_effect=AssertionError('city prepass')))}):
            root=Path(temp)
            self.assertEqual(prepare_aircraft(selected,root,[0,1],'blender'),{})
            prepare_contexts(selected,root,{'assets':{'terrain':{'path':'unused'}}},root,scene_frames=[0,1])
            self.assertEqual(len(json.loads((root/'frame-contexts.json').read_text())['frames']),selected.frame_count)
            self.assertIn('reused physical scenes',json.loads((root/'prepass.json').read_text())['city_lights']['status'])
            self.assertFalse((root/'aircraft').exists())


if __name__=='__main__':unittest.main()

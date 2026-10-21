"""Local budgets require current evidence and never treat missing costs as free."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parents[1]/'skills/route-replay/scripts'
sys.path[:0] = [str(SCRIPTS),str(SCRIPTS/'engine')]
import render_budget as budget
from trip import trip_from_dict


def itinerary(legs=1, layover_hours=2):
    start = datetime(2030, 1, 1, tzinfo=timezone.utc)
    names = ['AAA','AAB','AAC','AAD','AAE']
    airports = {name:{'name':name,'lat':10.+i,'lon':20.+20*i,'timezone':'UTC'}
                for i,name in enumerate(names[:legs+1])}
    flights=[]
    for i in range(legs):
        depart=start+timedelta(hours=i*(1+layover_hours))
        flights.append({'from':names[i],'to':names[i+1],'departure':depart.isoformat(),
                        'arrival':(depart+timedelta(hours=1)).isoformat(),'aircraft':'a321neo'})
    return trip_from_dict({'schema_version':1,'title':'Budget fixture','airports':airports,'flights':flights,
                          'video':{'duration_s':30,'fps':2,'departure_hold_s':2,'arrival_hold_s':2,
                                   'layover_hold_s':2},'weather':{'mode':'clear'}})


def progress(remaining=9):
    return {'remaining_frames':remaining,'frame_timings':[
        {'frame':i,'seconds':10.,'budget_fingerprint':'current'} for i in range(3)],
        'png_bytes':[200,200,200], 'aircraft':{'a321neo':{'missing':list(range(remaining)), 'bytes':[100]}}}


def measurement():
    return {'fingerprint':'current','sample_frames':[0,1,2],'new_render_frames':3,
            'measurement':{'render_batch_seconds':30.,'prepass_seconds':2.,
                           'aircraft':{'seconds':9.,'new_frames_by_kind':{'a321neo':3},
                                       'output_bytes_by_kind':{'a321neo':[100,100,100]}},
                           'memory':{'process_peak_rss_bytes':100,'largest_child_peak_rss_bytes':200}}}


class SelectionTests(unittest.TestCase):
    def test_one_three_and_four_leg_routes_receive_valid_spread_samples(self):
        for count in (1,3,4):
            with self.subTest(legs=count):
                trip=itinerary(count)
                frames=budget.representative_frames(trip,count)
                self.assertEqual(len(frames),count)
                self.assertEqual(frames,sorted(set(frames)))
                for (start,end),tick in zip(trip.leg_intervals,frames):
                    self.assertLessEqual(start,tick/trip.fps)
                    self.assertLess(tick/trip.fps,end)

    def test_long_layovers_use_presentation_samples_without_daily_expansion(self):
        trip=itinerary(3,layover_hours=24*365*8)
        frames=budget.representative_frames(trip,8)
        self.assertEqual(len(frames),8)
        self.assertTrue(all(0<=f<trip.frame_count for f in frames))
        for previous,following in zip(trip.leg_intervals,trip.leg_intervals[1:]):
            self.assertTrue(any(previous[1] <= tick/trip.fps < following[0] for tick in frames))
        # An almost-complete cache uses only the actual outstanding frames.
        self.assertEqual(budget.representative_frames(trip,12,[2,17,59]),[2,17,59])

    def test_bad_counts_and_indices_fail_before_preparation(self):
        trip=itinerary()
        for values in ({'samples':0},{'samples':13},{'samples':True},{'workers':0},
                       {'frames':[]},{'frames':'1,no'},{'frames':[True]},{'frames':[60]}):
            with self.subTest(values=values),self.assertRaises(ValueError):
                budget.validate_request(trip,**values)
        large=SimpleNamespace(frame_count=budget.MAX_MEASURED_PREPASS_FRAMES+1)
        with self.assertRaisesRegex(ValueError,'estimate-only'):
            budget.validate_request(large)
        self.assertIsNone(budget.validate_request(large,estimate_only=True))
        self.assertEqual(budget.validate_request(trip,frames='5,2,5'),[2,5])


class EstimateTests(unittest.TestCase):
    def test_all_cost_stages_and_memory_are_distinct_from_unmeasured_encode(self):
        result=budget.estimate(progress(),measurement(),workers=2,fingerprint='current')
        self.assertEqual(result['frame_seconds']['count'],3)
        self.assertEqual(result['wall_seconds_per_frame'],10.)
        self.assertLess(result['remaining_frame_cache_wall_seconds'][0],119)
        self.assertGreater(result['remaining_frame_cache_wall_seconds'][1],119)
        self.assertEqual(result['remaining_aircraft_seconds_estimate'],27)
        self.assertEqual(result['next_prepass_seconds_proxy'],2)
        self.assertEqual(result['host_memory_planning_proxy_bytes'],500)
        self.assertIsNone(result['encoding_and_verification_seconds'])
        self.assertIsNone(result['gpu_memory_bytes'])
        self.assertEqual(result['unmeasured_aircraft_kinds'],[])
        self.assertIsNotNone(result['additional_frame_and_aircraft_bytes'])

    def test_progress_reduces_remaining_work_without_extra_worker_speedup(self):
        full=budget.estimate(progress(9),measurement(),workers=2,fingerprint='current')
        resumed=budget.estimate(progress(3),measurement(),workers=2,fingerprint='current')
        self.assertLess(resumed['remaining_frame_cache_wall_seconds'][1],full['remaining_frame_cache_wall_seconds'][1])
        # The estimator itself never divides measured throughput by a requested worker count.
        many=budget.estimate(progress(9),measurement(),workers=8,fingerprint='current')
        self.assertEqual(many['remaining_render_wall_seconds'],full['remaining_render_wall_seconds'])

    def test_unseen_aircraft_and_prepass_keep_total_unknown(self):
        value=progress();value['aircraft']['787-9']={'missing':[5],'bytes':[]}
        result=budget.estimate(value,measurement(),workers=2,fingerprint='current')
        self.assertIsNone(result['remaining_frame_cache_wall_seconds'])
        self.assertIsNone(result['additional_frame_and_aircraft_bytes'])
        self.assertEqual(result['unmeasured_aircraft_kinds'],['787-9'])
        tagged=budget.estimate(progress(),None,workers=2,fingerprint='current')
        self.assertIsNotNone(tagged['remaining_render_wall_seconds'])
        self.assertIsNone(tagged['remaining_frame_cache_wall_seconds'])
        self.assertIsNone(tagged['next_prepass_seconds_proxy'])

    def test_untagged_or_other_machine_timings_do_not_create_an_eta(self):
        value=progress()
        for row in value['frame_timings']:row['budget_fingerprint']='other-machine'
        result=budget.estimate(value,None,workers=2,fingerprint='current')
        self.assertIsNone(result['remaining_render_wall_seconds'])
        self.assertIsNone(result['remaining_frame_cache_wall_seconds'])
        self.assertIsNone(result['frame_seconds'])
        self.assertEqual(result['unverified_frame_timing_count'],3)
        self.assertEqual(result['unverified_frame_seconds']['count'],3)


    def test_overlay_only_measurements_cannot_estimate_uncached_scene_cost(self):
        value=progress();value['scene_cache']={'remaining_hits':8,'remaining_misses':1}
        for row in value['frame_timings']:row['scene_cache']={'status':'hit'};row['seconds']=.5
        sample=measurement();sample['measurement']['scene_cache']={'hit':3,'miss':0}
        sample['measurement']['render_batch_seconds']=1.5
        result=budget.estimate(value,sample,workers=2,fingerprint='current')
        self.assertIsNone(result['remaining_render_wall_seconds'])
        self.assertEqual(result['scene_rates']['hit']['wall_seconds_per_frame'],.5)
        self.assertIsNone(result['scene_rates']['miss']['wall_seconds_per_frame'])
        value['scene_cache']={'remaining_hits':9,'remaining_misses':0}
        result=budget.estimate(value,sample,workers=2,fingerprint='current')
        self.assertIsNotNone(result['remaining_render_wall_seconds'])
        self.assertEqual(result['wall_seconds_per_frame'],.5)
        self.assertEqual(result['additional_scene_cache_bytes_upper_bound'],0)


    def test_disabled_storage_has_full_scene_cost_but_no_scene_disk_projection(self):
        value=progress();value['scene_cache']={'remaining_hits':0,'remaining_misses':9,'key':None}
        for row in value['frame_timings']:row['scene_cache']={'status':'disabled'}
        sample=measurement();sample['measurement']['scene_cache']={'hit':0,'miss':3}
        result=budget.estimate(value,sample,workers=2,fingerprint='current')
        self.assertIsNotNone(result['remaining_render_wall_seconds'])
        self.assertEqual(result['scene_rates']['miss']['wall_seconds_per_frame'],10.)
        self.assertEqual(result['additional_scene_cache_bytes_upper_bound'],0)


class CacheIntegrationTests(unittest.TestCase):
    def test_scene_cache_hits_remove_aircraft_cost_without_claiming_png_completion(self):
        trip=itinerary()
        with tempfile.TemporaryDirectory() as temp,patch('scene_cache.missing_frames',return_value=[]),\
             patch('scene_cache.configured',return_value=None):
            result=budget.cache_progress(trip,Path(temp),'cycles',aircraft_validator=lambda path:False)
        self.assertEqual(result['remaining_frames'],trip.frame_count)
        self.assertEqual(result['valid_frames'],0)
        self.assertEqual(result['aircraft'],{})
        self.assertEqual(result['scene_cache']['remaining_hits'],trip.frame_count)
        self.assertEqual(result['scene_cache']['remaining_misses'],0)

    def test_all_scene_hit_budget_worker_does_not_claim_or_read_aircraft_outputs(self):
        import flight_video
        trip=itinerary()
        with tempfile.TemporaryDirectory() as temp:
            work=Path(temp);(work/'trip.json').write_text(json.dumps(trip.to_dict()))
            request={'work':temp,'assets':temp,'bundle':{},'frames':[4,31,55],'workers':2,
                     'aircraft':'cycles','environment':{'tools':{'blender':'fake-blender'},'cycles_device':{'backend':'cpu'}},
                     'threads':2,'frame_timeout':120,'result_path':str(work/'result.json')}
            request_path=work/'request.json';request_path.write_text(json.dumps(request))
            with patch('scene_cache.missing_frames',return_value=[]),\
                 patch.object(flight_video,'prepare_contexts',return_value='terrain') as contexts,\
                 patch.object(flight_video,'prepare_aircraft',return_value={}) as aircraft,\
                 patch.object(flight_video,'produce_frames'):
                budget._worker(request_path)
            result=json.loads((work/'result.json').read_text())
            self.assertEqual(contexts.call_args.kwargs['scene_frames'],request['frames'])
            self.assertEqual(aircraft.call_args.args[2],[])
            self.assertEqual(result['aircraft']['new_frames_by_kind'],{})
            self.assertEqual(result['aircraft']['output_bytes_by_kind'],{})
            self.assertEqual(result['scene_cache'],{'hit':3,'miss':0})

    def test_actual_cache_validation_ignores_stray_timings_and_corrupt_pixels(self):
        trip=itinerary(3,layover_hours=72)
        with tempfile.TemporaryDirectory() as temp:
            work=Path(temp);(work/'frames').mkdir()
            for tick in (0,1,2):
                (work/'frames'/f'{tick:06d}.png').write_bytes(b'valid' if tick!=1 else b'corrupt')
            for tick,seconds in ((0,10.),(1,999.),(2,float('nan')),(3,.001)):
                (work/'frames'/f'{tick:06d}.timing.json').write_text(json.dumps({'frame':tick,'seconds':seconds}))
            result=budget.cache_progress(trip,work,'cycles',
                png_validator=lambda path,size:path.read_bytes()==b'valid',aircraft_validator=lambda path:False)
        self.assertEqual(result['valid_frames'],2)
        self.assertEqual(result['remaining_frames'],58)
        self.assertEqual([r['frame'] for r in result['frame_timings']],[0])
        # Production still prepares aircraft for every requested frame, even when a PNG exists.
        self.assertEqual(result['aircraft']['a321neo']['required_for_render'],trip.frame_count)
        self.assertEqual(len(result['aircraft']['a321neo']['missing']),trip.frame_count)

    def test_identity_changes_for_machine_workers_backend_and_trip(self):
        trip=itinerary()
        with tempfile.TemporaryDirectory() as temp:
            work=Path(temp);(work/'provenance.json').write_text(json.dumps({'cache_key':'a'*64}))
            env={'compute_device':{'backend':'cpu','fallback_reason':'unused'}}
            def ident(workers=2,environment=env):
                return budget.identity(trip,work,environment,workers=workers,aircraft_mode='diagram',quality='preview',transport='layered')['fingerprint']
            first=ident()
            self.assertEqual(first,ident(environment={'compute_device':{'backend':'cpu'}}))
            self.assertNotEqual(first,ident(workers=3))
            self.assertNotEqual(first,ident(environment={'compute_device':{'backend':'metal'}}))
            with patch('render_budget.platform.node',return_value='different-host'):
                self.assertNotEqual(first,ident())
            other=budget.identity(itinerary(3),work,env,workers=2,aircraft_mode='diagram',quality='preview',transport='layered')
            self.assertNotEqual(first,other['fingerprint'])

    def test_current_cache_mode_changes_budget_identity_without_rewriting_prior_provenance(self):
        trip=itinerary()
        with tempfile.TemporaryDirectory() as temp:
            work=Path(temp);(work/'provenance.json').write_text(json.dumps({'cache_key':'a'*64,'scene_cache':{'enabled':True}}))
            def identity():return budget.identity(trip,work,{},workers=2,aircraft_mode='diagram',quality='preview',transport='layered')
            with patch.dict('render_budget.os.environ',{'FLIGHT_SCENE_CACHE':'on'}):on=identity()
            with patch.dict('render_budget.os.environ',{'FLIGHT_SCENE_CACHE':'off'}):off=identity()
            self.assertTrue(on['scene_cache_enabled']);self.assertFalse(off['scene_cache_enabled'])
            self.assertNotEqual(on['fingerprint'],off['fingerprint'])
            self.assertTrue(json.loads((work/'provenance.json').read_text())['scene_cache']['enabled'])

    def test_timing_identity_preserves_configure_default_arguments(self):
        with patch('render_budget.identity',return_value={'fingerprint':'matching'}) as identify, \
             patch.dict('render_budget.os.environ',{},clear=True):
            self.assertEqual(budget.set_timing_identity(SimpleNamespace(aircraft='diagram'), 'trip', 'work', {}),
                             'matching')
            self.assertEqual(identify.call_args.kwargs,dict(workers=2,aircraft_mode='diagram',
                                                          quality='delivery',transport='layered'))
            self.assertEqual(budget.os.environ['FLIGHT_BUDGET_FINGERPRINT'],'matching')

    def test_estimate_only_rejects_stale_benchmark_without_writing_or_starting_workers(self):
        trip=itinerary()
        args=SimpleNamespace(workers=2,aircraft='diagram',quality='preview',transport='layered',
                             samples=3,frames=None,estimate_only=True,report=None)
        with tempfile.TemporaryDirectory() as temp:
            work=Path(temp);(work/'provenance.json').write_text(json.dumps({'cache_key':'a'*64}))
            old=measurement();old['fingerprint']='old-source'
            (work/'render-budget-benchmark.json').write_text(json.dumps(old))
            before={p.name:p.read_bytes() for p in work.iterdir()}
            state={**progress(),'missing_frame_indices':list(range(9))}
            with patch('render_budget.cache_progress',return_value=state),\
                 patch('render_budget._measure',side_effect=AssertionError('Started worker')):
                result=budget.run_budget(args,trip,{},work,{})
            self.assertTrue(result['stale_benchmark_rejected'])
            self.assertIsNone(result['measurement'])
            self.assertIsNone(result['estimate']['remaining_frame_cache_wall_seconds'])
            self.assertEqual(before,{p.name:p.read_bytes() for p in work.iterdir()})

    def test_changed_source_during_benchmark_retains_timings_but_rejects_eta(self):
        trip=itinerary()
        with tempfile.TemporaryDirectory() as temp:
            work=Path(temp)
            args=SimpleNamespace(workers=2,aircraft='diagram',quality='preview',transport='layered',
                                 samples=1,frames=[4],assets=temp,estimate_only=False,report=None)
            state={**progress(),'missing_frame_indices':list(range(9))}
            def measure(request,log,timeout):
                budget._write(work/'render-budget-measurement.json',measurement()['measurement'])
                return 0
            with patch('render_budget.cache_progress',return_value=state), \
                 patch('render_budget.identity',side_effect=[{'fingerprint':'before'},{'fingerprint':'after'}]), \
                 patch('render_budget._measure',side_effect=measure):
                result=budget.run_budget(args,trip,{},work,{})
            self.assertTrue(result['source_changed_during_measurement'])
            self.assertFalse(result['measurement_usable_for_estimate'])
            self.assertIsNotNone(result['measurement'])
            self.assertIsNone(result['estimate']['remaining_frame_cache_wall_seconds'])
            self.assertFalse((work/'render-budget-benchmark.json').exists())

    def test_worker_calls_real_pipeline_boundaries_with_selected_frames(self):
        import flight_video
        trip=itinerary(3)
        with tempfile.TemporaryDirectory() as temp:
            work=Path(temp);(work/'trip.json').write_text(json.dumps(trip.to_dict()))
            request={'work':temp,'assets':temp,'bundle':{},'frames':[4,31,55],'workers':2,
                     'aircraft':'cycles','environment':{'tools':{'blender':'fake-blender'},'cycles_device':{'backend':'cpu'}},
                     'threads':2,'frame_timeout':120,'result_path':str(work/'result.json')}
            request_path=work/'request.json';request_path.write_text(json.dumps(request))
            def aircraft(trip,work,ticks,*args,**kwargs):
                directory=work/'aircraft'/'frames-a321neo';directory.mkdir(parents=True,exist_ok=True)
                for tick in ticks:(directory/f'frame-{tick:04d}.npz').write_bytes(b'cache')
            with patch.object(flight_video,'prepare_contexts',return_value='terrain') as prepare,\
                 patch.object(flight_video,'prepare_aircraft',side_effect=aircraft) as planes,\
                 patch.object(flight_video,'valid_aircraft',return_value=False),\
                 patch.object(flight_video,'produce_frames') as produce:
                budget._worker(request_path)
            measured=json.loads((work/'result.json').read_text())
            self.assertEqual(prepare.call_count,1)
            self.assertEqual(planes.call_args.args[2],request['frames'])
            self.assertEqual(produce.call_args.args[2:],(request['frames'],2))
            self.assertEqual(measured['aircraft']['new_frames_by_kind'],{'a321neo':3})
            self.assertTrue(measured['prepass_seconds']>=0)

    @unittest.skipUnless(sys.platform!='win32','POSIX process-group contract')
    def test_timeout_terminates_worker_process_group_before_releasing_cache(self):
        process=Mock(pid=12345)
        process.wait.side_effect=[subprocess.TimeoutExpired('worker',1),0]
        with tempfile.TemporaryDirectory() as temp,patch('render_budget.subprocess.Popen',return_value=process),\
             patch('render_budget.os.killpg') as kill:
            with self.assertRaisesRegex(RuntimeError,'resumable'):
                budget._measure(Path(temp)/'request.json',Path(temp)/'log',1)
        self.assertEqual(kill.call_args.args[0],12345)
        self.assertEqual(kill.call_count,2)
        self.assertEqual(process.wait.call_count,2)


if __name__=='__main__':unittest.main()

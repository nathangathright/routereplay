"""Complete camera-air parity, exact boundaries and dated source preservation."""
from datetime import datetime, timedelta, timezone
from functools import partial
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts'
sys.path[:0]=[str(SCRIPTS),str(SCRIPTS/'engine')]
import metal_atmosphere as gpu
from metal_compute import backend


class AtmosphereFixture(unittest.TestCase):
    def setUp(self):
        self.runtime=SimpleNamespace(TRIP=SimpleNamespace(style={}),ASSETS=Path('/unused'),BUNDLE={})
        modules=patch.dict(sys.modules,{'runtime':self.runtime})
        modules.start();self.addCleanup(modules.stop)
        spec=importlib.util.spec_from_file_location('_metal_camera_air_test',SCRIPTS/'engine/atmosphere.py')
        self.air=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.air)
        air_module=patch.dict(sys.modules,{'atmosphere':self.air})
        air_module.start();self.addCleanup(air_module.stop)
        env=patch.dict(os.environ,{'FLIGHT_COMPUTE':'metal','FLIGHT_ATMOSPHERE_METHOD':'integrate',
            'FLIGHT_ATMOSPHERE_VIEW':'reference'})
        env.start();self.addCleanup(env.stop)

    def run_view(self,view,origins,rays,sun,**kwargs):
        with patch.dict(os.environ,{'FLIGHT_ATMOSPHERE_VIEW':view}):
            return self.air.integrate_atmosphere_rays(origins,rays,sun,**kwargs)

    def compare(self,origins,rays,sun,**kwargs):
        expected=self.run_view('reference',origins,rays,sun,**kwargs)
        actual=self.run_view('batched',origins,rays,sun,**kwargs)
        for first,second in zip(actual,expected):
            self.assertTrue(np.isfinite(first).all())
            np.testing.assert_allclose(first,second,atol=2e-6,rtol=2e-5)
        self.assertTrue(np.all(actual[0]>=0))
        self.assertTrue(np.all((actual[1]>=0)&(actual[1]<=1)))
        return actual


class SelectionTests(AtmosphereFixture):
    def test_cpu_selector_keeps_portable_reference(self):
        with patch.dict(os.environ,{'FLIGHT_COMPUTE':'cpu'}), \
             patch.object(gpu,'integrate_segments',side_effect=AssertionError('GPU accessed')):
            first=self.run_view('reference',[0,0,1.2],[[0,0,-1]],[0,0,1])
            second=self.run_view('batched',[0,0,1.2],[[0,0,-1]],[0,0,1])
        for a,b in zip(first,second):np.testing.assert_array_equal(a,b)

    def test_invalid_selector_is_explicit(self):
        with self.assertRaisesRegex(ValueError,'Atmosphere view'):
            self.run_view('invalid',[0,0,1.2],[[0,0,-1]],[0,0,1])


class MetalAtmosphereTests(AtmosphereFixture):
    @classmethod
    def setUpClass(cls):
        try:backend()
        except RuntimeError as exc:raise unittest.SkipTest(str(exc))

    def test_asset_free_probe_and_empty_rays(self):
        self.assertEqual(gpu.probe()['kernel'],'atmosphere_view')
        light,trans=self.run_view('batched',[0,0,1.5],np.empty((0,3)),[0,0,1])
        self.assertEqual(light.shape,(0,3));self.assertEqual(trans.shape,(0,3))

    def test_day_twilight_night_limb_and_aircraft_depths(self):
        # Parallel rays cross the body, tangent shells, and empty space; the
        # opaque prefix cuts include no hit, before entry and aircraft heights.
        impact=np.r_[np.linspace(0,.99,70),1+np.linspace(-1e-8,1e-8,25),
            np.linspace(1.0001,1.12,70)]
        origins=np.column_stack((np.full(len(impact),1.5),impact,np.zeros(len(impact))))
        rays=np.broadcast_to([-1.,0.,0.],origins.shape)
        depths=np.tile([np.inf,0.,.01,.49,.50,.8],len(impact)//6+1)[:len(impact)]
        for method in ('integrate','lookup'):
            with patch.dict(os.environ,{'FLIGHT_ATMOSPHERE_METHOD':method}):
                for sun in ([1,0,0],[0,1,0],[-1,0,0],[1,-.18,.02]):
                    with self.subTest(method=method,sun=sun):
                        self.compare(origins,rays,sun,depth=depths,
                            view_samples=24,sun_samples=10,multiple_scattering=1.3,saturation=.8)

    def test_full_cpu_reference_at_all_quality_budgets(self):
        impact=np.linspace(0,1.13,121)
        origins=np.column_stack((np.full(len(impact),1.5),impact,np.zeros(len(impact))))
        rays=np.broadcast_to([-1.,0.,0.],origins.shape)
        for view_samples,sun_samples in ((12,6),(24,10),(40,16)):
            options=dict(view_samples=view_samples,sun_samples=sun_samples,moon_gain=0.)
            with patch.dict(os.environ,{'FLIGHT_COMPUTE':'cpu'}):
                expected=self.run_view('reference',origins,rays,[1,.2,.3],**options)
            actual=self.run_view('batched',origins,rays,[1,.2,.3],**options)
            for first,second in zip(actual,expected):
                np.testing.assert_allclose(first,second,atol=3e-5,rtol=2e-5)

    def test_near_ground_repair_retains_original_float64_samples(self):
        offsets=np.linspace(-1e-8,1e-8,35)
        points=np.column_stack((np.zeros((len(offsets),2)),1.01+offsets))
        segments=np.column_stack((np.ones(len(offsets)),np.full(len(offsets),63.71),
            np.full(len(offsets),.02),np.ones((len(offsets),2))))
        constants=[6371.,720.,57.6,8.64,*self.air.BETA_R,self.air.MIE_EXTINCTION,
            self.air.BETA_M,.38/.62,.90]
        detected,repairs=gpu._run(points,segments,np.zeros((len(offsets),9)),np.ones((len(offsets),2)),
            np.arange(len(offsets)+1,dtype=np.uint32),[0,0,-1],constants,samples=3,lookup=False)
        np.testing.assert_array_equal(detected[:,6],1)
        np.testing.assert_array_equal(repairs[:,6],1)
        # The first solar midpoint for S=10 is at ground at this exact radius.
        # Several tiny adjacent view intervals trigger multiple corrections per
        # ray; float64 +/- offsets deliberately straddle the physical boundary.
        radius=(1+.05*(self.air.OUTER_KM/self.air.EARTH_KM))/.95
        origin=np.column_stack((np.full(len(offsets),1.2)+offsets,np.zeros((len(offsets),2))))
        rays=np.broadcast_to([-1.,0.,0.],origin.shape);sun=np.array([-1.,0.,0.])
        edges=np.broadcast_to((1.2-radius)+np.linspace(-1e-7,1e-7,9),(len(offsets),9))
        kwargs=dict(sun_samples=10,multiple_scattering=1.,physical_dt=None,
            weather_dt=None,with_clouds=False,gain=0.)
        expected=self.air._integrate_atmosphere_segments(origin,rays,sun,edges,**kwargs)
        import metal_compute
        with patch.object(self.air,'_integrate_atmosphere_segments',
                          side_effect=AssertionError('Whole-ray repair must not repeat lunar sources')), \
             patch.object(metal_compute,'optical_depth',wraps=metal_compute.optical_depth) as repair:
            actual=gpu.integrate_segments(origin,rays,sun,edges,**kwargs)
        self.assertEqual(repair.call_count,1)
        self.assertGreater(len(repair.call_args.args[0]),len(origin))
        self.assertEqual(repair.call_args.args[0].dtype,np.float64)
        for first,second in zip(actual,expected):
            np.testing.assert_allclose(first,second,atol=1e-9,rtol=1e-5)

    def test_moon_clock_cloud_attenuation_and_call_order(self):
        from moonlighting import _frame_geometry
        physical=datetime(2026,10,26,tzinfo=timezone.utc)
        weather=datetime(2026,1,1,tzinfo=timezone.utc)
        up=_frame_geometry(physical)[0];up=up/np.linalg.norm(up)
        rays=np.broadcast_to(-up,(21,3));origin=up*1.2
        depths=np.linspace(.18,.19999,len(rays));seen=[]
        def cloud_tau(points,directions,dt,**kwargs):
            seen.append(dt)
            return .4+.1*points[:,0]**2
        clouds=SimpleNamespace(HEIGHT_EXAGGERATION=12.,_cloud_optical_depth=cloud_tau)
        with patch.dict(sys.modules,{'cloudvolume':clouds}):
            values={}
            for dt in (physical,physical+timedelta(hours=7)):
                values[dt]=self.compare(origin,rays,-up,depth=depths,view_samples=12,
                    physical_dt=dt,weather_dt=weather,with_clouds=True,moon_gain=4000.)
            self.assertTrue(seen);self.assertTrue(all(dt==weather for dt in seen))
            for dt in reversed(values):
                actual=self.run_view('batched',origin,rays,-up,depth=depths,view_samples=12,
                    physical_dt=dt,weather_dt=weather,with_clouds=True,moon_gain=4000.)
                for a,b in zip(actual,values[dt]):np.testing.assert_array_equal(a,b)
            dark=self.run_view('batched',origin,rays,-up,depth=depths,view_samples=12,
                physical_dt=physical,weather_dt=weather,with_clouds=True,moon_gain=0.)
        self.assertTrue(np.any(values[physical][0]>dark[0]))
        self.assertFalse(np.array_equal(values[physical][0],values[physical+timedelta(hours=7)][0]))

    def test_dated_aerosol_file_solar_and_camera_extinction(self):
        import environmental_data as data
        with tempfile.TemporaryDirectory() as directory:
            start=datetime(2026,1,1,tzinfo=timezone.utc);end=start+timedelta(hours=3)
            self.runtime.ASSETS=Path(directory)
            self.runtime.BUNDLE={'environment':{'aerosol':{'path':'aerosol.npz'}}}
            metadata={'schema_version':1,'kind':'aerosol','source_kind':'modeled',
                'source':{'url':'https://example.org/source','credit':'Synthetic regression fixture',
                    'license_url':'https://example.org/license','notes':'Modeled test values'},
                'units':{'aod550':'1'},'conversion':'Synthetic test fixture',
                'original_files':[{'name':'fixture','sha256':'0'*64,'bytes':1}]}
            data.write_environment(Path(directory)/'aerosol.npz',[90,0,-90],[0,90,180,270],
                [start.timestamp(),end.timestamp()],
                {'aod550':np.broadcast_to(np.array([.01,.4])[:,None,None],(2,3,4))},metadata)
            impact=np.array([0.,.8,.99,1.00001,1.001,1.02])
            origins=np.column_stack((np.full(len(impact),1.2),impact,np.zeros(len(impact))))
            rays=np.broadcast_to([-1.,0.,0.],origins.shape)
            first=self.compare(origins,rays,[1,.4,0],weather_dt=start,moon_gain=0.,view_samples=12)
            second=self.compare(origins,rays,[1,.4,0],weather_dt=end,moon_gain=0.,view_samples=12)
            self.assertTrue(np.all(second[1]<=first[1]))
            self.assertGreater(np.max(first[1]-second[1]),.01)
            with self.assertRaisesRegex(ValueError,'outside'):
                self.run_view('batched',origins,rays,[1,.4,0],
                    weather_dt=end+timedelta(seconds=1),moon_gain=0.)

    def test_compact_buffers_bounded_tiles_and_ray_order(self):
        rng=np.random.default_rng(481)
        rays=rng.normal(size=(99,3));rays[:,0]=-np.abs(rays[:,0])
        origin=np.array([1.15,0,0]);sun=np.array([.8,.2,.1]);seen=[]
        original_run=gpu._run
        def audit(points,segments,external,phases,offsets,*args,**kwargs):
            seen.append(len(offsets)-1)
            self.assertLessEqual(len(offsets)-1,11)
            self.assertEqual(offsets.dtype,np.uint32)
            self.assertTrue(np.all(np.diff(offsets.astype(np.int64))>=0))
            self.assertEqual(points.shape,(int(offsets[-1]),3))
            self.assertEqual(segments.shape,(len(points),5))
            self.assertEqual(external.shape,(len(points),9))
            self.assertEqual(phases.shape,(len(offsets)-1,2))
            self.assertTrue(np.isfinite(points).all());self.assertTrue(np.all(segments[:,0]>0))
            return original_run(points,segments,external,phases,offsets,*args,**kwargs)
        original_integrate=gpu.integrate_segments
        expected=self.run_view('batched',origin,rays,sun)
        with patch.object(gpu,'integrate_segments',partial(original_integrate,tile_rays=11)), \
             patch.object(gpu,'_run',side_effect=audit):
            actual=self.run_view('batched',origin,rays,sun)
        self.assertGreater(len(seen),1)
        reverse=self.run_view('batched',origin,rays[::-1],sun)
        for a,b,c in zip(actual,expected,reverse):
            np.testing.assert_array_equal(a,b);np.testing.assert_array_equal(a,c[::-1])


if __name__=='__main__':unittest.main()

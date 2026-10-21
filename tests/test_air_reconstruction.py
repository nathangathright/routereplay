"""Spatial air reconstruction keeps the existing ray physics and depth contract."""
from datetime import datetime, timedelta, timezone
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts'
sys.path[:0]=[str(SCRIPTS),str(SCRIPTS/'engine')]
from camera_geometry import pixel_rays, sphere_interval
from quality import get_quality
from radiometry import resize_float


class AirReconstructionTests(unittest.TestCase):
    def setUp(self):
        self.runtime=SimpleNamespace(TRIP=SimpleNamespace(style={}),ASSETS=Path('/unused'),BUNDLE={})
        modules=patch.dict(sys.modules,{'runtime':self.runtime})
        modules.start();self.addCleanup(modules.stop)
        spec=importlib.util.spec_from_file_location('_air_reconstruction_test',SCRIPTS/'engine/atmosphere.py')
        self.air=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.air)
        modules=patch.dict(sys.modules,{'atmosphere':self.air})
        modules.start();self.addCleanup(modules.stop)
        env=patch.dict(os.environ,{'FLIGHT_COMPUTE':'cpu','FLIGHT_ATMOSPHERE_METHOD':'integrate',
            'FLIGHT_ATMOSPHERE_VIEW':'reference','FLIGHT_VOLUME_RECONSTRUCTION':'reference',
            'FLIGHT_QUALITY':'delivery'})
        env.start();self.addCleanup(env.stop)

    def render(self,mode,**options):
        arguments=dict(bs=np.eye(3),sun=np.array([.8,.1,.3]),radius=7.,
            size=(23,19),center=(11.5,9.5),sensor_width=23)
        arguments.update(options)
        with patch.dict(os.environ,{'FLIGHT_VOLUME_RECONSTRUCTION':mode}):
            return self.air.atmosphere_transport(**arguments)

    def assert_layer_equal(self,first,second):
        np.testing.assert_array_equal(first.radiance,second.radiance)
        np.testing.assert_array_equal(first.transmittance,second.transmittance)

    def test_reference_retains_coarse_ray_and_nearest_depth_result(self):
        depth=np.zeros((19,23),np.float32);depth[:,11:]=.45
        for quality in ('preview','delivery','high'):
            with self.subTest(quality=quality),patch.dict(os.environ,{'FLIGHT_QUALITY':quality}):
                budget=get_quality()
                origin,rays=pixel_rays(7.,(23,19),(11.5,9.5),
                    scale=budget.atmosphere_scale,sensor_width=23)
                shape=rays.shape[:2]
                sampled_depth=resize_float(depth,(shape[1],shape[0]),Image.Resampling.NEAREST).ravel()
                light,transmission=self.air.integrate_atmosphere_rays(origin@np.eye(3),
                    (rays@np.eye(3)).reshape(-1,3),[.8,.1,.3],depth=sampled_depth,
                    view_samples=budget.atmosphere_view_steps,sun_samples=budget.atmosphere_sun_steps)
                actual=self.render('reference',depth=depth)
                np.testing.assert_array_equal(actual.radiance,resize_float(light.reshape(*shape,3),(23,19)))
                np.testing.assert_array_equal(actual.transmittance,
                    np.clip(resize_float(transmission.reshape(*shape,3),(23,19)),0,1))

    def test_full_matches_manual_full_spatial_integration_at_every_quality(self):
        physical=datetime(2026,10,26,tzinfo=timezone.utc)
        weather=datetime(2026,1,1,tzinfo=timezone.utc)
        depth=np.zeros((19,23),np.float32);depth[5:15,8:16]=.4
        origin,rays=pixel_rays(7.,(23,19),(11.5,9.5),scale=1,sensor_width=23)
        for quality in ('preview','delivery','high'):
            with self.subTest(quality=quality),patch.dict(os.environ,{'FLIGHT_QUALITY':quality}):
                budget=get_quality()
                light,transmission=self.air.integrate_atmosphere_rays(origin@np.eye(3),
                    (rays@np.eye(3)).reshape(-1,3),[.8,.1,.3],depth=depth.ravel(),
                    view_samples=budget.atmosphere_view_steps,sun_samples=budget.atmosphere_sun_steps,
                    physical_dt=physical,weather_dt=weather)
                actual=self.render('full',depth=depth,physical_dt=physical,weather_dt=weather)
                np.testing.assert_array_equal(actual.radiance,light.reshape(19,23,3))
                np.testing.assert_array_equal(actual.transmittance,transmission.reshape(19,23,3))

    def test_explicit_rays_preserve_their_grid_in_all_modes(self):
        # Arbitrary world rays deliberately do not match the requested camera.
        rays=np.array([[[0.,0.,-1.],[.1,0.,-1.],[.2,0.,-1.]],
                       [[0.,.1,-1.],[.1,.1,-1.],[.2,.1,-1.]]])
        depth=np.array([[0.,.1,.3],[.05,np.inf,.15]],np.float32)
        arguments=dict(camera_rays=(np.array([0.,0.,1.2]),rays),depth=depth)
        expected=self.render('reference',**arguments)
        with patch.object(self.air,'pixel_rays',side_effect=AssertionError('Explicit rays replaced')), \
             patch.object(self.air,'_reconstruct_atmosphere',side_effect=AssertionError('Explicit grid resampled')):
            for mode in ('adaptive','full'):
                self.assert_layer_equal(expected,self.render(mode,**arguments))

    def test_full_evaluates_every_pixel_in_bounded_batches(self):
        seen=[]
        def constant_transport(origin,rays,sun,**kwargs):
            seen.append(rays.copy())
            return np.full((len(rays),3),.2,np.float32),np.full((len(rays),3),.8,np.float32)
        with patch.object(self.air,'integrate_atmosphere_rays',side_effect=constant_transport), \
             patch.object(self.air,'sphere_interval',side_effect=AssertionError('Full mode built geometry guides')):
            actual=self.render('full',size=(97,65),center=(48.5,32.5),sensor_width=97)
        self.assertGreater(len(seen),1);self.assertLessEqual(max(map(len,seen)),4096)
        _,expected=pixel_rays(7.,(97,65),(48.5,32.5),scale=1,sensor_width=97)
        np.testing.assert_array_equal(np.concatenate(seen),expected.reshape(-1,3))
        np.testing.assert_array_equal(actual.radiance,np.full((65,97,3),.2,np.float32))

    def test_scale_one_aircraft_crop_stays_aligned_and_unreconstructed(self):
        options=dict(radius=9.,sensor_width=40,scale=1)
        full=self.render('full',size=(40,32),center=(20,16),**options)
        crop_options=dict(size=(18,14),center=(9,7),**options)
        with patch.object(self.air,'_reconstruct_atmosphere',side_effect=AssertionError('Crop reconstructed')):
            for mode in ('reference','adaptive','full'):
                crop=self.render(mode,**crop_options)
                np.testing.assert_allclose(crop.radiance,full.radiance[9:23,11:29],atol=2e-7,rtol=2e-6)
                np.testing.assert_allclose(crop.transmittance,full.transmittance[9:23,11:29],atol=2e-7,rtol=2e-6)

    def test_adaptive_respects_shell_and_depth_before_entry(self):
        size=(65,49);center=(32.5,24.5)
        origin,rays=pixel_rays(14.,size,center,sensor_width=65)
        rays=rays.astype(np.float64);rays/=np.linalg.norm(rays,axis=-1,keepdims=True)
        near,far,hit=sphere_interval(origin.astype(np.float64),rays,self.air.OUTER_KM/self.air.EARTH_KM)
        ground,_,ground_hit=sphere_interval(origin.astype(np.float64),rays)
        depth=np.zeros((49,65),np.float32);depth[15:34,29:36]=.001
        end=np.where(ground_hit,np.minimum(ground,far),far)
        end=np.where(depth>0,np.minimum(end,depth),end)
        valid=hit&(end>near)
        arguments=dict(radius=14.,size=size,center=center,sensor_width=65,depth=depth,
            scale=4,view_samples=12,sun_samples=6)
        adaptive=self.render('adaptive',**arguments)
        full=self.render('full',**arguments)
        np.testing.assert_array_equal(adaptive.radiance[~valid],0)
        np.testing.assert_array_equal(adaptive.transmittance[~valid],1)
        # Discontinuous opaque-depth and planet-limb neighborhoods must not
        # interpolate the optical column of the ray on the opposite side.
        boundary=np.zeros_like(valid)
        for guide in (valid,ground_hit,depth>0):
            boundary[1:]|=guide[1:]!=guide[:-1];boundary[:-1]|=guide[1:]!=guide[:-1]
            boundary[:,1:]|=guide[:,1:]!=guide[:,:-1];boundary[:,:-1]|=guide[:,1:]!=guide[:,:-1]
        np.testing.assert_allclose(adaptive.radiance[boundary],full.radiance[boundary],atol=2e-6,rtol=2e-5)
        np.testing.assert_allclose(adaptive.transmittance[boundary],full.transmittance[boundary],atol=2e-6,rtol=2e-5)

    def test_adaptive_samples_sparse_rays_and_preserves_source_controls(self):
        physical=datetime(2026,10,26,tzinfo=timezone.utc)
        weather=datetime(2026,1,1,tzinfo=timezone.utc)
        seen=[]
        def constant_transport(origin,rays,sun,**kwargs):
            seen.append((origin.copy(),rays.copy(),np.asarray(sun).copy(),kwargs))
            return np.full((len(rays),3),.2,np.float32),np.full((len(rays),3),.8,np.float32)
        for quality in ('preview','delivery','high'):
            seen.clear()
            with self.subTest(quality=quality),patch.dict(os.environ,{'FLIGHT_QUALITY':quality}), \
                 patch.object(self.air,'integrate_atmosphere_rays',side_effect=constant_transport):
                layer=self.render('adaptive',radius=600.,size=(64,48),center=(32,24),sensor_width=1080,
                    physical_dt=physical,weather_dt=weather,with_clouds=True,
                    strength=1.4,multiple_scattering=.6,saturation=.8)
            self.assertLess(sum(len(rays) for _,rays,_,_ in seen),64*48)
            for origin,rays,sun,kwargs in seen:
                self.assertEqual(kwargs['physical_dt'],physical)
                self.assertEqual(kwargs['weather_dt'],weather)
                self.assertTrue(kwargs['with_clouds'])
                self.assertEqual(kwargs['view_samples'],get_quality(quality).atmosphere_view_steps)
                self.assertEqual(kwargs['sun_samples'],get_quality(quality).atmosphere_sun_steps)
                self.assertEqual((kwargs['strength'],kwargs['multiple_scattering'],kwargs['saturation']),(1.4,.6,.8))
                np.testing.assert_array_equal(sun,[.8,.1,.3])
                np.testing.assert_allclose(np.linalg.norm(rays,axis=-1),1.,atol=1e-7)
            np.testing.assert_allclose(layer.radiance,.2,atol=1e-7)
            np.testing.assert_allclose(layer.transmittance,.8,atol=1e-7)

    def test_fractional_coarse_rays_use_their_actual_planet_limb_classification(self):
        size=(65,49);center=(32.5,24.5);radius=21.99
        origin,rays=pixel_rays(radius,size,center,sensor_width=1080)
        rays=rays.astype(np.float64);rays/=np.linalg.norm(rays,axis=-1,keepdims=True)
        _,_,ground=sphere_interval(origin.astype(np.float64),rays)
        boundary=np.zeros_like(ground)
        boundary[1:]|=ground[1:]!=ground[:-1];boundary[:-1]|=ground[1:]!=ground[:-1]
        boundary[:,1:]|=ground[:,1:]!=ground[:,:-1];boundary[:,:-1]|=ground[:,1:]!=ground[:,:-1]
        # An optically thin fixture makes the geometry guide responsible for
        # exact clipping, without high-contrast transport forcing every ray.
        with patch.object(self.air,'BETA_R',self.air.BETA_R*.01), \
             patch.object(self.air,'BETA_M',self.air.BETA_M*.01), \
             patch.object(self.air,'MIE_EXTINCTION',self.air.MIE_EXTINCTION*.01):
            options=dict(radius=radius,size=size,center=center,sensor_width=1080,
                scale=6.,view_samples=12,sun_samples=6)
            adaptive=self.render('adaptive',**options);full=self.render('full',**options)
        # These output rays miss Earth, while the fractional coarse rays hit it.
        # Same-side boundary neighbors remain valid interpolation candidates.
        np.testing.assert_allclose(adaptive.radiance[[2,46],32],full.radiance[[2,46],32],atol=2e-6,rtol=2e-5)
        np.testing.assert_allclose(adaptive.transmittance[[2,46],32],full.transmittance[[2,46],32],atol=2e-6,rtol=2e-5)
        self.assertLess(float(np.max(np.abs(adaptive.radiance-full.radiance)[boundary])),.004)

    def test_adaptive_physical_clock_and_weather_queries_are_order_independent(self):
        from moonlighting import _frame_geometry
        physical=datetime(2026,10,26,tzinfo=timezone.utc)
        weather=datetime(2026,1,1,tzinfo=timezone.utc)
        up=_frame_geometry(physical)[0];up=up/np.linalg.norm(up)
        right=np.cross([0.,0.,1.],up);right/=np.linalg.norm(right)
        basis=np.array([right,np.cross(up,right),up])
        seen=[]
        def cloud_tau(points,directions,dt,**kwargs):
            seen.append(dt)
            return np.full(len(points),.3)
        clouds=SimpleNamespace(HEIGHT_EXAGGERATION=12.,_cloud_optical_depth=cloud_tau)
        options=dict(bs=basis,sun=-up,radius=600.,size=(17,15),center=(8.5,7.5),
            sensor_width=1080,scale=4,view_samples=12,sun_samples=6,
            weather_dt=weather,with_clouds=True)
        with patch.dict(sys.modules,{'cloudvolume':clouds}):
            dates=(physical,physical+timedelta(hours=7))
            values={dt:self.render('adaptive',physical_dt=dt,**options) for dt in dates}
            for dt in reversed(dates):
                self.assert_layer_equal(values[dt],self.render('adaptive',physical_dt=dt,**options))
            with patch.dict(self.runtime.TRIP.style,{'moonlight':0.}):
                dark=self.render('adaptive',physical_dt=physical,**options)
        self.assertTrue(seen);self.assertTrue(all(dt==weather for dt in seen))
        self.assertGreater(float(np.max(values[physical].radiance-dark.radiance)),1e-6)
        self.assertFalse(np.array_equal(values[dates[0]].radiance,values[dates[1]].radiance))

    def test_dated_aerosol_changes_camera_extinction_on_the_weather_clock(self):
        import environmental_data as data
        start=datetime(2026,1,1,tzinfo=timezone.utc);end=start+timedelta(hours=3)
        metadata={'schema_version':1,'kind':'aerosol','source_kind':'modeled',
            'source':{'url':'https://example.org/source','credit':'Synthetic regression fixture',
                'license_url':'https://example.org/license','notes':'Modeled test values'},
            'units':{'aod550':'1'},'conversion':'Synthetic test fixture',
            'original_files':[{'name':'fixture','sha256':'0'*64,'bytes':1}]}
        with tempfile.TemporaryDirectory() as directory:
            self.runtime.ASSETS=Path(directory)
            self.runtime.BUNDLE={'environment':{'aerosol':{'path':'aerosol.npz'}}}
            data.write_environment(Path(directory)/'aerosol.npz',[90,0,-90],[0,90,180,270],
                [start.timestamp(),end.timestamp()],
                {'aod550':np.broadcast_to(np.array([.01,.4])[:,None,None],(2,3,4))},metadata)
            options=dict(radius=600.,size=(13,11),center=(6.5,5.5),sensor_width=1080,
                scale=4,view_samples=12,sun_samples=6)
            for mode in ('reference','adaptive','full'):
                with self.subTest(mode=mode):
                    first=self.render(mode,weather_dt=start,**options)
                    second=self.render(mode,weather_dt=end,**options)
                    self.assertTrue(np.all(second.transmittance<first.transmittance))
                    self.assertGreater(float(np.max(first.transmittance-second.transmittance)),.1)
                    self.assert_layer_equal(first,self.render(mode,weather_dt=start,**options))
            with self.assertRaisesRegex(ValueError,'outside'):
                self.render('adaptive',weather_dt=end+timedelta(seconds=1),**options)

    def test_invalid_selector_and_ambiguous_depth_fail(self):
        with self.assertRaisesRegex(ValueError,'Volume reconstruction'):
            self.render('invalid')
        with self.assertRaisesRegex(ValueError,'depth or surface_depth'):
            self.render('adaptive',depth=np.zeros((19,23)),surface_depth=np.zeros((19,23)))
        with self.assertRaisesRegex(ValueError,'2D'):
            self.render('adaptive',depth=np.zeros(23))


if __name__=='__main__':unittest.main()

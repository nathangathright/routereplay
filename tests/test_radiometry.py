"""Linear transport, final display transform and causal exposure invariants."""
from pathlib import Path
import ast
import math
import sys
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import unittest

import numpy as np

ENGINE = Path(__file__).resolve().parents[1]/'skills'/'route-replay'/'scripts'/'engine'
sys.path[:0]=[str(ENGINE),str(ENGINE.parent)]
from radiometry import (TransportLayer, srgb_to_linear, linear_to_srgb,
                        resize_float, source_over, tone_map, causal_exposure_profile)


def aircraft_module():
    # Aircraft loading/geometry can be checked without a trip bundle or Blender.
    spec = importlib.util.spec_from_file_location('hdr_aircraft_test', ENGINE/'aircraft.py')
    module = importlib.util.module_from_spec(spec)
    fake_runtime = SimpleNamespace(AIRCRAFT_DIR=Path('/unused'), AIRCRAFT_MODE='diagram')
    with patch.dict(sys.modules, {'runtime': fake_runtime, spec.name: module}):
        spec.loader.exec_module(module)
    return module


class RadiometryTests(unittest.TestCase):
    def test_aircraft_lunar_state_validates_shared_flux_and_cache_identity(self):
        path=ENGINE/'aircraft_blender.py'
        node=next(node for node in ast.parse(path.read_text()).body
                  if isinstance(node,ast.FunctionDef) and node.name=='lunar_light_state')
        scope={'np':np,'math':math}
        exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),scope)
        state=scope['lunar_light_state']
        sample={'moonlight_enabled':True,'moon_camera':[.8,0,.6],
                'moon_rgb':[.01,.009,.008],'moon_angular_diameter':.009}
        self.assertEqual(state(sample)[2],(.01,.009,.008))
        alternatives=[sample,dict(sample,moon_camera=[-.8,0,.6]),
                      dict(sample,moon_rgb=[0,0,0]),dict(sample,moon_angular_diameter=.01),
                      dict(sample,moonlight_enabled=False)]
        self.assertEqual(len({state(item) for item in alternatives}),len(alternatives))
        self.assertFalse(state({})[0])
        for change in ({'moon_camera':[1,1,1]},{'moon_rgb':[-1,0,0]},
                       {'moon_rgb':[1,np.inf,1]},{'moon_angular_diameter':0},
                       {'moonlight_enabled':'true'}):
            with self.subTest(change=change),self.assertRaises(ValueError):
                state(dict(sample,**change))

    def test_cycles_lunar_light_floor_direction_and_phase_preserve_geometry(self):
        blender=shutil.which('blender')
        mac=Path('/Applications/Blender.app/Contents/MacOS/Blender')
        if blender is None and mac.is_file():blender=str(mac)
        if blender is None:self.skipTest('Blender not installed; shared lunar-state tests still run.')
        base={'heading':0.,'sun_camera':[0.,0.,-1.],'sun_visibility':0.,'t':0.,
              'camera_distance_earth':1.95,'aircraft_altitude_m':11000.,
              'rendered_altitude_m':132000.,'vertical_exaggeration':12.,'illustrative_altitude_m':11000.}
        moon={'moonlight_enabled':True,'moon_camera':[.8,0.,.6],
              'moon_rgb':[.01,.009,.008],'moon_angular_diameter':.009}
        below=dict(moon,moon_camera=[0.,0.,-1.],moon_rgb=[0.,0.,0.])
        cases=[{},below,moon,dict(moon,moon_rgb=[.0025,.00225,.002]),
               dict(moon,moon_camera=[-.8,0.,.6]),moon,
               {'sun_camera':[0.,0.,1.],'sun_visibility':1.},
               dict(below,sun_camera=[0.,0.,1.],sun_visibility=1.)]
        # Preview preparation may omit frame zero; Cycles must start from the
        # first prepared state while retaining the real frame indices.
        samples=[None]*3+[dict(base,**change,frame=i+3) for i,change in enumerate(cases)]
        with tempfile.TemporaryDirectory(prefix='flight-lunar-aircraft-') as temporary:
            root=Path(temporary)
            (root/'lighting-samples.json').write_text(json.dumps(samples))
            command=[blender,'-b','-t','2','--python-exit-code','1','--python',
                     str(ENGINE/'aircraft_blender.py'),'--','--a321neo','--all','--threads','2',
                     '--start','3','--end',str(len(samples))]
            result=subprocess.run(command,env=dict(os.environ,FLIGHT_AIRCRAFT_DIR=temporary,
                                                   FLIGHT_QUALITY='preview'),
                                  capture_output=True,text=True,timeout=120)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            frames=[]
            self.assertFalse((root/'frames-a321neo'/'frame-0000.npz').exists())
            for i in range(3,len(samples)):
                with np.load(root/'frames-a321neo'/f'frame-{i:04d}.npz') as data:
                    frame={key:data[key].copy() for key in ('radiance','alpha','depth')}
                self.assertTrue(np.isfinite(frame['radiance']).all())
                self.assertTrue(np.all(frame['radiance']>=0))
                frames.append(frame)
            for frame in frames[1:]:
                np.testing.assert_array_equal(frame['alpha'],frames[0]['alpha'])
                np.testing.assert_array_equal(frame['depth'],frames[0]['depth'])
            # Keep opaque paint, excluding the aircraft's emissive lamps.
            body=(frames[0]['alpha'][...,0]>.99)&(np.max(frames[0]['radiance'],axis=-1)<.1)
            means=np.array([frame['radiance'][body].mean(axis=0) for frame in frames])
            self.assertLess(float(means[1].mean()),float(means[0].mean())*.35)
            self.assertGreater(float(means[2].mean()),float(means[1].mean())*1.5)
            ratio=(means[3]-means[1])/(means[2]-means[1])
            np.testing.assert_allclose(ratio,.25,atol=.04)
            # Incoming RGB remains warm/neutral; no blue moon tint is inserted.
            self.assertGreater(float(means[2,0]-means[1,0]),float(means[2,2]-means[1,2]))
            x=np.broadcast_to(np.arange(384)[None,:]-191.5,body.shape)
            changed=np.mean(frames[2]['radiance']-frames[4]['radiance'],axis=-1)
            self.assertGreater(float(np.sum(changed[body]*x[body])),1.)
            np.testing.assert_array_equal(frames[2]['radiance'],frames[5]['radiance'])
            np.testing.assert_allclose(means[6],means[7],rtol=.01)

    def test_generic_cycles_night_floor_and_subhorizon_sun_cache(self):
        blender=shutil.which('blender')
        mac=Path('/Applications/Blender.app/Contents/MacOS/Blender')
        if blender is None and mac.is_file():blender=str(mac)
        if blender is None:self.skipTest('Blender not installed; generic pose requires Cycles.')
        base={'heading':0.,'sun_camera':[0.,0.,-1.],'sun_visibility':0.,'t':0.,
              'camera_distance_earth':1.95,'aircraft_altitude_m':11000.,
              'rendered_altitude_m':132000.,'vertical_exaggeration':12.}
        night=dict(base,moonlight_enabled=True,moon_camera=[0.,0.,-1.],
                   moon_rgb=[0.,0.,0.],moon_angular_diameter=.009)
        twilight=dict(night,sun_camera=[math.sqrt(1-.05**2),0.,-.05])
        # Both Moon and Sun directional fluxes are zero. Only the generic
        # ambient pose changes, so an incorrect dedup hit hides the change.
        samples=[base,night,twilight,night]
        with tempfile.TemporaryDirectory(prefix='flight-generic-night-') as temporary:
            root=Path(temporary)
            (root/'lighting-samples.json').write_text(json.dumps(samples))
            command=[blender,'-b','-t','2','--python-exit-code','1','--python',
                     str(ENGINE/'aircraft_blender.py'),'--','--all','--threads','2']
            result=subprocess.run(command,env=dict(os.environ,FLIGHT_AIRCRAFT_DIR=temporary,
                                                   FLIGHT_QUALITY='preview'),
                                  capture_output=True,text=True,timeout=120)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            frames=[]
            for i in range(4):
                with np.load(root/'frames'/f'frame-{i:04d}.npz') as data:
                    frames.append({key:data[key].copy() for key in ('radiance','alpha','depth')})
            body=frames[0]['alpha'][...,0]>.99
            means=np.array([frame['radiance'][body].mean(axis=0) for frame in frames])
            np.testing.assert_allclose(means[1]/means[0],.20,rtol=.02)
            np.testing.assert_allclose(means[2]/means[0],.20+.80/9,rtol=.02)
            np.testing.assert_array_equal(frames[1]['radiance'],frames[3]['radiance'])
            for frame in frames[1:]:
                np.testing.assert_array_equal(frame['alpha'],frames[0]['alpha'])
                np.testing.assert_array_equal(frame['depth'],frames[0]['depth'])

    def test_srgb_round_trip_and_unclipped_hdr(self):
        display = np.array([0, .003, .04045, .18, .5, 1], np.float32)
        np.testing.assert_allclose(linear_to_srgb(srgb_to_linear(display)), display, atol=1e-7)
        self.assertGreater(linear_to_srgb(np.array([4.]))[0], 1)

    def test_transport_preserves_hdr_and_is_associative(self):
        back = np.full((2, 3, 3), 7., np.float32)
        far = TransportLayer(np.full_like(back, 2.), np.full((2,3,1), .4))
        near = TransportLayer(np.full_like(back, 3.), np.full((2,3,3), .2))
        combined = TransportLayer(near.radiance + near.transmittance * far.radiance,
                                  near.transmittance * far.transmittance)
        np.testing.assert_allclose(near.over(far.over(back)), combined.over(back), atol=1e-6)
        self.assertGreater(float(combined.over(back).min()), 1)

    def test_transport_cache_owns_immutable_arrays(self):
        source = np.ones((2,2,3), np.float32)
        layer = TransportLayer(source, np.ones((2,2,1)))
        source[:] = 9
        np.testing.assert_array_equal(layer.radiance, 1)
        with self.assertRaises(ValueError):
            layer.radiance[0,0] = 2
        output = layer.over(source)
        output[:] = 0
        np.testing.assert_array_equal(layer.radiance, 1)

    def test_float_resize_and_source_over_keep_highlights(self):
        light = np.full((2,2,3), 12., np.float32)
        alpha = np.full((2,2,1), .25)
        enlarged = resize_float(light, (9,7))
        np.testing.assert_allclose(enlarged, 12)
        result = source_over(light, alpha, np.full_like(light, 4))
        np.testing.assert_allclose(result, 15)

    def test_one_display_transform_has_monotone_highlight_rolloff(self):
        values = np.array([0, .01, .1, .5, 1, 2, 4, 16, 64], np.float32)
        for exposure in [.25, 1, 4]:
            mapped = tone_map(values, exposure)
            self.assertTrue(np.all(np.diff(mapped) > 0))
            self.assertTrue(np.all((mapped >= 0) & (mapped < 1)))
        self.assertFalse(np.allclose(tone_map(np.array([8.+2.])),
                                     tone_map(np.array([8.])) + tone_map(np.array([2.]))))

    def test_exposure_is_causal_immutable_and_order_independent(self):
        times = np.arange(20) / 4
        meter = np.linspace(.01, .4, 20)
        full = causal_exposure_profile(times, meter)
        prefix = causal_exposure_profile(times[:11], meter[:11])
        np.testing.assert_array_equal(full[:11], prefix)
        order = np.random.default_rng(2).permutation(20)
        reconstructed = np.empty(20)
        for index in order:
            reconstructed[index] = full[index]
        np.testing.assert_array_equal(reconstructed, full)
        with self.assertRaises(ValueError):
            full[0] = 2
        with self.assertRaises(ValueError):
            causal_exposure_profile(times[::-1], meter)

    def test_aircraft_depth_matches_normalized_camera_ray(self):
        aircraft = aircraft_module()
        from camera_geometry import pixel_rays, EARTH_M
        radius, altitude = 550., 11000.
        origin, rays = pixel_rays(radius, size=(224,224), center=(112,112))
        depth = aircraft.anchor_depth(radius, altitude)
        intersection = origin + rays * depth[..., None]
        np.testing.assert_allclose(intersection[..., 2], 1 + altitude/EARTH_M, atol=2e-7)
        self.assertGreater(depth[0,0], depth[112,112])

    def test_aircraft_resize_preserves_hdr_and_finite_covered_depth(self):
        aircraft = aircraft_module()
        alpha = np.zeros((4,4,1), np.float32)
        alpha[1:3,1:3] = 1
        light = np.repeat(alpha, 3, axis=-1) * 6
        depth = np.where(alpha[...,0] > 0, .8, np.inf)
        layer = aircraft.AircraftLayer(light, alpha, depth)
        resized = aircraft._resize_layer(layer, (17,19))
        np.testing.assert_allclose(resized.radiance, resized.alpha * np.array([6,6,6]), atol=1e-6)
        np.testing.assert_allclose(resized.depth[resized.alpha[...,0] > 0], .8, atol=1e-7)
        self.assertTrue(np.isinf(resized.depth[resized.alpha[...,0] == 0]).all())
        with self.assertRaises(ValueError):
            resized.depth[0,0] = 2

    def test_aircraft_resize_keeps_depth_at_subnormal_coverage(self):
        aircraft = aircraft_module()
        tiny = np.nextafter(np.float32(0), np.float32(1))
        depth = np.array([[.2, .4], [.6, .8]], np.float32)
        for alpha_value in (tiny, np.finfo(np.float32).tiny, .7):
            alpha = np.full((2,2,1), alpha_value, np.float32)
            layer = aircraft.AircraftLayer(np.zeros((2,2,3)), alpha, depth)
            for size in ((1,1), (7,9)):
                with self.subTest(alpha=alpha_value, size=size):
                    resized = aircraft._resize_layer(layer, size)
                    self.assertTrue(np.all(resized.alpha > 0))
                    np.testing.assert_allclose(resized.depth, resize_float(depth, size), atol=1e-7)

    def test_aircraft_crossfade_keeps_depth_at_subnormal_coverage(self):
        aircraft = aircraft_module()
        tiny = np.nextafter(np.float32(0), np.float32(1))
        alpha = np.full((2,2,1), tiny, np.float32)
        first = aircraft.AircraftLayer(np.zeros((2,2,3)), alpha, np.full((2,2), .2))
        second = aircraft.AircraftLayer(np.zeros((2,2,3)), alpha, np.full((2,2), .8))
        motion = SimpleNamespace(aircraft_mix=lambda t:[(0,.4),(1,.6)],
                                 trip=SimpleNamespace(legs=[SimpleNamespace(aircraft='a'),
                                                            SimpleNamespace(aircraft='b')]))
        with patch.object(aircraft, 'AIRCRAFT_MODE', 'cycles'), \
                patch.object(aircraft, '_cached_layer', side_effect=[first, second]):
            mixed = aircraft.plane_radiance(motion, 1., 30, size=(2,2))
        np.testing.assert_array_equal(mixed.alpha, alpha)
        np.testing.assert_allclose(mixed.depth, .56, atol=1e-7)

    def test_terrain_occlusion_uses_physical_footprint_and_local_height(self):
        aircraft = aircraft_module()
        from camera_geometry import EARTH_M
        seen = []
        def landscape(world):
            east_m = world[..., 0] * EARTH_M
            seen.append(float(np.max(np.abs(east_m))))
            # A distant ridge lies beneath the enlarged display model but
            # nowhere near the real 60m airframe parked at this airport.
            return np.where(np.abs(east_m) > 1000, 3000., 100.)
        for radius in (440., 1300.):
            alpha = np.ones((224,224,1), np.float32)
            layer = aircraft.AircraftLayer(np.ones((224,224,3)), alpha,
                aircraft.anchor_depth(radius, 105*12), 300., 5.)
            visible = aircraft.terrain_visibility(layer,radius,100.,12.,np.eye(3),landscape)
            self.assertTrue(visible.all())
            # A recorded low pass below the terrain must still be occluded.
            below = aircraft.terrain_visibility(layer,radius,100.,12.,np.eye(3),
                                                  lambda world: np.full(world.shape[:2],110.))
            self.assertFalse(below.any())
            # Geometry over a local ridge is clipped only on that ridge's side.
            partial = aircraft.terrain_visibility(layer,radius,100.,12.,np.eye(3),
                lambda world: np.where(world[...,0]>0,110.,100.))
            self.assertTrue(partial[:,:112].all())
            self.assertFalse(partial[:,112:].any())
        self.assertTrue(all(30 < extent < 60 for extent in seen), seen)

    def test_aircraft_cache_rejects_old_unseated_geometry(self):
        aircraft = aircraft_module()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/'old.npz'
            np.savez(path,schema_version=1,radiance=np.zeros((2,2,3)),
                     alpha=np.ones((2,2,1)),depth=np.ones((2,2)))
            with self.assertRaisesRegex(ValueError,'rebuild with Cycles'):
                aircraft._cached_layer(str(path))

    def test_aircraft_downsample_preserves_surface_height_at_coverage_edges(self):
        aircraft = aircraft_module()
        from camera_geometry import distance, EARTH_M
        # A diagonal partial-coverage edge exercises asymmetric filter weights.
        y,x = np.mgrid[:384,:384]
        alpha = np.clip((x+y-220)/3,0,1)[...,None].astype(np.float32)
        axial = distance(1300) - 1 - 100*12/EARTH_M
        depth = np.where(alpha[...,0]>0,axial/aircraft._crop_ray_cosine((384,384)),np.inf)
        layer = aircraft.AircraftLayer(np.repeat(alpha,3,-1),alpha,depth,300.,5.)
        resized = aircraft._resize_layer(layer,(224,224))
        heights = (distance(1300)-resized.depth*aircraft._crop_ray_cosine((224,224))-1)*EARTH_M/12
        np.testing.assert_allclose(heights[resized.alpha[...,0]>0],100.,atol=.012)

    def test_contact_precision_bound_scales_with_depth_and_vertical_scale(self):
        aircraft = aircraft_module()
        from camera_geometry import distance, EARTH_M
        for radius in (440.,1300.):
            for scale in (1.,12.):
                with self.subTest(radius=radius,scale=scale):
                    alpha=np.ones((384,384,1),np.float32)
                    axial=distance(radius)-1-100*scale/EARTH_M
                    layer=aircraft.AircraftLayer(np.zeros((384,384,3)),alpha,
                        axial/aircraft._crop_ray_cosine((384,384)),300.,5.)
                    layer=aircraft._resize_layer(layer,(224,224))
                    tolerance=layer.depth_error_earth*EARTH_M/scale
                    heights=(distance(radius)-layer.depth*aircraft._crop_ray_cosine((224,224))-1)*EARTH_M/scale
                    self.assertLessEqual(float(np.abs(heights-100).max()),tolerance)
                    visible=aircraft.terrain_visibility(layer,radius,95.,scale,np.eye(3),lambda world:100.)
                    self.assertTrue(visible.all())
                    buried=aircraft.terrain_visibility(layer,radius,95.,scale,np.eye(3),
                                                       lambda world:100.+3*tolerance)
                    self.assertFalse(buried.any())

    def test_aircraft_physical_footprint_accepts_real_batched_terrain_sampler(self):
        aircraft=aircraft_module()
        from scipy.io import netcdf_file
        from terrain_detail import TerrainSampler
        from motion import basis
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'terrain.nc'
            with netcdf_file(path,'w') as nc:
                nc.createDimension('latitude',3);nc.createDimension('longitude',4)
                nc.createVariable('latitude','f8',('latitude',))[:]=[-90,0,90]
                nc.createVariable('longitude','f8',('longitude',))[:]=[-180,-90,0,90]
                nc.createVariable('z','f4',('latitude','longitude'))[:]=100.
            sampler=TerrainSampler(path)
            layer=aircraft.AircraftLayer(np.zeros((224,224,3)),np.ones((224,224,1)),
                                         aircraft.anchor_depth(1300,105*12),300.,5.)
            visible=aircraft.terrain_visibility(layer,1300,100.,12.,basis(42,-88),sampler.sample)
            self.assertEqual(visible.shape,(224,224))
            self.assertTrue(visible.all())

    def test_aircraft_physical_footprint_is_independent_of_cache_resolution(self):
        aircraft=aircraft_module()
        from camera_geometry import distance,EARTH_M
        extents=[]
        for resolution in (112,224,384):
            alpha=np.ones((resolution,resolution,1),np.float32)
            axial=distance(1300)-1-105*12/EARTH_M
            layer=aircraft.AircraftLayer(np.zeros((resolution,resolution,3)),alpha,
                axial/aircraft._crop_ray_cosine((resolution,resolution)),300.,5.)
            def terrain(world):
                extents.append(float(np.max(np.abs(world[...,0])))*EARTH_M)
                return 100.
            self.assertTrue(aircraft.terrain_visibility(layer,1300,100.,12.,np.eye(3),terrain).all())
        # Only the half-pixel location of the outermost sample changes.
        self.assertLess(max(extents)-min(extents),.3)
        self.assertTrue(all(43 < extent < 44 for extent in extents),extents)


    def test_cycles_actual_z_pass_and_earth_depth_conversion(self):
        blender = shutil.which('blender')
        mac = Path('/Applications/Blender.app/Contents/MacOS/Blender')
        if blender is None and mac.is_file():
            blender = str(mac)
        if blender is None:
            self.skipTest('Blender not installed; numeric depth invariants still run.')
        with tempfile.TemporaryDirectory(prefix='flight-depth-regression-') as temporary:
            env = dict(os.environ, FLIGHT_AIRCRAFT_DIR=temporary)
            command = [blender, '-b', '-t', '2', '--python-exit-code', '1',
                       '--python', str(ENGINE/'aircraft_blender.py'), '--', '--validate-depth-only']
            result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads((Path(temporary)/'depth-validation.json').read_text())
            self.assertEqual(report['z_convention'], 'axial_camera_depth')
            self.assertLess(report['max_axial_error'], 1e-5)
            self.assertLess(report['max_export_surface_radius_error_earth'], 1e-7)
            self.assertGreater(report['contact_clearance_m'], 0)
            self.assertAlmostEqual(report['contact_clearance_m'], report['contact_clearance_expected_m'], places=6)
            self.assertLess(report['max_contact_radius_error_earth'], 1e-7)
            rotated=report['rotated_contact']
            self.assertLess(rotated['minimum_bound_box_z'],rotated['minimum_vertex_z']-.5)
            self.assertAlmostEqual(rotated['clearance_m'],rotated['expected_clearance_m'],places=6)
            self.assertLess(rotated['unrelated_scene_mesh_z'],rotated['minimum_vertex_z'])
            self.assertGreater(report['samples'][1]['ray_distance_if_that_convention'],
                               report['samples'][1]['z'] + .1)


    def test_invalid_transport_is_rejected(self):
        for transmission in [-.1, 1.1, np.nan]:
            with self.assertRaises(ValueError):
                TransportLayer(np.zeros((1,1,3)), np.full((1,1,1), transmission))
        with self.assertRaises(ValueError):
            TransportLayer(np.full((1,1,3), np.inf), np.ones((1,1,1)))


if __name__ == '__main__':
    unittest.main()

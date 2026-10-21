"""Chase orchestration boundaries without Blender, network, or a private bundle."""
from copy import deepcopy
from datetime import datetime,timedelta,timezone
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock,patch
import numpy as np

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts'
sys.path[:0]=[str(SCRIPTS),str(SCRIPTS/'engine')]
import chase_preview as preview
from chase_camera import enu_to_ecef
from trip import load_trip

EXAMPLE=SCRIPTS.parent/'examples/sample-single-leg.json'
BUNDLE={'schema_version':1,'surface_month':11,'assets':{
    'surface':{'path':'surface.png','sha256':'1'*64},
    'terrain':{'path':'terrain.nc','sha256':'2'*64}}}


def arguments(root,**updates):
    trip=load_trip(EXAMPLE)
    leg=trip.legs[0]
    midpoint=leg.depart+(leg.arrive-leg.depart)/2
    args=preview.parser().parse_args([str(EXAMPLE),'--assets',str(root/'assets'),
        '--at',midpoint.isoformat(),'--workdir',str(root/'work'),
        '--duration','1','--time-scale','1','--fps','12','--prepare-only'])
    for key,value in updates.items():setattr(args,key,value)
    return args


class ChasePreviewTests(unittest.TestCase):
    def test_actual_portrait_sizes_are_exact_even_nine_by_sixteen(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{}),\
                patch.object(preview,'validate_bundle',return_value=deepcopy(BUNDLE)),\
                patch.object(preview,'prepare_terrain') as terrain,\
                patch('chase_weather.bake_atlas',side_effect=AssertionError('Clear shot baked clouds')):
            root=Path(tmp)
            for width,height in ((180,320),(540,960),(1080,1920)):
                _,job=preview.prepare(arguments(root,width=width))
                self.assertEqual(job['size'],[width,height])
                self.assertEqual(width*16,height*9)
                self.assertEqual(width%2+height%2,0)
                self.assertEqual(len(job['frames']),12)
            self.assertEqual(terrain.call_count,3)

    def test_short_physical_shot_bounds_the_heading_lag(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{}),\
                patch.object(preview,'validate_bundle',return_value=deepcopy(BUNDLE)),\
                patch.object(preview,'prepare_terrain'):
            _,job=preview.prepare(arguments(Path(tmp),duration=1,time_scale=.1))
            self.assertEqual(len(job['frames']),12)
            self.assertLess(job['frames'][-1]['physical_seconds'],.1)

    def test_invalid_clocks_flights_and_sizes_fail_before_bundle_or_bake(self):
        trip=load_trip(EXAMPLE);leg=trip.legs[0]
        cases=[{'flight':0},{'flight':2},{'at':'2029-11-03T12:00:00'},
               {'at':'not-a-clock'}, {'at':(leg.depart-timedelta(seconds=1)).isoformat()},
               {'at':(leg.arrive-timedelta(seconds=.5)).isoformat()},
               {'duration':float('nan')},{'time_scale':float('inf')},
               {'duration':13},{'time_scale':0},{'width':192},{'width':179},
               {'fps':11},{'fps':61},{'bank':float('nan')},
               {'cloud_detail':-1},{'cloud_detail':1.01},{'cloud_detail':float('nan')},
               {'cloud_shape':-1},{'cloud_shape':1.01},{'cloud_shape':float('nan')},
               {'exposure':-4.1},{'exposure':4.1},{'exposure':float('inf')},
               {'frames':''},{'frames':'0,no'},{'frames':'-1'},{'frames':'12'},
               {'duration':12,'time_scale':20}]
        with tempfile.TemporaryDirectory() as tmp,\
                patch.object(preview,'validate_bundle',side_effect=AssertionError('Invalid shot read bundle')) as validate,\
                patch.object(preview,'prepare_terrain',side_effect=AssertionError('Invalid shot baked terrain')) as terrain,\
                patch('chase_weather.bake_atlas',side_effect=AssertionError('Invalid shot baked clouds')) as clouds:
            for values in cases:
                with self.subTest(values=values),self.assertRaises(ValueError):
                    preview.prepare(arguments(Path(tmp),**values))
            validate.assert_not_called();terrain.assert_not_called();clouds.assert_not_called()
            self.assertFalse((Path(tmp)/'work').exists())

    def test_physical_window_limit_fails_before_any_bake(self):
        # A short video can exceed the bounded physical duration after scaling.
        with tempfile.TemporaryDirectory() as tmp,\
                patch.object(preview,'validate_bundle',return_value=deepcopy(BUNDLE)),\
                patch.object(preview,'prepare_terrain',side_effect=AssertionError('Terrain baked')) as terrain,\
                patch('chase_weather.bake_atlas',side_effect=AssertionError('Clouds baked')) as clouds:
            with self.assertRaisesRegex(ValueError,'120'):
                preview.prepare(arguments(Path(tmp),duration=12,time_scale=20))
            terrain.assert_not_called();clouds.assert_not_called()
            self.assertFalse((Path(tmp)/'work').exists())

    def test_frame_clocks_and_sun_share_the_physical_time_scale(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{}),\
                patch.object(preview,'validate_bundle',return_value=deepcopy(BUNDLE)),\
                patch.object(preview,'prepare_terrain'):
            args=arguments(Path(tmp),duration=1,time_scale=6)
            _,job=preview.prepare(args)
            origin=datetime.fromisoformat(args.at)
            axes=np.array(preview.basis(job['origin']['lat'],job['origin']['lon']))
            for index in (0,6,11):
                frame=job['frames'][index]
                physical=origin+timedelta(seconds=index/12*6)
                self.assertEqual(datetime.fromisoformat(frame['physical_utc']),physical)
                self.assertEqual(frame['physical_seconds'],index/12*6)
                # Invert the prepared local light direction back to astronomy's
                # Earth-fixed direction; this catches ENU transpose/clock drift.
                np.testing.assert_allclose(np.array(frame['sun_enu'])@axes,
                                           preview.sun_direction(physical),atol=1e-12)
                self.assertGreaterEqual(frame['sun_visibility'],0)
                self.assertLessEqual(frame['sun_visibility'],1)

    def test_cache_reuse_restores_renderer_environment_without_rebaking(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{}),\
                patch.object(preview,'validate_bundle',return_value=deepcopy(BUNDLE)),\
                patch.object(preview,'prepare_terrain') as terrain:
            args=arguments(Path(tmp));work,first=preview.prepare(args)
            os.environ.update(FLIGHT_TRIP='/unrelated/trip.json',FLIGHT_ASSET_DIR='/unrelated/bundle',
                              FLIGHT_WORK_DIR='/unrelated/work',FLIGHT_COMPUTE='metal')
            repeated,second=preview.prepare(args)
            self.assertEqual(repeated,work);self.assertEqual(first,second)
            terrain.assert_called_once()
            self.assertEqual(os.environ['FLIGHT_TRIP'],str(args.trip.resolve()))
            self.assertEqual(os.environ['FLIGHT_ASSET_DIR'],str(args.assets.resolve()))
            self.assertEqual(os.environ['FLIGHT_WORK_DIR'],str(work))
            self.assertEqual(os.environ['FLIGHT_COMPUTE'],'cpu')

    def test_identical_relocated_bundle_reuses_bake_and_rebinds_surface(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{}),\
                patch.object(preview,'validate_bundle',return_value=deepcopy(BUNDLE)),\
                patch.object(preview,'prepare_terrain') as terrain:
            root=Path(tmp);args=arguments(root);work,_=preview.prepare(args)
            args.assets=root/'relocated-identical-assets'
            repeated,job=preview.prepare(args)
            self.assertEqual(repeated,work);terrain.assert_called_once()
            expected=str(args.assets.resolve()/'surface.png')
            self.assertEqual(job['surface_path'],expected)
            self.assertEqual(json.loads((work/'job.json').read_text())['surface_path'],expected)
            self.assertEqual(os.environ['FLIGHT_ASSET_DIR'],str(args.assets.resolve()))

    def test_terrain_uses_calibration_and_spherical_enu_with_continuous_uv(self):
        bundle=deepcopy(BUNDLE);bundle['calibration']={'path':'calibration/evidence.json'}
        sampler=Mock();sampler.sample.side_effect=lambda points:np.full(points.shape[:-1],500.)
        with tempfile.TemporaryDirectory() as tmp,\
                patch('terrain_detail.TerrainSampler',return_value=sampler) as factory:
            root=Path(tmp);assets=root/'assets'
            preview.prepare_terrain(root,assets,bundle,35.,179.99,extent=20000.,count=5)
            self.assertEqual(factory.call_args.args[2],assets/'calibration/evidence.json')
            with np.load(root/'terrain.npz') as data:
                vertices=data['vertices'];uv=data['uv'].reshape(5,5,2);faces=data['faces']
            world=enu_to_ecef(vertices,35.,179.99)
            np.testing.assert_allclose(np.linalg.norm(world,axis=-1),6371500.,atol=.01)
            np.testing.assert_allclose(vertices[12],[0,0,500],atol=1e-5)
            np.testing.assert_allclose(uv[2,2],[179.99/360+.5,35/180+.5],atol=1e-7)
            self.assertGreater(uv[-1,:,1].mean(),uv[0,:,1].mean()) # North is texture up.
            self.assertLess(np.max(np.abs(np.diff(uv[...,0],axis=1))),.01) # No dateline jump.
            normals=np.cross(vertices[faces[:,1]]-vertices[faces[:,0]],
                             vertices[faces[:,2]]-vertices[faces[:,0]])
            self.assertTrue(np.all(normals[:,2]>0))

    def test_terrain_edge_column_crossing_keeps_both_uv_axes_continuous(self):
        sampler=Mock();sampler.sample.side_effect=lambda points:np.zeros(points.shape[:-1])
        with tempfile.TemporaryDirectory() as tmp,patch('terrain_detail.TerrainSampler',return_value=sampler):
            root=Path(tmp)
            preview.prepare_terrain(root,root,BUNDLE,35.,-175.65,extent=400000.,count=193)
            with np.load(root/'terrain.npz') as data:
                u=data['uv'].reshape(193,193,2)[...,0]
            for axis in (0,1):
                self.assertLess(np.max(np.abs(np.diff(u,axis=axis))),.01)

    def test_surface_month_matches_first_departure_local_month(self):
        cases=[('LAX','AKL','2029-10-31T21:30:00-07:00','2029-11-02T07:30:00+13:00',10),
               ('AKL','LAX','2029-11-01T00:30:00+13:00','2029-10-31T18:30:00-07:00',11)]
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{}),\
                patch.object(preview,'validate_bundle',return_value=deepcopy(BUNDLE)) as validate,\
                patch.object(preview,'prepare_terrain'):
            root=Path(tmp)
            for origin,destination,departure,arrival,expected in cases:
                data=json.loads(EXAMPLE.read_text())
                data['flights'][0].update({'from':origin,'to':destination,'departure':departure,'arrival':arrival})
                path=root/'trip.json';path.write_text(json.dumps(data))
                leg=load_trip(path).legs[0];at=leg.depart+(leg.arrive-leg.depart)/2
                self.assertNotEqual(at.month,expected)
                preview.prepare(arguments(root,trip=path,at=at.isoformat()))
                self.assertEqual(validate.call_args.args[4],expected)

    def test_weather_bake_uses_replay_midpoint_and_matching_scene_bounds(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{}),\
                patch.object(preview,'validate_bundle',return_value=deepcopy(BUNDLE)),\
                patch.object(preview,'prepare_terrain'),\
                patch('chase_weather.configure_runtime') as runtime,\
                patch('chase_weather.bake_atlas',autospec=True) as bake:
            root=Path(tmp);data=json.loads(EXAMPLE.read_text())
            data['weather']={'mode':'illustrative_replay','sample_start':'2020-05-01T00:00:00Z',
                             'sample_end':'2020-05-02T00:00:00Z'}
            path=root/'trip.json';path.write_text(json.dumps(data));trip=load_trip(path)
            args=arguments(root,trip=path,duration=2,time_scale=6,cloudscape='local')
            marker=lambda *args,**kwargs:None
            runtime.return_value={'density_fn':marker,'height_exaggeration':12.,'source':{'fixture':True}}
            work,job=preview.prepare(args)
            midpoint=datetime.fromisoformat(args.at)+timedelta(seconds=6)
            expected=trip.weather_time(trip.presentation_time(midpoint,0))
            kwargs=bake.call_args.kwargs
            self.assertEqual(kwargs['weather_dt'],expected)
            self.assertEqual(kwargs['physical_dt'],midpoint)
            self.assertNotEqual(expected,midpoint)
            np.testing.assert_array_equal(np.asarray(kwargs['bounds_enu_m']).T,job['cloud_atlas']['bounds_enu_m'])
            self.assertEqual(kwargs['shape_zyx'],(64,160,160))
            self.assertIs(kwargs['density_fn'],marker)
            self.assertEqual(kwargs['height_exaggeration'],12.)
            self.assertFalse(kwargs['write_rgba'])
            self.assertEqual(bake.call_args.args[0],work/'cloud')

    def test_layered_clouds_share_weather_clock_warp_and_complementary_bounds(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{}),\
                patch.object(preview,'validate_bundle',return_value=deepcopy(BUNDLE)),\
                patch.object(preview,'prepare_terrain'),\
                patch('chase_weather.configure_runtime',return_value={}),\
                patch('chase_cloudscape.bake_atlas') as bake:
            root=Path(tmp);data=json.loads(EXAMPLE.read_text())
            data['weather']={'mode':'illustrative_replay','sample_start':'2020-05-01T00:00:00Z',
                             'sample_end':'2020-05-02T00:00:00Z'}
            path=root/'trip.json';path.write_text(json.dumps(data))
            bake.side_effect=[{'renderer_record':{'npz_path':'cloud.npz'}},
                              {'renderer_record':{'npz_path':'cloud-far.npz'}}]
            _,job=preview.prepare(arguments(root,trip=path,cloud_shape=.7))
            near,far=[call.kwargs for call in bake.call_args_list]
            for key in ('weather_dt','physical_dt','silhouette_strength','shape_zyx','layer_blend_m'):
                self.assertEqual(near[key],far[key])
            self.assertEqual(near['silhouette_strength'],.7)
            self.assertEqual(near['bounds_xyh_m'],[[-40000,40000],[-40000,40000],[120,16000]])
            self.assertEqual(far['bounds_xyh_m'],[[-500000,500000],[-500000,500000],[120,16000]])
            self.assertEqual(job['far_cloud_atlas']['npz_path'],'cloud-far.npz')
            self.assertEqual(job['atmosphere'],'volume')

    def test_atmosphere_and_exposure_have_distinct_cache_identity(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{}),\
                patch.object(preview,'validate_bundle',return_value=deepcopy(BUNDLE)),\
                patch.object(preview,'prepare_terrain'):
            root=Path(tmp)
            volume,one=preview.prepare(arguments(root,atmosphere='volume',exposure=1.5))
            sky,_=preview.prepare(arguments(root,atmosphere='sky',exposure=1.5))
            darker,_=preview.prepare(arguments(root,atmosphere='volume',exposure=0))
            self.assertEqual(len({volume,sky,darker}),3)
            self.assertEqual(one['exposure_ev'],1.5)
            self.assertIsNone(one['far_cloud_atlas'])
            default_volume, default_one = preview.prepare(arguments(root))
            _, default_sky = preview.prepare(arguments(root, atmosphere='sky'))
            self.assertEqual(default_volume, volume)
            self.assertEqual(default_one['exposure_ev'], 1.5)
            self.assertEqual(default_sky['exposure_ev'], 0.)

    def test_direct_solar_attenuation_is_finite_and_has_expected_spectral_order(self):
        for altitude in (1500.,10000.,15000.):
            zenith=np.array(preview.sun_transmission(altitude,1.))
            low=np.array(preview.sun_transmission(altitude,.1))
            self.assertTrue(np.all(np.isfinite(zenith)) and np.all(np.isfinite(low)))
            self.assertTrue(np.all((zenith>0)&(zenith<=1)))
            self.assertTrue(np.all(low<zenith))
            self.assertGreater(zenith[0],zenith[1]);self.assertGreater(zenith[1],zenith[2])
        self.assertTrue(np.all(np.array(preview.sun_transmission(15000.,1.))>
                               preview.sun_transmission(1500.,1.)))


if __name__=='__main__':unittest.main()

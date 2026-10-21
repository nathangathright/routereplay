"""Curved cloud horizons, bounded silhouette reconstruction, and LOD overlap."""
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np

SCRIPTS = Path(__file__).resolve().parents[1]/'skills/route-replay/scripts'
sys.path.insert(0, str(SCRIPTS))
import chase_cloudscape as cloud
from chase_weather import enu_to_ecef, enu_basis

NOW = datetime(2026,10,18,17,14,3,tzinfo=timezone.utc)


class ChaseCloudscapeTests(unittest.TestCase):
    def test_curved_coordinates_follow_height_and_roundtrip_at_far_horizon(self):
        points = np.array([[0,0,120], [500000,0,3000], [-500000,500000,16000],
                           [600000,-600000,10000]], float)
        enu = cloud.xyh_to_enu(points)
        np.testing.assert_allclose(cloud.enu_to_xyh(enu), points, atol=1e-9)
        self.assertLess(enu[1,2], -16000.)
        for latitude, longitude in ((-26.,-174.), (90.,180.), (-90.,-180.)):
            ecef = enu_to_ecef(enu, latitude, longitude)
            np.testing.assert_allclose(np.linalg.norm(ecef,axis=-1)-cloud.EARTH_M, points[:,2], atol=2e-9)

    def test_radial_sampler_changes_only_display_height_and_keeps_units_clock(self):
        points = np.array([[0,0,1000], [500000,500000,5000], [-350000,100000,13000]], float)
        calls=[]
        def sample(query, when, *, normals):
            calls.append((query.copy(),when,normals))
            return np.full(len(query),.002,np.float32), query
        sigma = cloud.sample_density(points, origin_lat_deg=-26., origin_lon_deg=-174., weather_dt=NOW,
            density_fn=sample, height_exaggeration=12., chunk_size=2)
        np.testing.assert_array_equal(sigma, np.full(3,.002,np.float32))
        query=np.concatenate([c[0] for c in calls])
        np.testing.assert_allclose((np.linalg.norm(query,axis=-1)-1)*cloud.EARTH_M/12.,points[:,2],atol=2e-9)
        physical=enu_to_ecef(cloud.xyh_to_enu(points),-26.,-174.)
        np.testing.assert_allclose(query/np.linalg.norm(query,axis=-1,keepdims=True),
            physical/np.linalg.norm(physical,axis=-1,keepdims=True),atol=1e-15)
        self.assertTrue(all(c[1]==NOW and c[2] is False for c in calls))
        self.assertEqual([len(c[0]) for c in calls],[2,1])

    def test_warp_is_monotone_bounded_and_preserves_radial_column_optical_depth(self):
        heights=np.linspace(120.,16000.,16001)
        direction=enu_basis(-26.,-174.)[2]
        physical=(cloud.EARTH_M+heights[:,None])*direction
        source,jacobian=cloud.warped_height(physical,1.)
        self.assertTrue(np.all(np.diff(source)>0))
        self.assertTrue(np.all(jacobian>0))
        self.assertLessEqual(np.max(np.abs(source-heights)),cloud.MAX_WARP_M+1e-8)
        np.testing.assert_allclose(source[[0,-1]],heights[[0,-1]],atol=2e-9)
        profile=lambda h: .001*np.exp(-((h-3500.)/700.)**2)
        original=np.trapezoid(profile(heights),heights)
        warped=np.trapezoid(profile(source)*jacobian,heights)
        self.assertAlmostEqual(original,warped,places=8)
        # Numeric derivative checks the extinction Jacobian, not just its sign.
        np.testing.assert_allclose(np.gradient(source,heights)[3:-3],jacobian[3:-3],rtol=2e-6,atol=1e-7)

    def test_shape_uses_earth_fixed_coordinates_without_seed_or_call_order_state(self):
        points=np.array([[15000,3000,3200],[5000,-5000,6000],[-15000,1000,9000]],float)
        ecef=enu_to_ecef(cloud.xyh_to_enu(points),0.,180.)
        first=cloud.warped_height(ecef,.85)
        repeated=cloud.warped_height(ecef[::-1],.85)
        for a,b in zip(first,repeated):np.testing.assert_array_equal(a,b[::-1])
        # ±180 are the same physical chart; shape does not seam at the date line.
        other=enu_to_ecef(cloud.xyh_to_enu(points),0.,-180.)
        for a,b in zip(first,cloud.warped_height(other,.85)):
            np.testing.assert_allclose(a,b,atol=3e-9)

    def test_clear_columns_stay_clear_but_cloud_top_can_change(self):
        points=np.stack([np.zeros(301),np.zeros(301),np.linspace(200.,6500.,301)],axis=-1)
        def clear(query,when,**unused):return np.zeros(len(query),np.float32)
        empty=cloud.sample_density(points,origin_lat_deg=-26.,origin_lon_deg=-174.,weather_dt=NOW,
            density_fn=clear,height_exaggeration=12.,silhouette_strength=1.)
        np.testing.assert_array_equal(empty,np.zeros(len(points)))
        # A neighboring cloudy column must never spread laterally into the
        # clear side while its vertical support is being reconstructed.
        mixed=np.array([[-10000.,0.,3000.],[10000.,0.,3000.]])
        def geographic_column(query,when,**unused):
            return np.where(query[:,1]>0,.001,0.)
        constrained=cloud.sample_density(mixed,origin_lat_deg=0.,origin_lon_deg=0.,weather_dt=NOW,
            density_fn=geographic_column,height_exaggeration=12.,silhouette_strength=1.)
        self.assertEqual(constrained[0],0.)
        self.assertGreater(constrained[1],0.)
        def slab(query,when,**unused):
            height=(np.linalg.norm(query,axis=-1)-1)*cloud.EARTH_M/12.
            return np.where((height>2500)&(height<3500),.001,0)
        kwargs=dict(origin_lat_deg=-26.,origin_lon_deg=-174.,weather_dt=NOW,
                    density_fn=slab,height_exaggeration=12.)
        baseline=cloud.sample_density(points,**kwargs,silhouette_strength=0.)
        shaped=cloud.sample_density(points,**kwargs,silhouette_strength=1.)
        self.assertTrue(np.any((baseline==0)&(shaped>0)))
        self.assertTrue(np.any((baseline>0)&(shaped==0)))

    def test_near_far_blend_is_complementary_and_outer_edge_smooth(self):
        x=np.linspace(-500000.,500000.,10001)
        points=np.stack((x,np.zeros_like(x)),axis=-1)
        near,far=cloud.layer_weights(points)
        interior=np.abs(x)<=450000.
        np.testing.assert_allclose((near+far)[interior],1.,atol=1e-15)
        self.assertTrue(np.all((near>=0)&(near<=1)&(far>=0)&(far<=1)))
        self.assertEqual(float(near[5000]),1.)
        self.assertEqual(float(far[5000]),0.)
        self.assertEqual(float(far[0]+near[0]),0.)
        self.assertEqual(float(far[-1]+near[-1]),0.)
        # Square corners use the same Chebyshev distance as axis-aligned nodes.
        corner=cloud.layer_weights([[34000.,34000.]])
        axis=cloud.layer_weights([[34000.,0.]])
        np.testing.assert_allclose(corner,axis)
        np.testing.assert_allclose(corner,[[.5],[.5]])
        a=cloud.layer_weights([[40000.-.01,0.]])
        b=cloud.layer_weights([[40000.+.01,0.]])
        np.testing.assert_allclose(a,b,atol=1e-12)

    def test_bake_records_radial_mapping_and_enclosing_geometry_without_edge_fade(self):
        def constant(query,when,**unused):return np.full(len(query),.001,np.float32)
        bounds=[[-500000,500000],[-500000,500000],[120,16000]]
        with tempfile.TemporaryDirectory() as tmp:
            prefix=Path(tmp)/'far'
            metadata=cloud.bake_atlas(prefix,origin_lat_deg=-26.,origin_lon_deg=-174.,bounds_xyh_m=bounds,
                shape_zyx=(4,5,6),weather_dt=NOW,physical_dt=NOW+timedelta(days=2),
                density_fn=constant,height_exaggeration=12.,write_rgba=True)
            self.assertEqual(metadata['weather_utc'],NOW.isoformat())
            self.assertNotEqual(metadata['physical_utc'],metadata['weather_utc'])
            self.assertFalse(metadata['edge_fade_baked'])
            self.assertEqual(metadata['renderer_record']['coordinate_system'],'enu_xy_radial_height')
            self.assertEqual(metadata['renderer_record']['bounds_xyh_m'],bounds)
            self.assertEqual(metadata['renderer_record']['npz_path'],'far.npz')
            with np.load(prefix.with_suffix('.npz')) as data:
                self.assertEqual(data['density'].shape,(4,5,6))
                np.testing.assert_array_equal(data['density'],np.full((4,5,6),.001,np.float32))
                xx,yy,hh=np.meshgrid(data['x_m'],data['y_m'],data['height_m'],indexing='ij')
                scene=cloud.xyh_to_enu(np.stack((xx,yy,hh),axis=-1))
                box=np.array(metadata['scene_bounds_enu_m'])
                self.assertTrue(np.all(scene>=box[0]-1e-8))
                self.assertTrue(np.all(scene<=box[1]+1e-8))
            self.assertEqual(json.loads(prefix.with_suffix('.json').read_text()),metadata)
            self.assertTrue(prefix.with_suffix('.rgba.f32').is_file())

    def test_recorded_blend_survives_different_grid_resolutions(self):
        blend=cloud.layer_blend(50000.,400000.)
        near_x=np.linspace(-50000.,50000.,160)
        far_x=np.linspace(-400000.,400000.,160)
        sample_x=np.linspace(35000.,50000.,1001)
        points=np.stack((sample_x,np.zeros_like(sample_x)),axis=-1)
        near,far=cloud.layer_weights(points,blend=blend)
        # A constant base medium is unchanged when each grid is sampled first
        # and the same analytic physical-point ramps are applied afterward.
        near_base=np.interp(sample_x,near_x,np.ones_like(near_x))
        far_base=np.interp(sample_x,far_x,np.ones_like(far_x))
        np.testing.assert_allclose(near_base*near+far_base*far,1.,atol=1e-15)
        # This detects the reviewed failure: pre-baking weights on mismatched
        # grids is not equivalent to evaluating them after density sampling.
        near_nodes=cloud.layer_weights(np.stack((near_x,np.zeros_like(near_x)),axis=-1),blend=blend)[0]
        far_nodes=cloud.layer_weights(np.stack((far_x,np.zeros_like(far_x)),axis=-1),blend=blend)[1]
        wrong=np.interp(sample_x,near_x,near_nodes)+np.interp(sample_x,far_x,far_nodes)
        self.assertGreater(np.max(np.abs(wrong-1.)),.02)
        with tempfile.TemporaryDirectory() as tmp:
            kwargs=dict(origin_lat_deg=0.,origin_lon_deg=0.,weather_dt=NOW,
                density_fn=lambda q,*a,**k:np.zeros(len(q)),height_exaggeration=12.,
                shape_zyx=(3,4,5),layer_blend_m=blend)
            metadata=cloud.bake_atlas(Path(tmp)/'paired',bounds_xyh_m=[[-50000,50000],[-50000,50000],[120,16000]],**kwargs)
            self.assertEqual(metadata['renderer_record']['layer_blend_m'],blend)
            with self.assertRaisesRegex(ValueError,'recorded blend extents'):
                cloud.bake_atlas(Path(tmp)/'wrong',bounds_xyh_m=[[-40000,40000],[-40000,40000],[120,16000]],**kwargs)

    def test_invalid_extents_strength_and_density_fail(self):
        with self.assertRaises(ValueError):cloud.xyh_to_enu([[600001,0,1000]])
        with self.assertRaises(ValueError):cloud.xyh_to_enu([[0,0,-501]])
        with self.assertRaises(ValueError):cloud.layer_weights([[0,0]],near_extent_m=500000)
        for strength in (-.1,1.1,float('nan')):
            with self.subTest(strength=strength),self.assertRaises(ValueError):
                cloud.warped_height([[cloud.EARTH_M+1000,0,0]],strength)
        with self.assertRaisesRegex(ValueError,'nonnegative'):
            cloud.sample_density([[0,0,1000]],origin_lat_deg=0,origin_lon_deg=0,weather_dt=NOW,
                density_fn=lambda q,*a,**k:np.full(len(q),-.1),height_exaggeration=12.)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError,'2000000'):
                cloud.bake_atlas(Path(tmp)/'bad',origin_lat_deg=0,origin_lon_deg=0,
                    bounds_xyh_m=[[-500000,500000],[-500000,500000],[120,16000]],
                    shape_zyx=(128,256,256),weather_dt=NOW,density_fn=lambda *a:None,height_exaggeration=12.)
            self.assertFalse(list(Path(tmp).iterdir()))


if __name__=='__main__':unittest.main()

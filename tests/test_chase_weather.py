"""Physical coordinates and lossless offline layout for local cloud prototypes."""
from datetime import datetime,timezone,timedelta
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import numpy as np

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/route-replay/scripts'
sys.path.insert(0,str(SCRIPTS))
import chase_weather as chase

NOW=datetime(2026,10,17,23,30,tzinfo=timezone.utc)


class ChaseWeatherTests(unittest.TestCase):
    def test_enu_basis_and_physical_curvature_at_dateline_and_poles(self):
        points=np.array([[0,0,1500],[10000,0,1500],[0,15000,1500]],float)
        for latitude,longitude in ((42.,-89.),(90.,180.),(-90.,-180.),(0.,180.)):
            basis=chase.enu_basis(latitude,longitude)
            np.testing.assert_allclose(basis@basis.T,np.eye(3),atol=1e-14)
            ecef=chase.enu_to_ecef(points,latitude,longitude)
            np.testing.assert_allclose((ecef-chase.EARTH_M*basis[2])@basis.T,points,atol=1e-9)
            altitude=np.linalg.norm(ecef,axis=1)-chase.EARTH_M
            self.assertAlmostEqual(altitude[0],1500,places=8)
            self.assertGreater(altitude[1],1500)
        np.testing.assert_allclose(chase.enu_to_ecef(points,0,180),chase.enu_to_ecef(points,0,-180),atol=2e-9)

    def test_display_mapping_changes_only_radial_height(self):
        ecef=chase.enu_to_ecef([[12000,-4000,5500]],41.,-90.)
        query=chase.physical_to_display(ecef,12.)
        np.testing.assert_allclose(query/np.linalg.norm(query,axis=1)[:,None],ecef/np.linalg.norm(ecef,axis=1)[:,None],atol=1e-15)
        np.testing.assert_allclose((np.linalg.norm(query,axis=1)-1)*chase.EARTH_M/12,np.linalg.norm(ecef,axis=1)-chase.EARTH_M,atol=1e-9)
        np.testing.assert_allclose(chase.physical_to_display(ecef,1.),ecef/chase.EARTH_M,atol=1e-15)

    def test_density_keeps_physical_units_and_weather_clock_across_chunks(self):
        calls=[];points=np.array([[i*100.,0,1000.] for i in range(17)])
        def density(query,when,*,normals):
            calls.append((len(query),when,normals))
            return np.full(len(query),.002,np.float32),np.zeros_like(query)
        first=chase.sample_density(points,origin_lat_deg=42,origin_lon_deg=-89,weather_dt=NOW,
                                   density_fn=density,height_exaggeration=12.,chunk_size=5)
        self.assertTrue(all(n<=5 and when==NOW and normals is False for n,when,normals in calls))
        np.testing.assert_array_equal(first,np.full(17,.002,np.float32))
        shuffled=chase.sample_density(points[::-1],origin_lat_deg=42,origin_lon_deg=-89,weather_dt=NOW,
                                      density_fn=density,height_exaggeration=12.)
        np.testing.assert_array_equal(first,shuffled[::-1])

    def test_atlas_slices_gutters_and_float_raw_roundtrip(self):
        density=np.arange(3*4*5,dtype=np.float32).reshape(3,4,5)*1e-6
        atlas,layout=chase.tiled_rgba(density)
        self.assertEqual(layout['slice_stride_xy'],[7,6]);self.assertEqual(layout['tiles_x'],2)
        for k in range(3):
            x,y=(k%2)*7,(k//2)*6
            np.testing.assert_array_equal(atlas[y+1:y+5,x+1:x+6,0],density[k])
            np.testing.assert_array_equal(atlas[y,x+1:x+6,0],density[k,0])
            np.testing.assert_array_equal(atlas[y+5,x+1:x+6,0],density[k,-1])
            np.testing.assert_array_equal(atlas[y+1:y+5,x,0],density[k,:,0])
        np.testing.assert_array_equal(atlas[...,0],atlas[...,2])
        self.assertTrue(np.all(atlas[...,3]==1))

    def test_bake_preserves_clocks_axes_and_optical_depth(self):
        query_times=[]
        def density(query,when,**unused):
            query_times.append(when)
            return np.full(len(query),.001,np.float32),query
        with tempfile.TemporaryDirectory() as tmp:
            prefix=Path(tmp)/'cloud'
            metadata=chase.bake_atlas(prefix,origin_lat_deg=42.,origin_lon_deg=-89.,bounds_enu_m=[[-6000,6000],[-6000,6000],[1000,5000]],
                                      shape_zyx=(5,7,9),weather_dt=NOW,physical_dt=NOW+timedelta(days=1),
                                      density_fn=density,height_exaggeration=12.,source={'fixture':'constant extinction'})
            self.assertTrue(all(t==NOW for t in query_times))
            self.assertEqual(metadata['weather_utc'],NOW.isoformat())
            self.assertNotEqual(metadata['physical_utc'],metadata['weather_utc'])
            self.assertAlmostEqual(metadata['density_statistics']['vertical_tau_mean'],4.,places=6)
            self.assertEqual(metadata['density_gain'],1.)
            with np.load(prefix.with_suffix('.npz')) as data:
                self.assertEqual(data['density'].shape,(5,7,9))
                self.assertEqual(data['density'].dtype,np.float32)
                self.assertEqual(list(data['z_m']),[1000,2000,3000,4000,5000])
                expected,layout=chase.tiled_rgba(data['density'])
            actual=np.fromfile(prefix.with_suffix('.rgba.f32'),dtype='<f4').reshape(expected.shape)
            np.testing.assert_array_equal(actual,expected)
            self.assertEqual(json.loads(prefix.with_suffix('.json').read_text()),metadata)

    def test_replaced_environment_cannot_disguise_an_already_loaded_trip(self):
        from trip import load_trip
        example=SCRIPTS.parent/'examples/sample-single-leg.json'
        loaded=load_trip(example)
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);changed=loaded.to_dict();changed['title']='A different itinerary'
            path=root/'changed.json';path.write_text(json.dumps(changed))
            runtime=SimpleNamespace(TRIP=loaded,ASSETS=root,WORK=root,BUNDLE={})
            # This is what prepare() does before invoking configure_runtime.
            with patch.dict(sys.modules,{'runtime':runtime}),patch.dict(chase.os.environ,{'FLIGHT_TRIP':str(path)}):
                with self.assertRaisesRegex(ValueError,'fresh process'):
                    chase.configure_runtime(path,root,root)

    def test_bounds_invalid_density_and_naive_dates_fail(self):
        with self.assertRaisesRegex(ValueError,'timezone-aware'):
            chase.sample_density([[0,0,1000]],origin_lat_deg=0,origin_lon_deg=0,weather_dt=NOW.replace(tzinfo=None),
                                 density_fn=lambda *a,**k:None,height_exaggeration=12.)
        for bad in (np.nan,-.1):
            with self.subTest(sigma=bad),self.assertRaisesRegex(ValueError,'nonnegative'):
                chase.sample_density([[0,0,1000]],origin_lat_deg=0,origin_lon_deg=0,weather_dt=NOW,
                                     density_fn=lambda q,*a,**k:np.full(len(q),bad),height_exaggeration=12.)
        with tempfile.TemporaryDirectory() as tmp:
            for shape,bounds in (((256,256,256),[[-1000,1000],[-1000,1000],[0,10000]]),
                                 ((8,8,8),[[-61000,1000],[-1000,1000],[0,10000]])):
                with self.subTest(shape=shape),self.assertRaises(ValueError):
                    chase.bake_atlas(Path(tmp)/'bad',origin_lat_deg=0,origin_lon_deg=0,
                                     shape_zyx=shape,bounds_enu_m=bounds,weather_dt=NOW)


if __name__=='__main__':unittest.main()

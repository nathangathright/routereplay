"""Actual environmental file consumption, temporal interpolation and light response."""
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

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts'
sys.path[:0]=[str(SCRIPTS),str(SCRIPTS/'engine')]
import environmental_data as data
import environmentlighting as lighting


class EnvironmentLightingTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.start=datetime(2026,1,1,tzinfo=timezone.utc)
        self.end=self.start+timedelta(hours=3)
        self.runtime=SimpleNamespace(ASSETS=self.root,BUNDLE={'environment':{}})
        module=patch.dict(sys.modules,{'runtime':self.runtime})
        module.start();self.addCleanup(module.stop)

    def write(self,kind,fields):
        source={'url':'https://example.org/source','credit':'Synthetic regression fixture',
                'license_url':'https://example.org/license','notes':'Modeled test values'}
        meta={'schema_version':1,'kind':kind,'source_kind':'modeled','source':source,
              'units':{name:'1' for name in fields},'conversion':'Synthetic test fixture',
              'original_files':[{'name':'fixture','sha256':'0'*64,'bytes':1}]}
        path=self.root/(kind+'.npz')
        data.write_environment(path,[90,0,-90],[0,90,180,270],
            [self.start.timestamp(),self.end.timestamp()],
            {key:np.broadcast_to(np.asarray(value)[:,None,None],(2,3,4)) for key,value in fields.items()},meta)
        self.runtime.BUNDLE['environment'][kind]={'path':path.name}

    def test_no_product_identity_and_dated_aod_changes_rgb_extinction(self):
        point=np.array([[1.,0.,0.]])
        np.testing.assert_array_equal(lighting.aerosol_incident(point,point,self.start),1)
        self.write('aerosol',{'aod550':[0.,1.]})
        empty=lighting.aerosol_incident(point,point,self.start)
        mid=lighting.aerosol_incident(point,point,self.start+timedelta(hours=1.5))
        heavy=lighting.aerosol_incident(point,point,self.end)
        np.testing.assert_array_equal(empty,1)
        self.assertTrue(np.all(heavy<mid))
        self.assertTrue(np.all(mid<1))
        self.assertGreater(heavy[0,0],heavy[0,1])
        self.assertGreater(heavy[0,1],heavy[0,2])
        with self.assertRaisesRegex(ValueError,'outside'):
            lighting.aerosol_incident(point,point,self.end+timedelta(seconds=1))

    def test_configured_product_imports_runtime_instead_of_disappearing(self):
        self.runtime.BUNDLE['environment']['aerosol']={'path':'column.npz'}
        with patch.dict(sys.modules):
            sys.modules.pop('runtime',None)
            with patch.dict(os.environ,{'FLIGHT_ASSET_DIR':str(self.root)}), \
                 patch.object(lighting.importlib,'import_module',return_value=self.runtime) as load:
                self.assertEqual(lighting.product('aerosol'),self.root/'column.npz')
                load.assert_called_once_with('runtime')
            with patch.dict(os.environ,{},clear=True):
                self.assertIsNone(lighting.product('aerosol'))

    def test_immutable_product_sampler_is_bound_once_per_weather_instant(self):
        self.write('aerosol',{'aod550':[.3,.6]})
        lighting._frame_sampler.cache_clear()
        with patch.object(data,'prepared_environment_sampler',
                          wraps=data.prepared_environment_sampler) as prepare:
            a=lighting.aerosol_coefficients([[1.,0.,0.]],self.start)
            b=lighting.aerosol_coefficients([[1.,0.,0.]],self.start)
            c=lighting.aerosol_coefficients([[1.,0.,0.]],self.end)
            self.assertEqual(prepare.call_count,2)
            np.testing.assert_array_equal(a,b)
            np.testing.assert_allclose(c,a*2)

    def test_vertical_integral_recovers_column_and_altitude_reduces_density(self):
        self.write('aerosol',{'aod550':[.3,.3]})
        points=np.array([[1.,0.,0.],[1+lighting.AEROSOL_HEIGHT_KM/6371,0,0.]])
        sigma=lighting.aerosol_coefficients(points,self.start)
        np.testing.assert_allclose(sigma[1],sigma[0]/np.e,rtol=1e-10)
        tau=lighting.aerosol_optical_depth(points[:1],[[1,0,0]],np.array([.03]),self.start,samples=1000)
        self.assertAlmostEqual(tau[0,1],.3,places=4)

    def test_aerosol_depth_broadcasts_scalar_rays_over_length_arrays(self):
        self.write('aerosol',{'aod550':[.3,.3]})
        point=np.array([1.,0.,0.]);direction=np.array([1.,0.,0.])
        lengths=np.array([0.,.00001,.001,.01,.03])
        for shape in ((5,),(1,5),(5,1)):
            with self.subTest(shape=shape):
                actual=lighting.aerosol_optical_depth(
                    point,direction,lengths.reshape(shape),self.start)
                self.assertEqual(actual.shape,shape+(3,))
                explicit=lighting.aerosol_optical_depth(
                    np.broadcast_to(point,(5,3)),np.broadcast_to(direction,(5,3)),
                    lengths,self.start)
                np.testing.assert_allclose(actual.reshape(5,3),explicit,rtol=1e-12)
                expected=.3*(-np.expm1(-lengths*lighting.EARTH_KM/lighting.AEROSOL_HEIGHT_KM))
                np.testing.assert_allclose(actual.reshape(5,3)[:,1],expected,rtol=2e-4,atol=1e-8)
        empty=lighting.aerosol_optical_depth(
            np.empty((0,3)),direction,np.empty(0),self.start)
        self.assertEqual(empty.shape,(0,3))

    def test_camera_aerosol_column_is_preserved_at_each_quality_budget(self):
        self.write('aerosol',{'aod550':[.3,.3]})
        self.runtime.TRIP=SimpleNamespace(style={'moonlight':0})
        # Keep this private module isolated from other transport fixtures. Zero
        # baseline air so its coarse quadrature cannot hide lost aerosol mass.
        spec=importlib.util.spec_from_file_location(
            '_aerosol_column_test_atmosphere',SCRIPTS/'engine/atmosphere.py')
        air=importlib.util.module_from_spec(spec);spec.loader.exec_module(air)
        with patch.dict(os.environ,{'FLIGHT_COMPUTE':'cpu'}),\
             patch.object(air,'BETA_R',np.zeros(3)),\
             patch.object(air,'BETA_M',0.),patch.object(air,'MIE_EXTINCTION',0.):
            for budget in (12,24,40):
                with self.subTest(view_samples=budget):
                    _,transmission=air.integrate_atmosphere_rays(
                        [1.2,0,0],[[-1,0,0]],[1,0,0],view_samples=budget,
                        sun_samples=6,weather_dt=self.start,moon_gain=0)
                    self.assertAlmostEqual(float(-np.log(transmission[0,1])),.3,places=4)

    def test_sparse_camera_shells_preserve_oblique_and_tangent_extinction(self):
        self.write('aerosol',{'aod550':[.3,.3]})
        self.runtime.TRIP=SimpleNamespace(style={'moonlight':0})
        spec=importlib.util.spec_from_file_location(
            '_aerosol_tangent_test_atmosphere',SCRIPTS/'engine/atmosphere.py')
        air=importlib.util.module_from_spec(spec);spec.loader.exec_module(air)
        from camera_geometry import sphere_interval
        impact=np.array([0.,.5,.99,1.0001,1.001,1.005,1.01,1.02])
        origins=np.column_stack((np.full(len(impact),1.2),impact,np.zeros(len(impact))))
        rays=np.broadcast_to([-1.,0.,0.],origins.shape)
        near,far,_=sphere_interval(origins,rays,air.OUTER_KM/air.EARTH_KM)
        ground,_,hit=sphere_interval(origins,rays,1.)
        end=np.where(hit,np.minimum(ground,far),far)
        nodes,weights=np.polynomial.legendre.leggauss(256)
        distance=(near[:,None]+end[:,None])*.5+(end-near)[:,None]*nodes*.5
        points=origins[:,None,:]+rays[:,None,:]*distance[...,None]
        height=(np.linalg.norm(points,axis=-1)-1)*lighting.EARTH_KM
        expected=(np.exp(-height/lighting.AEROSOL_HEIGHT_KM)@weights
                  *(end-near)*lighting.EARTH_KM*.5*.3/lighting.AEROSOL_HEIGHT_KM)
        with patch.dict(os.environ,{'FLIGHT_COMPUTE':'cpu'}), \
             patch.object(air,'BETA_R',np.zeros(3)), \
             patch.object(air,'BETA_M',0.),patch.object(air,'MIE_EXTINCTION',0.):
            for budget in (12,24,40):
                _,transmission=air.integrate_atmosphere_rays(
                    origins,rays,[1,0,0],view_samples=budget,sun_samples=6,
                    weather_dt=self.start,moon_gain=0)
                np.testing.assert_allclose(-np.log(transmission[:,1]),expected,
                                           rtol=2e-3,atol=1e-5)

    def test_snow_and_ice_affect_only_their_surface_and_suppress_glint(self):
        self.write('surface_conditions',{'snow_fraction':[0,1],'sea_ice_fraction':[0,1]})
        land=np.array([[1.],[0.]])
        albedo=np.full((2,3),.1);lon=np.array([0.,np.pi]);lat=np.zeros(2)
        start,water=lighting.surface_conditions(albedo,land,lon,lat,self.start)
        np.testing.assert_allclose(start,albedo);np.testing.assert_array_equal(water,1-land)
        end,water=lighting.surface_conditions(albedo,land,lon,lat,self.end)
        np.testing.assert_allclose(end,np.stack([lighting.SNOW_ALBEDO,lighting.ICE_ALBEDO]))
        np.testing.assert_array_equal(water,0)


if __name__=='__main__':unittest.main()

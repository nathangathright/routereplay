"""Fixed-input source and clear-sky checks for shared cloud lighting."""
from pathlib import Path
import importlib
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

ENGINE=Path(__file__).resolve().parents[1]/'skills/route-replay/scripts/engine'
sys.path.insert(0,str(ENGINE))
_names=('runtime','atmosphere','cloudlighting')
_saved={name:sys.modules.get(name) for name in _names}
for _name in _names:sys.modules.pop(_name,None)
sys.modules['runtime']=SimpleNamespace(TRIP=SimpleNamespace(style={}))
try:
    air=importlib.import_module('atmosphere')
    lighting=importlib.import_module('cloudlighting')
finally:
    for _name,_module in _saved.items():
        if _module is None:sys.modules.pop(_name,None)
        else:sys.modules[_name]=_module


class SolarSourceTests(unittest.TestCase):
    def test_visibility_is_linear_and_zero_has_no_solar_floor(self):
        tau=np.array([0.,.2,2.,8.]);rgb=np.broadcast_to([.9,.6,.3],(4,3))
        mu=np.array([-1.,-.2,.4,1.])
        for gain in (0.,1.,4.):
            with self.subTest(multiple_scattering=gain):
                full=lighting.solar_source(tau,rgb,np.ones(4),mu,multiple_scattering=gain)
                half=lighting.solar_source(tau,rgb,np.full(4,.5),mu,multiple_scattering=gain)
                dark=lighting.solar_source(tau,rgb,np.zeros(4),mu,multiple_scattering=gain)
                np.testing.assert_allclose(half,.5*full,rtol=1e-6,atol=1e-8)
                np.testing.assert_array_equal(dark,0.)

    def test_direct_cloud_extinction_is_monotone_and_opaque_limit_is_dark(self):
        tau=np.array([0.,.5,2.,8.,1000.]);rgb=np.ones((5,3));mu=np.zeros(5)
        direct=lighting.solar_source(tau,rgb,np.ones(5),mu,multiple_scattering=0.)
        self.assertTrue(np.all(np.diff(direct,axis=0)<=0))
        self.assertTrue(np.all(direct[0]>direct[1]))
        for gain in (0.,1.,4.):
            opaque=lighting.solar_source(np.array([1000.]),np.ones((1,3)),np.ones(1),
                                         np.zeros(1),multiple_scattering=gain)
            np.testing.assert_allclose(opaque,0.,atol=1e-12)

    def test_direct_preserves_rgb_air_attenuation(self):
        tau=np.array([.1,2.]);mu=np.array([-.3,.6]);visibility=np.ones(2)
        transmission=np.array([[.8,.35,.05],[.6,.2,0.]])
        white=lighting.solar_source(tau,np.ones((2,3)),visibility,mu,multiple_scattering=0.)
        colored=lighting.solar_source(tau,transmission,visibility,mu,multiple_scattering=0.)
        np.testing.assert_allclose(colored,white*transmission,rtol=1e-6,atol=1e-8)
        self.assertGreater(float(colored[0,0]),float(colored[0,2]))
        self.assertEqual(float(colored[1,2]),0.)

    def test_multiple_scattering_adds_light_without_an_unattenuated_floor(self):
        tau=np.array([.5,2.,5.]);rgb=np.ones((3,3));mu=np.array([-.8,0.,.3])
        single=lighting.solar_source(tau,rgb,np.ones(3),mu,multiple_scattering=0.)
        multiple=lighting.solar_source(tau,rgb,np.ones(3),mu,multiple_scattering=1.)
        self.assertTrue(np.all(multiple>=single))
        self.assertGreater(float(np.max(multiple-single)),1e-6)
        extinguished=lighting.solar_source(tau,np.zeros((3,3)),np.ones(3),mu,multiple_scattering=4.)
        np.testing.assert_array_equal(extinguished,0.)

    def test_phase_is_finite_nonnegative_isotropic_at_zero_and_unclipped(self):
        mu=np.array([-1.,0.,1.]);tau=np.zeros(3);rgb=np.ones((3,3))
        isotropic=lighting.solar_source(tau,rgb,np.ones(3),mu,phase_g=0.,multiple_scattering=0.)
        np.testing.assert_allclose(isotropic,np.broadcast_to(isotropic[0],isotropic.shape),rtol=1e-6)
        forward=lighting.solar_source(tau,rgb,np.ones(3),mu,phase_g=.95,multiple_scattering=0.)
        self.assertTrue(np.all(np.isfinite(forward)));self.assertTrue(np.all(forward>=0))
        self.assertGreater(float(forward[-1].max()),1.)
        self.assertGreater(float(forward[-1].sum()),float(forward[0].sum()))

    def test_reordered_inputs_and_repeated_calls_are_identical(self):
        tau=np.array([0.,.2,1.,10.]);rgb=np.array([[1.,.8,.4],[.3,.2,.1],[.8,.6,.5],[1.,1.,1.]])
        visibility=np.array([1.,.5,0.,.2]);mu=np.array([-1.,-.4,.7,1.]);order=np.array([3,1,0,2])
        inputs=[x.copy() for x in (tau,rgb,visibility,mu)]
        first=lighting.solar_source(tau,rgb,visibility,mu)
        reordered=lighting.solar_source(tau[order],rgb[order],visibility[order],mu[order])
        repeated=lighting.solar_source(tau,rgb,visibility,mu)
        np.testing.assert_array_equal(reordered,first[order])
        np.testing.assert_array_equal(repeated,first)
        for actual,original in zip((tau,rgb,visibility,mu),inputs):
            np.testing.assert_array_equal(actual,original)


class SkySamplesTests(unittest.TestCase):
    def setUp(self):
        modules=patch.dict(sys.modules,{'atmosphere':air})
        modules.start();self.addCleanup(modules.stop)
        self.point=np.array([[1+1500.*12/6_371_000.,0.,0.]])

    @staticmethod
    def sun(elevation):
        angle=np.radians(elevation)
        return np.array([np.sin(angle),np.cos(angle),0.])

    def test_samples_are_upward_finite_and_day_twilight_night_are_coherent(self):
        levels=[]
        for elevation in (90.,-3.,-90.):
            directions,incoming,weights=lighting.sky_samples(self.point,self.sun(elevation))
            self.assertEqual(directions.shape,(1,3,3));self.assertEqual(incoming.shape,(1,3,3))
            self.assertEqual(np.asarray(weights).shape,(3,))
            self.assertTrue(np.all(np.isfinite(incoming)));self.assertTrue(np.all(incoming>=0))
            self.assertTrue(np.all(np.isfinite(weights)));self.assertTrue(np.all(np.asarray(weights)>0))
            self.assertAlmostEqual(float(np.sum(weights)),2*np.pi,places=6)
            np.testing.assert_allclose(np.linalg.norm(directions,axis=-1),1.,atol=1e-6)
            self.assertTrue(np.all(directions[...,0]>=-1e-7))
            levels.append(float(np.sum(incoming*np.asarray(weights)[None,:,None])))
        self.assertGreater(levels[0],levels[1]);self.assertGreater(levels[1],levels[2])
        self.assertLess(levels[2],max(levels[0]*1e-5,1e-10))

    def test_strength_and_saturation_controls_have_no_added_floor(self):
        _,full,_=lighting.sky_samples(self.point,self.sun(20.))
        _,half,_=lighting.sky_samples(self.point,self.sun(20.),strength=.5)
        _,zero,_=lighting.sky_samples(self.point,self.sun(20.),strength=0.)
        _,gray,_=lighting.sky_samples(self.point,self.sun(20.),saturation=0.)
        np.testing.assert_allclose(half,.5*full,rtol=1e-6,atol=1e-8)
        np.testing.assert_array_equal(zero,0.)
        np.testing.assert_allclose(gray[...,0],gray[...,1],rtol=1e-6,atol=1e-8)
        np.testing.assert_allclose(gray[...,1],gray[...,2],rtol=1e-6,atol=1e-8)

    def test_twilight_changes_smoothly_with_small_solar_motion(self):
        values=[lighting.sky_samples(self.point,self.sun(elevation))[1] for elevation in (-3.01,-3.,-2.99)]
        scale=max(float(np.linalg.norm(values[1])),1e-8)
        self.assertLess(float(np.linalg.norm(values[2]-values[0])),.05*scale+1e-8)
        self.assertLess(float(np.linalg.norm(values[1]-.5*(values[0]+values[2]))),.01*scale+1e-8)

    def test_sky_queries_are_independent_of_order_and_previous_sun(self):
        points=np.array([[1.003,0.,0.],[0.,1.01,0.],[0.,0.,1.002]])
        sun=np.array([2.,.8,.4]);original_sun=sun.copy();original_points=points.copy();order=np.array([2,0,1])
        first=lighting.sky_samples(points,sun)
        lighting.sky_samples(points,-sun)
        reordered=lighting.sky_samples(points[order],sun)
        repeated=lighting.sky_samples(points,sun)
        for index in (0,1):
            np.testing.assert_array_equal(reordered[index],first[index][order])
            np.testing.assert_array_equal(repeated[index],first[index])
        np.testing.assert_array_equal(reordered[2],first[2])
        np.testing.assert_array_equal(sun,original_sun)
        np.testing.assert_array_equal(points,original_points)


if __name__=='__main__':unittest.main()

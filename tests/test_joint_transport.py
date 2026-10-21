"""Portable joint-volume checks: analytic media, geometry and deterministic state."""
from pathlib import Path
from datetime import datetime, timedelta, timezone
import importlib
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

ENGINE=Path(__file__).resolve().parents[1]/'skills/route-replay/scripts/engine'
sys.path.insert(0,str(ENGINE))
_names=('runtime','cloudvolume','cloudlayers','weatherfields','atmosphere','jointtransport','cloudlighting')
_saved={name:sys.modules.get(name) for name in _names}
for name in _names:sys.modules.pop(name,None)
sys.modules['runtime']=SimpleNamespace(TRIP=SimpleNamespace(style={}),ASSETS=Path('/unused'),WEATHER=None)
try:
    joint=importlib.import_module('jointtransport')
    cloud,air=joint.cloud,joint.air
    lighting=importlib.import_module('cloudlighting')
finally:
    for name,module in _saved.items():
        if module is None:sys.modules.pop(name,None)
        else:sys.modules[name]=module


def constant_density(value):
    def sample(points,*args,**kwargs):
        return np.full(len(points),value),points/np.linalg.norm(points,axis=-1,keepdims=True)
    return sample


def uniform_fields(mass=20.):
    lat,lon=np.mgrid[90:-91:-1,0:360]
    unit=cloud._unit(np.radians(lon),np.radians(lat))
    return tuple(tuple(np.asarray(a,np.float32) for a in
                       (np.ones_like(lon),np.full_like(lon,mass,dtype=float),np.full_like(lon,height),
                        *unit.transpose(2,0,1))) for height in (1800,5500,11000))


class JointTransportTests(unittest.TestCase):
    def setUp(self):
        modules=patch.dict(sys.modules,{'atmosphere':air,'cloudlighting':lighting})
        modules.start();self.addCleanup(modules.stop)
        moon=patch.dict(cloud.TRIP.style,{'moonlight':0.})
        moon.start();self.addCleanup(moon.stop)

    def test_homogeneous_mixture_has_analytic_source_weight_and_attenuation(self):
        # Two interpenetrating media do not equal either ordering of two slabs.
        tau_air=np.array([.15,.3,.6]);tau_cloud=np.full(3,.8)
        source_air=np.array([.2,.5,1.]);source_cloud=np.array([1.2,1.1,.9])
        tau=tau_air+tau_cloud
        actual,t=joint.segment_transport(tau,tau_air*source_air+tau_cloud*source_cloud)
        expected=(tau_air*source_air+tau_cloud*source_cloud)/tau*(1-np.exp(-tau))
        np.testing.assert_allclose(actual,expected,rtol=1e-14)
        np.testing.assert_allclose(t,np.exp(-tau),rtol=1e-14)
        separated=source_air*(1-np.exp(-tau_air))+np.exp(-tau_air)*source_cloud*(1-np.exp(-tau_cloud))
        self.assertGreater(float(np.max(abs(actual-separated))),.01)
        empty,identity=joint.segment_transport(np.zeros(3),np.zeros(3))
        np.testing.assert_array_equal(empty,0);np.testing.assert_array_equal(identity,1)

    def test_near_and_far_shells_cover_each_visible_segment_once(self):
        origin=np.array([0.,0.,1.2]);rays=np.array([[0.,0.,-1.],[.9,0.,-.44],[1.,0.,0.]])
        rays/=np.linalg.norm(rays,axis=-1,keepdims=True)
        origins=np.broadcast_to(origin,rays.shape);radii=joint._radii(True,True)
        start,stop,hit=joint.sphere_interval(origins,rays,radii[-1])
        ground,_,ground_hit=joint.sphere_interval(origins,rays,1.)
        stop=np.where(ground_hit,np.minimum(stop,ground),stop)
        lengths=np.zeros(3);last=start.copy()
        for a,b,valid in joint._segments(origins,rays,radii,start,stop,2):
            active=valid&hit&(stop>start)
            self.assertTrue(np.all(a[active]>=last[active]-1e-12))
            lengths[active]+=b[active]-a[active];last[active]=b[active]
        np.testing.assert_allclose(lengths,np.where(hit,np.maximum(stop-start,0),0),atol=1e-12)

    def test_uniform_night_cloud_matches_exact_slab(self):
        sigma=.0002
        with patch.object(cloud,'_density',side_effect=constant_density(sigma)):
            light,t=joint.integrate_joint_rays([0,0,1.2],[[0,0,-1]],[0,0,-1],0,
                fields=(),with_atmosphere=False,cloud_lighting=0.)
        expected=np.exp(-sigma*cloud.MAX_ALTITUDE_M)
        np.testing.assert_allclose(t,expected,rtol=2e-6)
        np.testing.assert_allclose(light,(1-expected)*np.array([[.002,.004,.008]]),rtol=2e-6)

    def test_lunar_air_uses_joint_geometry_and_explicit_cloud_inputs(self):
        calls=[];fields=object()
        def lunar_source(points,*args,**kwargs):
            calls.append(kwargs)
            return np.zeros((len(points),3))
        with patch.object(cloud,'_density',side_effect=constant_density(0.)),\
             patch.object(cloud,'_frame_fields',side_effect=AssertionError('weather loaded')),\
             patch('lunar_scattering.atmosphere_source',side_effect=lunar_source):
            joint.integrate_joint_rays([0,0,1.2],[[0,0,-1]],[0,0,1],0,
                fields=fields,cloud_strength=.31,cloud_sun_samples=3,atmosphere_sun_samples=5)
        self.assertTrue(calls)
        for call in calls:
            self.assertTrue(call['shared_cloud_geometry'])
            self.assertIs(call['fields'],fields)
            self.assertEqual(call['cloud_strength'],.31)
            self.assertEqual(call['cloud_samples'],3)
            self.assertEqual(call['samples'],5)

    def test_new_night_source_is_dark_without_city_and_preserves_city_light(self):
        sigma=.0002;lamp=np.array([.3,.12,.02])
        def city(points,dt,sun,physical_dt,fields,**kwargs):
            return np.broadcast_to(lamp if physical_dt is not None else np.zeros(3),(len(points),3))
        with patch.object(cloud,'_density',side_effect=constant_density(sigma)),\
             patch.object(cloud,'_city_source',side_effect=city):
            for gain in (0.,1.,4.):
                args=([0,0,1.2],[[0,0,-1]],[0,0,-1],0)
                options=dict(fields=(),with_atmosphere=False,cloud_lighting=1.,cloud_multiple_scattering=gain)
                dark,t=joint.integrate_joint_rays(*args,**options)
                lit,lit_t=joint.integrate_joint_rays(*args,physical_dt=123.,**options)
                np.testing.assert_array_equal(dark,0.)
                np.testing.assert_array_equal(lit_t,t)
                np.testing.assert_allclose(lit,(1-t)*lamp,rtol=2e-6)

    def test_lighting_comparison_preserves_mixed_extinction_and_aircraft_depth(self):
        normal_requests=[]
        def density(points,*args,**kwargs):
            normal_requests.append(kwargs.get('normals',False))
            return constant_density(.0001)(points)
        depth=np.array([.05,.185,.2]);rays=np.tile([0.,0.,-1.],(3,1));values={}
        with patch.object(cloud,'_density',side_effect=density):
            for gain in (0.,1.):
                normal_requests.clear()
                values[gain]=joint.integrate_joint_rays([0,0,1.2],rays,[0,0,1],0,fields=(),depth=depth,
                    cloud_lighting=gain,cloud_sun_samples=2,atmosphere_sun_samples=2)
                self.assertEqual(any(normal_requests),gain==0.)
        np.testing.assert_array_equal(values[0.][1],values[1.][1])
        np.testing.assert_array_equal(values[1.][0][0],0.)
        np.testing.assert_array_equal(values[1.][1][0],1.)
        self.assertTrue(np.all(values[1.][1][1]>values[1.][1][2]))
        self.assertGreater(float(np.max(abs(values[0.][0]-values[1.][0]))),1e-4)

    def test_city_source_preserves_mixed_transmission_and_reordered_results(self):
        physical=datetime(2030,11,17,tzinfo=timezone.utc)
        weather_time=datetime(2026,10,18,tzinfo=timezone.utc)
        later=weather_time+timedelta(minutes=20)
        calls=[]
        def source(points,when,sun,physical_dt,fields,**kwargs):
            calls.append((when,physical_dt))
            self.assertIn(when,(weather_time,later))
            if physical_dt is None:return np.zeros((len(points),3))
            self.assertEqual(physical_dt,physical)
            value=.2 if when==weather_time else .35
            return np.broadcast_to([value,.08,.02],(len(points),3))
        rays=np.array([[0.,0.,-1.],[.02,0.,-1.]])
        rays/=np.linalg.norm(rays,axis=-1,keepdims=True)
        with patch.object(cloud,'_density',side_effect=constant_density(.0001)),\
             patch.object(cloud,'_city_source',side_effect=source):
            baseline=joint.integrate_joint_rays([0,0,1.2],rays,[0,0,-1],weather_time,fields=())
            values={when:joint.integrate_joint_rays([0,0,1.2],rays,[0,0,-1],when,
                    fields=(),physical_dt=physical) for when in (weather_time,later)}
            for when in (later,weather_time,later):
                reordered=joint.integrate_joint_rays([0,0,1.2],rays[::-1],[0,0,-1],when,
                    fields=(),physical_dt=physical)
                for actual,expected in zip(reordered,values[when]):
                    np.testing.assert_array_equal(actual[::-1],expected)
        np.testing.assert_array_equal(values[weather_time][1],baseline[1])
        self.assertTrue(np.all(values[weather_time][0]>baseline[0]))
        self.assertTrue(np.all(values[later][0][:,0]>values[weather_time][0][:,0]))
        self.assertEqual({p for _,p in calls},{None,physical})

    def test_moon_source_preserves_mixed_opacity_depth_and_separate_clocks(self):
        physical=datetime(2030,11,17,tzinfo=timezone.utc)
        weather_time=datetime(2026,10,18,tzinfo=timezone.utc)
        later=weather_time+timedelta(minutes=20);fields=object();calls=[]
        moon=np.array([.3,.2,.1])
        def source(points,rays,when,physical_dt,actual_fields,**kwargs):
            calls.append((when,physical_dt,actual_fields))
            self.assertEqual(physical_dt,physical)
            low=cloud._geographic(points)[2]<5000
            return low[:,None]*moon*(1. if when==weather_time else .5)
        depth=np.array([.05,.185,.2]);rays=np.tile([0.,0.,-1.],(3,1));values={}
        options=dict(fields=fields,physical_dt=physical,cloud_sun_samples=1,atmosphere_sun_samples=2)
        with patch.object(cloud,'_density',side_effect=constant_density(.0001)),\
             patch.object(cloud,'_city_source',side_effect=lambda p,*a,**k:np.zeros((len(p),3))):
            with patch.object(cloud,'_moon_source',side_effect=lambda p,*a,**k:np.zeros((len(p),3))):
                baseline=joint.integrate_joint_rays([0,0,1.2],rays,[0,0,-1],weather_time,depth=depth,**options)
            with patch.object(cloud,'_moon_source',side_effect=source):
                for when in (weather_time,later):
                    values[when]=joint.integrate_joint_rays([0,0,1.2],rays,[0,0,-1],when,depth=depth,**options)
                for when in (later,weather_time,later):
                    reordered=joint.integrate_joint_rays([0,0,1.2],rays[::-1],[0,0,-1],when,
                                                        depth=depth[::-1],**options)
                    for actual,expected in zip(reordered,values[when]):
                        np.testing.assert_array_equal(actual[::-1],expected)
        np.testing.assert_array_equal(values[weather_time][1],baseline[1])
        np.testing.assert_array_equal(values[later][1],baseline[1])
        delta=values[weather_time][0]-baseline[0]
        np.testing.assert_array_equal(delta[:2],0.)
        self.assertTrue(np.all(delta[2]>0))
        self.assertTrue(np.all(baseline[1][1]<1.))
        np.testing.assert_allclose(values[later][0]-baseline[0],.5*delta,rtol=2e-6,atol=1e-8)
        self.assertEqual({when for when,_,_ in calls},{weather_time,later})
        self.assertTrue(all(stamp==physical and actual is fields for _,stamp,actual in calls))

    def test_joint_integrator_forwards_explicit_cloud_and_air_source_budgets(self):
        def black(points,*args,**kwargs):return np.zeros((len(points),3))
        with patch.object(cloud,'_density',side_effect=constant_density(.0001)),\
             patch.object(cloud,'_cloud_source',side_effect=black) as solar,\
             patch.object(cloud,'_moon_source',side_effect=black) as lunar,\
             patch.object(cloud,'_city_source',side_effect=black):
            joint.integrate_joint_rays([0,0,1.2],[[0,0,-1]],[0,0,1],0,fields=(),
                cloud_sun_samples=2,atmosphere_sun_samples=3,
                physical_dt=datetime(2024,11,17,tzinfo=timezone.utc))
        self.assertGreater(solar.call_count,0);self.assertEqual(lunar.call_count,solar.call_count)
        self.assertTrue(all(call.kwargs.get('sun_samples')==2 for call in solar.call_args_list))
        self.assertTrue(all(call.kwargs.get('cloud_samples')==2 for call in lunar.call_args_list))
        self.assertTrue(all(call.kwargs.get('atmosphere_samples')==3 for call in lunar.call_args_list))

    def test_city_glow_wrapper_respects_aircraft_depth_and_separate_clocks(self):
        physical=datetime(2030,11,17,tzinfo=timezone.utc)
        weather_time=datetime(2026,10,18,tzinfo=timezone.utc)
        origin=np.array([0.,0.,1.2]);rays=np.tile([0.,0.,-1.],(1,3,1))
        depth=np.array([[.05,.185,.2]],np.float32);fields=object();calls=[]
        def source(points,when,sun,physical_dt,actual_fields,**kwargs):
            calls.append((when,physical_dt,actual_fields))
            low=(cloud._geographic(points)[2]<5000)&(physical_dt is not None)
            return low[:,None]*np.array([[.3,.1,.02]])
        options=dict(size=(3,1),center=(1.5,.5),depth=depth,camera_rays=(origin,rays),
                     substeps=1,cloud_sun_samples=1,atmosphere_sun_samples=2)
        with patch.object(cloud,'_frame_fields',return_value=fields),\
             patch.object(cloud,'_density',side_effect=constant_density(.0001)),\
             patch.object(cloud,'_city_source',side_effect=source):
            baseline=joint.joint_transport(np.eye(3),[0,0,-1],weather_time,500,**options)
            lit=joint.joint_transport(np.eye(3),[0,0,-1],weather_time,500,physical_dt=physical,**options)
        np.testing.assert_array_equal(lit.transmittance,baseline.transmittance)
        np.testing.assert_array_equal(lit.radiance[0,:2],baseline.radiance[0,:2])
        self.assertTrue(np.all(lit.radiance[0,2]>baseline.radiance[0,2]))
        self.assertTrue(np.all(lit.transmittance[0,1]<1))  # Medium before the aircraft still contributes.
        self.assertEqual({w for w,_,_ in calls},{weather_time})
        self.assertEqual({p for _,p,_ in calls},{None,physical})
        self.assertTrue(all(f is fields for _,_,f in calls))

    def test_mixed_extinction_is_sum_of_air_and_cloud_optical_depth(self):
        args=([0,0,1.2],[[0,0,-1]],[0,0,1],0)
        with patch.object(cloud,'_density',side_effect=constant_density(.0001)):
            _,mixed=joint.integrate_joint_rays(*args,fields=(),substeps=4)
            _,cloud_only=joint.integrate_joint_rays(*args,fields=(),with_atmosphere=False,substeps=4)
            _,air_only=joint.integrate_joint_rays(*args,with_clouds=False,substeps=4)
        np.testing.assert_allclose(mixed,cloud_only*air_only,rtol=.0015)

    def test_opaque_depth_excludes_cloud_and_air_behind_hit(self):
        depth=np.array([.05,.185,.2]);rays=np.tile([0.,0.,-1.],(3,1));sigma=.0002
        with patch.object(cloud,'_density',side_effect=constant_density(sigma)):
            light,t=joint.integrate_joint_rays([0,0,1.2],rays,[0,0,-1],0,
                fields=(),depth=depth,with_atmosphere=False)
            full_light,full_t=joint.integrate_joint_rays([0,0,1.2],rays,[0,0,-1],0,
                fields=(),depth=depth)
        physical_length=max(0,cloud.MAX_ALTITUDE_M-.015*cloud.EARTH_M/cloud.HEIGHT_EXAGGERATION)
        np.testing.assert_allclose(t[1],np.exp(-sigma*physical_length),rtol=2e-6)
        np.testing.assert_array_equal(t[0],1);np.testing.assert_array_equal(light[0],0)
        np.testing.assert_array_equal(full_t[0],1);np.testing.assert_array_equal(full_light[0],0)
        self.assertTrue(np.all(t[1]>t[2]))

    def test_sun_path_from_above_cloud_starts_at_cloud_entry(self):
        point=np.array([[0.,0.,1.05]])
        sun=np.array([.97,0.,-.24]);sun/=np.linalg.norm(sun)
        outer=1+cloud.MAX_ALTITUDE_M*cloud.HEIGHT_EXAGGERATION/cloud.EARTH_M
        near,far,hit=joint.sphere_interval(point,sun,outer)
        self.assertTrue(hit[0]);self.assertGreater(near[0],0)
        self.assertFalse(air.earth_shadow(point,sun)[0])
        with patch.object(cloud,'_density',side_effect=constant_density(.0001)):
            tau,_=joint.solar_optical_depth(point,sun,0,fields=(),with_atmosphere=False,cloud_samples=4)
        np.testing.assert_allclose(tau,(far-near)*cloud.EARTH_M/cloud.HEIGHT_EXAGGERATION*.0001,rtol=1e-8)

    def test_sun_path_inside_cloud_integrates_only_forward_exit(self):
        point=np.array([[0.,0.,1.01]]);sun=np.array([0.,0.,1.]);sigma=.0001
        outer=1+cloud.MAX_ALTITUDE_M*cloud.HEIGHT_EXAGGERATION/cloud.EARTH_M
        near,far,hit=joint.sphere_interval(point,sun,outer)
        self.assertTrue(hit[0]);self.assertEqual(near[0],0.)
        np.testing.assert_allclose(far,outer-1.01,atol=1e-14)
        with patch.object(cloud,'_density',side_effect=constant_density(sigma)):
            tau,_=joint.solar_optical_depth(point,sun,0,fields=(),with_atmosphere=False,cloud_samples=4)
        expected=(outer-1.01)*cloud.EARTH_M/cloud.HEIGHT_EXAGGERATION*sigma
        np.testing.assert_allclose(tau,expected,rtol=1e-8)

    def test_clear_air_converges_to_existing_high_sample_reference(self):
        origin=np.array([0.,0.,1.2]);rays=np.array([[0.,0.,-1.]])
        kwargs={'sun_samples':32,'multiple_scattering':0.}
        reference=air.integrate_atmosphere_rays(origin,rays,[0,0,1],view_samples=512,**kwargs)
        with patch.object(cloud,'_frame_fields',side_effect=AssertionError('weather loaded')), \
             patch.object(cloud,'_density',side_effect=AssertionError('cloud density sampled')):
            actual=joint.integrate_joint_rays(origin,rays,[0,0,1],0,with_clouds=False,substeps=8,
                atmosphere_sun_samples=32,atmosphere_multiple_scattering=0.)
        np.testing.assert_allclose(actual[0],reference[0],rtol=.004,atol=1e-5)
        np.testing.assert_allclose(actual[1],reference[1],rtol=.001,atol=1e-6)

    def test_cloud_shadow_attenuates_the_direct_air_source(self):
        # A low, dense layer removes direct solar illumination from lower air.
        # This beam-only diagnostic evaluates extinction without local sources.
        points=np.array([[0,0,1.0001]],dtype=float);sun=np.array([0.,0.,1.])
        with patch.object(cloud,'_density',side_effect=constant_density(.0005)):
            cloud_tau,air_tau=joint.solar_optical_depth(points,sun,0,fields=())
        self.assertGreater(float(cloud_tau[0]),7.)
        self.assertTrue(np.all(np.exp(-air_tau-cloud_tau[:,None])<np.exp(-air_tau)*.001))

    def test_tangent_shadow_and_frame_order_are_finite_and_deterministic(self):
        before,after=uniform_fields(8.),uniform_fields(20.)
        ray=np.array([[.9,0,-.44],[0,0,-1],[1,0,0]],float);ray/=np.linalg.norm(ray,axis=-1,keepdims=True)
        with patch.object(cloud,'_frame_fields',side_effect=lambda stamp:before if stamp==0 else after):
            values={t:joint.integrate_joint_rays([0,0,1.2],ray,[0,0,-1],t) for t in (0,3600)}
            for t in (3600,0):
                actual=joint.integrate_joint_rays([0,0,1.2],ray,[0,0,-1],t)
                for a,b in zip(actual,values[t]):np.testing.assert_array_equal(a,b)
                self.assertTrue(np.isfinite(actual[0]).all())
                self.assertTrue(np.all((actual[1]>=0)&(actual[1]<=1)))
            self.assertGreater(float(np.max(np.abs(values[0][1]-values[3600][1]))),.001)

    def test_crop_geometry_matches_same_full_sensor_pixels(self):
        kwargs={'bs':np.eye(3),'sun':[0,0,1],'dt':0,'radius':20,'scale':1,
                'sensor_width':32,'with_clouds':False}
        full=joint.joint_transport(**kwargs,size=(32,24),center=(16,12))
        crop=joint.joint_transport(**kwargs,size=(8,8),center=(4,4))
        np.testing.assert_allclose(crop.radiance,full.radiance[8:16,12:20],atol=2e-7)
        np.testing.assert_allclose(crop.transmittance,full.transmittance[8:16,12:20],atol=2e-7)

    def test_invalid_rays_depth_and_sample_counts_fail_clearly(self):
        for options in ({'substeps':0},{'cloud_sun_samples':1.5},{'depth':[np.nan]},
                        {'depth':[-1]},{'atmosphere_strength':np.inf}):
            with self.subTest(options=options),self.assertRaises(ValueError):
                joint.integrate_joint_rays([0,0,1.2],[[0,0,-1]],[0,0,1],0,with_clouds=False,**options)
        with self.assertRaisesRegex(ValueError,'unit rays'):
            joint.integrate_joint_rays([0,0,1.2],[[0,0,-2]],[0,0,1],0,with_clouds=False)


if __name__=='__main__':unittest.main()

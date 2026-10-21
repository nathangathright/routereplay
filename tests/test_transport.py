"""Data-free numerical transport, wind coherence and frame-order regressions."""
from pathlib import Path
from datetime import datetime, timedelta, timezone
import importlib
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np

ENGINE=Path(__file__).resolve().parents[1]/'skills'/'cinematic-flight-videos'/'scripts'/'engine'
sys.path.insert(0,str(ENGINE))
# Layer runtime configuration is not needed by numerical transport. Keep the
# test fixtures isolated from the runtime module used by actual CLI workers.
_runtime=SimpleNamespace(TRIP=SimpleNamespace(style={}),ASSETS=Path('/unused'),WEATHER=None)
_saved={name:sys.modules.get(name) for name in ('cloudvolume','cloudlayers','weatherfields','atmosphere','cloudlighting')}
_saved_runtime=sys.modules.get('runtime')
sys.modules['runtime']=_runtime
try:
    for name in _saved:sys.modules.pop(name,None)
    cloud=importlib.import_module('cloudvolume')
    atmosphere=importlib.import_module('atmosphere')
    lighting=importlib.import_module('cloudlighting')
    weather=importlib.import_module('weatherfields')
finally:
    if _saved_runtime is None:sys.modules.pop('runtime',None)
    else:sys.modules['runtime']=_saved_runtime
for _name,_module in _saved.items():
    if _module is None:sys.modules.pop(_name,None)
    else:sys.modules[_name]=_module


def uniform_fields(mass=20.):
    lat,lon=np.mgrid[90:-91:-1,0:360]
    unit=cloud._unit(np.radians(lon),np.radians(lat))
    return tuple(tuple(np.asarray(a,np.float32) for a in
                       (np.ones_like(lon),np.full_like(lon,mass,dtype=float),np.full_like(lon,height),*unit.transpose(2,0,1)))
                 for height in (1800,5500,11000))


class WindTests(unittest.TestCase):
    def test_default_backtrace_rejects_uncovered_times(self):
        first,last=5*3600.,10*3600.
        with patch.object(weather,'MATERIAL_REFERENCE',first),patch.object(weather,'VALID_END',last):
            for stamp in (first-1,last+1):
                with self.assertRaisesRegex(ValueError,'verified weather coverage'):
                    weather.backtrace_coordinates([0.],[0.],3000,stamp)

    def test_float16_prepared_winds_interpolate_in_float(self):
        u=np.full((2,3,361,720),12,dtype=np.float16)
        v=np.full_like(u,-4)
        weather._wind_slice.cache_clear()
        with patch.object(weather,'_winds',return_value=(u,v,np.array([0.,3600.]),np.array([1500,5500,10500]))):
            x,y=weather.sample_wind([0.,np.pi],[0.,.4],3000,1800)
        weather._wind_slice.cache_clear()
        np.testing.assert_array_equal(x,12);np.testing.assert_array_equal(y,-4)

    def test_zero_wind_and_seed_frame_order(self):
        lo=np.array([0.,3.1415,-3.1415,1.]);la=np.array([0.,.4,-.6,1.5])
        zero=lambda lo,la,h,t:(np.zeros_like(lo),np.zeros_like(lo))
        values={t:weather.backtrace_coordinates(lo,la,3000,t,reference=0,wind_sampler=zero) for t in (0,1000,7200)}
        for t in (7200,0,1000):
            actual=weather.backtrace_coordinates(lo,la,3000,t,reference=0,wind_sampler=zero)
            np.testing.assert_allclose(actual[0],lo,atol=1e-6)
            np.testing.assert_allclose(actual[1],la,atol=1e-6)
            np.testing.assert_array_equal(actual,values[t])

    def test_detail_follows_wind_across_time_and_dateline(self):
        # Solid-body rotation is an exact, coherent spherical velocity field.
        speed=55.
        wind=lambda lo,la,h,t:(speed*np.cos(la),np.zeros_like(lo))
        lo=np.array([3.13,-2.,.4]);la=np.array([0.,.6,-.7])
        seconds=7200.
        moved=(lo+speed*seconds/weather.EARTH_M+np.pi)%(2*np.pi)-np.pi
        traced=weather.backtrace_coordinates(moved,la,5000,seconds,reference=0,
                                              max_step_seconds=600,wind_sampler=wind)
        seed=cloud._unit(*traced);reference=cloud._unit(lo,la)
        np.testing.assert_allclose(seed,reference,atol=2e-6)
        np.testing.assert_allclose(cloud._noise3(seed*weather.EARTH_M,56000),
                                   cloud._noise3(reference*weather.EARTH_M,56000),atol=1e-4)
        t=3600.;before=weather.backtrace_coordinates(lo,la,5000,t-.01,reference=0,wind_sampler=wind)
        after=weather.backtrace_coordinates(lo,la,5000,t+.01,reference=0,wind_sampler=wind)
        self.assertLess(float(np.max(np.abs(cloud._unit(*after)-cloud._unit(*before)))),2e-6)

    def test_pole_backtrace_is_finite_and_long_span_bounded(self):
        calls=[]
        def wind(lo,la,h,t):
            calls.append(t)
            return np.full_like(lo,30.),np.full_like(lo,5.)
        lo,la=weather.backtrace_coordinates([0,1],[np.pi/2,-np.pi/2],1000,100*86400,
                                            reference=0,wind_sampler=wind)
        self.assertTrue(np.all(np.isfinite(lo)))
        self.assertTrue(np.all(np.isfinite(la)))
        self.assertLessEqual(len(calls),128)


class CloudTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.fields=uniform_fields()

    def setUp(self):
        modules=patch.dict(sys.modules,{'atmosphere':atmosphere,'cloudlighting':lighting})
        modules.start();self.addCleanup(modules.stop)
        # Existing Sun/city fixtures isolate their own sources. Lunar tests
        # below enable or inject moonlight explicitly.
        moon=patch.dict(cloud.TRIP.style,{'moonlight':0.})
        moon.start();self.addCleanup(moon.stop)

    def test_new_source_ignores_pseudo_normals_and_blends_sources_only(self):
        points=np.array([[1.004,0.,0.],[1.006,0.,0.]])
        rays=np.array([[-1.,0.,0.],[-1.,0.,0.]]);sun=np.array([1.,0.,0.])
        sigma=np.array([.0001,.0002]);normal=np.array([[1.,0.,0.],[1.,0.,0.]])
        tau=np.array([.5,2.]);air_tau=np.array([[.1,.2,.4],[.3,.5,.9]])
        args=(points,rays,sun,0,(),sigma)
        upgraded=cloud._cloud_source(*args,normal,tau,air_tau,lighting=1.,with_atmosphere=False)
        reversed_normals=cloud._cloud_source(*args,-normal,tau,air_tau,lighting=1.,with_atmosphere=False)
        legacy=cloud._cloud_source(*args,normal,tau,air_tau,lighting=0.,with_atmosphere=False)
        blend=cloud._cloud_source(*args,normal,tau,air_tau,lighting=.5,with_atmosphere=False)
        np.testing.assert_array_equal(upgraded,reversed_normals)
        np.testing.assert_allclose(blend,.5*(legacy+upgraded),rtol=1e-6)
        self.assertGreater(float(np.max(abs(upgraded-legacy))),1e-4)

    def test_lighting_comparison_preserves_view_extinction_and_depth(self):
        normal_requests=[]
        def density(points,*args,**kwargs):
            normal_requests.append(kwargs.get('normals',False))
            return np.full(len(points),.0001),points/np.linalg.norm(points,axis=-1,keepdims=True)
        origins=np.tile([1.04,0.,0.],(2,1));rays=np.tile([-1.,0.,0.],(2,1))
        stop=np.array([.04,.02]);values={}
        with patch.object(cloud,'_density',side_effect=density):
            for gain in (0.,1.):
                normal_requests.clear()
                with patch.dict(cloud.TRIP.style,{'cloud_lighting':gain}):
                    values[gain]=cloud._integrate(origins,rays,np.zeros(2),stop,0,np.array([1.,0.,0.]),
                                                  fields=(),substeps=1,sun_samples=2)
                self.assertEqual(any(normal_requests),gain==0.)
        np.testing.assert_array_equal(values[0.][1],values[1.][1])
        self.assertGreater(float(np.max(abs(values[0.][0]-values[1.][0]))),1e-4)
        expected_length=np.array([16000.,16000.-.02*cloud.EARTH_M/cloud.HEIGHT_EXAGGERATION])
        np.testing.assert_allclose(values[1.][1],np.exp(-.0001*expected_length),rtol=2e-6)

    def test_layered_fractional_lighting_is_linear_with_colored_solar_air(self):
        # Layered legacy lighting had no atmospheric Sun tint. Computing the
        # new path's RGB air depth must not tint the legacy half of a blend.
        def density(points,*args,**kwargs):
            return np.full(len(points),.0001),points/np.linalg.norm(points,axis=-1,keepdims=True)
        def colored_air(points,*args,**kwargs):
            return np.broadcast_to([.1,1.,3.],(len(points),3)).copy()
        def no_sky(points,*args,**kwargs):
            up=points/np.linalg.norm(points,axis=-1,keepdims=True)
            return np.repeat(up[:,None,:],3,axis=1),np.zeros((len(points),3,3)),np.ones(3)
        origins=np.array([[1.04,0.,0.],[1.04,.002,0.]])
        rays=np.tile([-1.,0.,0.],(2,1));stop=np.array([.04,.025]);values={}
        with patch.object(cloud,'_density',side_effect=density),\
             patch.object(atmosphere,'optical_depth',side_effect=colored_air) as air_depth,\
             patch.object(lighting,'sky_samples',side_effect=no_sky):
            for gain in (0.,.5,1.):
                with patch.dict(cloud.TRIP.style,{'cloud_lighting':gain}):
                    values[gain]=cloud._integrate(origins,rays,np.zeros(2),stop,0,np.array([1.,0.,0.]),
                                                  fields=(),substeps=1,sun_samples=2)
            self.assertGreater(air_depth.call_count,0)
        np.testing.assert_allclose(values[.5][0],.5*(values[0.][0]+values[1.][0]),rtol=3e-6,atol=1e-8)
        np.testing.assert_array_equal(values[.5][1],values[0.][1])
        np.testing.assert_array_equal(values[.5][1],values[1.][1])
        self.assertGreater(float(np.max(abs(values[0.][0]-values[1.][0]))),1e-3)

    def test_density_is_continuous_earth_fixed_and_order_independent(self):
        positions=cloud._unit(np.array([0.,.4,-3.14]),np.array([.2,-.3,.7]))
        positions*=1+np.array([1700,5200,10500])[:,None]*cloud.HEIGHT_EXAGGERATION/cloud.EARTH_M
        first=cloud._density(positions,0,fields=self.fields)[0]
        cloud._density(positions[::-1],20,fields=self.fields)
        last=cloud._density(positions,0,fields=self.fields)[0]
        np.testing.assert_array_equal(first,last)
        self.assertTrue(np.all(first>0))
        self.assertLess(float(np.max(np.abs(first-cloud._density(positions+1e-8,0,fields=self.fields)[0]))),1e-7)
        np.testing.assert_array_equal(cloud._density(positions,0,fields=self.fields,strength=0)[0],0)

    def test_full_density_material_map_moves_with_wind(self):
        speed=40.
        wind=lambda lo,la,h,t:(speed*np.cos(la),np.zeros_like(lo))
        def macro(lo,la,t,layer):
            return np.ones_like(lo),np.full_like(lo,20.),np.full_like(lo,(1800,5500,11000)[layer])
        lo=np.array([.41,-2.1,3.13]);la=np.array([.2,-.3,.7]);alt=np.array([1700,5200,10500])
        cloud._frame_fields.cache_clear()
        with patch.object(cloud,'sample_layer_fields',side_effect=macro),patch.object(weather,'sample_wind',side_effect=wind):
            first=cloud._frame_fields(0.)
            later=cloud._frame_fields(7200.)
            a=cloud._density(cloud._unit(lo,la)*(1+alt[:,None]*cloud.HEIGHT_EXAGGERATION/cloud.EARTH_M),0,fields=first)[0]
            moved=lo+speed*7200/cloud.EARTH_M
            b=cloud._density(cloud._unit(moved,la)*(1+alt[:,None]*cloud.HEIGHT_EXAGGERATION/cloud.EARTH_M),7200,fields=later)[0]
            # Macro-map bilinear reconstruction and RK2 introduce bounded
            # approximation; the detailed density itself travels with wind.
            np.testing.assert_allclose(a,b,rtol=.003,atol=1e-7)
            cloud._frame_fields.cache_clear()
            reversed_later=cloud._frame_fields(7200.)
            cloud._frame_fields(0.)
            for layer,reference in zip(reversed_later,later):
                for value,expected in zip(layer,reference):np.testing.assert_array_equal(value,expected)
        cloud._frame_fields.cache_clear()

    def test_material_seed_anchor_uses_verified_start_and_bounded_wind_times(self):
        first,last=5*3600.,15*3600.
        queries=[]
        def wind(lo,la,height,stamp):
            queries.append(stamp)
            return np.full_like(lo,30.),np.zeros_like(lo)
        def macro(lo,la,stamp,layer):
            return np.ones_like(lo),np.full_like(lo,20.),np.full_like(lo,(1800,5500,11000)[layer])
        cloud._frame_fields.cache_clear()
        try:
            with patch.object(weather,'MATERIAL_REFERENCE',first),patch.object(weather,'VALID_END',last),\
                 patch.object(weather,'sample_wind',side_effect=wind),patch.object(cloud,'sample_layer_fields',side_effect=macro):
                cloud._frame_fields(first)
                self.assertEqual(queries,[])  # No wind history precedes the arbitrary seed epoch.
                for stamp in (first+1800,first+7200+60,last):
                    queries.clear()
                    cloud._frame_fields(stamp)
                    self.assertTrue(queries)
                    self.assertGreaterEqual(min(queries),first)
                    self.assertLessEqual(max(queries),stamp)
                    # Three layers take two wind evaluations per RK2 step.
                    self.assertEqual(len(queries)%6,0)
                    self.assertTrue(any(first < query < stamp for query in queries))
        finally:
            cloud._frame_fields.cache_clear()

    def test_cloud_view_and_sun_extinction_share_density(self):
        sigma=.00015
        def constant(points,*args,**kwargs):return np.full(len(points),sigma),points/np.linalg.norm(points,axis=-1,keepdims=True)
        point=np.array([[1.,0,0]]);sun=np.array([1.,0,0])
        top=1+cloud.MAX_ALTITUDE_M*cloud.HEIGHT_EXAGGERATION/cloud.EARTH_M
        with patch.object(cloud,'_density',side_effect=constant):
            solar=cloud._solar_transmission(point,sun,0,fields=self.fields,samples=8)
            _,view=cloud._integrate(point,sun[None,:],np.array([0.]),np.array([top-1]),0,sun,
                                   fields=self.fields,substeps=2,sun_samples=2)
        self.assertAlmostEqual(float(solar[0]),np.exp(-sigma*cloud.MAX_ALTITUDE_M),places=6)
        np.testing.assert_allclose(view,solar,atol=2e-7)

    def test_actual_density_shadows_follow_clouds(self):
        point=np.array([[1.,0,0]]);sun=np.array([1.,0,0])
        empty=cloud._solar_transmission(point,sun,0,fields=uniform_fields(0),samples=48)
        full=cloud._solar_transmission(point,sun,0,fields=self.fields,samples=48)
        np.testing.assert_array_equal(empty,1)
        self.assertLess(float(full[0]),.5)
        blocked=cloud._solar_transmission(np.array([[-1.,0,0]]),sun,0,fields=self.fields,samples=4)
        np.testing.assert_array_equal(blocked,0)

    def test_view_depth_clips_medium_and_hdr_is_unclipped(self):
        origin=np.array([[1.04,0,0]]);rays=np.array([[-1.,0,0]]);sun=np.array([1.,0,0])
        args=(origin,rays,np.array([0.]),np.array([.04]),0,sun)
        full=cloud._integrate(*args,fields=self.fields,substeps=2,sun_samples=4)
        short=cloud._integrate(origin,rays,np.array([0.]),np.array([.012]),0,sun,
                               fields=self.fields,substeps=2,sun_samples=4)
        self.assertLess(float(full[1][0]),float(short[1][0]))
        empty=cloud._integrate(origin,rays,np.array([.03]),np.array([.02]),0,sun,fields=self.fields)
        np.testing.assert_array_equal(empty[0],0);np.testing.assert_array_equal(empty[1],1)
        result=cloud._layer(np.array([[2.,3.,4.]],np.float32),np.array([.5]),(1,1),(2,2))
        self.assertEqual(result.radiance.dtype,np.float32)
        self.assertGreater(float(result.radiance.max()),1.)

    def test_aircraft_depth_resampling_does_not_mix_infinite_background(self):
        value=np.full((9,9),np.inf,np.float32)
        value[3:6,3:6]=.02
        extended=cloud._extend_aircraft_depth(value)
        np.testing.assert_array_equal(extended,np.float32(.02))
        np.testing.assert_array_equal(extended[3:6,3:6],value[3:6,3:6])

    def test_city_source_uses_physical_lamps_weather_density_and_local_ground(self):
        physical=datetime(2030,11,17,tzinfo=timezone.utc)
        weather_time=datetime(2026,10,18,tzinfo=timezone.utc)
        later_weather=weather_time+timedelta(minutes=20)
        points=cloud._unit(np.array([.1,.3]),np.array([.4,.5]))
        points*=1+np.array([1500.,3500.])[:,None]*cloud.HEIGHT_EXAGGERATION/cloud.EARTH_M
        sun=np.array([0.,0.,1.]);fields=object()
        source_calls=[];density_calls=[];ground_queries=[]
        def emission(lon,lat,solar,*,physical_dt,weather_dt):
            source_calls.append((physical_dt,weather_dt))
            np.testing.assert_allclose(solar,cloud._unit(lon,lat)@sun)
            return np.column_stack((.2+.01*np.cos(lon),np.full_like(lon,.1),np.full_like(lon,.04)))
        def ground(up):
            ground_queries.append(up.copy())
            np.testing.assert_allclose(np.linalg.norm(up,axis=-1),1.)
            return np.full(len(up),500.)
        sampler=SimpleNamespace(sample=ground)
        factory=Mock(return_value=sampler)
        def density(query,when,*,fields,strength):
            height=cloud._geographic(query)[2]
            density_calls.append((when,fields,strength,height.copy()))
            sigma=.0001 if when==weather_time else .0003
            return np.full(len(query),sigma),np.zeros_like(query)
        modules={'nightlighting':SimpleNamespace(city_emission=emission),
                 'terrain_detail':SimpleNamespace(terrain_sampler=factory),
                 'runtime':SimpleNamespace(asset=lambda name:Path('/fixtures/terrain.nc'),
                    ASSETS=Path('/fixtures'),BUNDLE={'terrain_tiles':[{'path':'local.npz'}]})}
        with patch.dict(sys.modules,modules),patch.object(cloud,'_density',side_effect=density),\
             patch.dict(cloud.TRIP.style,{'cloud_city_glow':2.}):
            first=cloud._city_source(points,weather_time,sun,physical,fields,strength=.7)
            later=cloud._city_source(points,later_weather,sun,physical,fields,strength=.7)
            reordered=cloud._city_source(points[::-1],weather_time,sun,physical,fields,strength=.7)
            repeated=cloud._city_source(points,weather_time,sun,physical,fields,strength=.7)
        self.assertTrue(np.all(first>0));self.assertTrue(np.all(later<first))
        np.testing.assert_array_equal(repeated,first)
        np.testing.assert_array_equal(reordered[::-1],first)
        self.assertTrue(source_calls);self.assertTrue(density_calls);self.assertTrue(ground_queries)
        self.assertEqual({p for p,_ in source_calls},{physical})
        self.assertEqual({w for _,w in source_calls},{weather_time,later_weather})
        self.assertEqual({w for w,_,_,_ in density_calls},{weather_time,later_weather})
        for _,actual_fields,strength,height in density_calls:
            self.assertIs(actual_fields,fields);self.assertEqual(strength,.7)
            self.assertTrue(np.all(height>500.));self.assertTrue(np.all(height<3500.))
        factory.assert_called_with('/fixtures/terrain.nc',('/fixtures/local.npz',),None)

    def test_city_scattering_adds_slab_radiance_without_changing_extinction(self):
        physical=datetime(2030,11,17,tzinfo=timezone.utc)
        weather_time=datetime(2026,10,18,tzinfo=timezone.utc)
        lamp=np.array([.4,.15,.03]);sigma=.0001
        def density(points,*args,**kwargs):
            return np.full(len(points),sigma),points/np.linalg.norm(points,axis=-1,keepdims=True)
        def source(points,when,sun,physical_dt,fields,**kwargs):
            self.assertEqual(when,weather_time)
            return np.broadcast_to(lamp if physical_dt is not None else np.zeros(3),(len(points),3))
        args=(np.array([[1.04,0,0]]),np.array([[-1.,0,0]]),np.array([0.]),np.array([.04]),weather_time,np.array([-1.,0,0]))
        with patch.object(cloud,'_density',side_effect=density),patch.object(cloud,'_city_source',side_effect=source):
            baseline=cloud._integrate(*args,fields=(),substeps=1,sun_samples=1)
            lit=cloud._integrate(*args,fields=(),substeps=1,sun_samples=1,physical_dt=physical)
        np.testing.assert_array_equal(lit[1],baseline[1])
        np.testing.assert_allclose(lit[0]-baseline[0],(1-baseline[1][:,None])*lamp,rtol=2e-6)
        self.assertTrue(np.all(lit[0]>baseline[0]))

    def test_moon_source_adds_only_before_depth_and_forwards_separate_clocks(self):
        physical=datetime(2030,11,17,tzinfo=timezone.utc)
        weather_time=datetime(2026,10,18,tzinfo=timezone.utc)
        later=weather_time+timedelta(minutes=20);fields=object();calls=[]
        moon=np.array([.3,.2,.1]);sigma=.0001
        def density(points,*args,**kwargs):
            return np.full(len(points),sigma),points/np.linalg.norm(points,axis=-1,keepdims=True)
        def source(points,rays,when,physical_dt,actual_fields,**kwargs):
            calls.append((when,physical_dt,actual_fields))
            self.assertEqual(physical_dt,physical)
            # Only low cloud is lit: a plane above it must receive no added
            # view radiance, even though cloud exists before the plane.
            low=cloud._geographic(points)[2]<5000
            return low[:,None]*moon*(1. if when==weather_time else .5)
        origins=np.tile([1.04,0.,0.],(3,1));rays=np.tile([-1.,0.,0.],(3,1))
        stop=np.array([.01,.02,.04]);start=np.zeros(3);sun=np.array([-1.,0.,0.])
        values={}
        with patch.object(cloud,'_density',side_effect=density),\
             patch.object(cloud,'_city_source',side_effect=lambda p,*a,**k:np.zeros((len(p),3))):
            with patch.object(cloud,'_moon_source',side_effect=lambda p,*a,**k:np.zeros((len(p),3))):
                baseline=cloud._integrate(origins,rays,start,stop,weather_time,sun,fields=fields,
                                          substeps=2,sun_samples=1,physical_dt=physical)
            with patch.object(cloud,'_moon_source',side_effect=source):
                for when in (weather_time,later):
                    values[when]=cloud._integrate(origins,rays,start,stop,when,sun,fields=fields,
                                                  substeps=2,sun_samples=1,physical_dt=physical)
                for when in (later,weather_time,later):
                    reordered=cloud._integrate(origins[::-1],rays[::-1],start[::-1],stop[::-1],when,sun,
                        fields=fields,substeps=2,sun_samples=1,physical_dt=physical)
                    for actual,expected in zip(reordered,values[when]):
                        np.testing.assert_array_equal(actual[::-1],expected)
        np.testing.assert_array_equal(values[weather_time][1],baseline[1])
        np.testing.assert_array_equal(values[later][1],baseline[1])
        delta=values[weather_time][0]-baseline[0]
        np.testing.assert_array_equal(delta[:2],0.)
        self.assertTrue(np.all(delta[2]>0))
        self.assertLess(float(baseline[1][1]),1.)
        np.testing.assert_allclose(values[later][0]-baseline[0],.5*delta,rtol=2e-6,atol=1e-8)
        self.assertEqual({when for when,_,_ in calls},{weather_time,later})
        self.assertTrue(all(stamp==physical and actual is fields for _,stamp,actual in calls))

    def test_moon_source_disabled_or_unlit_has_no_floor_or_transport_queries(self):
        points=np.array([[1.002,0.,0.]]);rays=np.array([[-1.,0.,0.]])
        physical=datetime(2030,11,17,tzinfo=timezone.utc)
        lunar=Mock(side_effect=AssertionError('Disabled moonlight queried its ephemeris'))
        with patch.dict(sys.modules,{'moonlighting':SimpleNamespace(lunar_illumination=lunar)}),\
             patch.object(cloud,'_cloud_optical_depth',side_effect=AssertionError('Dark source queried cloud')):
            for stamp,gain in ((None,4000.),(physical,0.)):
                np.testing.assert_array_equal(cloud._moon_source(points,rays,0,stamp,(),moonlight=gain),0.)
            lunar.assert_not_called()
            lunar.side_effect=None
            for ratio,visible in ((0.,1.),(2.5e-6,0.)):
                lunar.return_value=SimpleNamespace(direction=np.array([[1.,0.,0.]]),
                                                   ratio=np.array([ratio]),visibility=np.array([visible]))
                np.testing.assert_array_equal(cloud._moon_source(points,rays,0,physical,(),moonlight=4000.),0.)

    def test_moon_source_uses_physical_geometry_weather_extinction_and_linear_gain(self):
        physical=datetime(2030,11,17,tzinfo=timezone.utc)
        weather_time=datetime(2026,10,18,tzinfo=timezone.utc)
        later=weather_time+timedelta(minutes=20);fields=object();geometry_calls=[];density_calls=[]
        points=np.array([[1.001,0.,0.],[1.003,.002,0.]])
        rays=np.tile([-1.,0.,0.],(2,1))
        def lunar(query,stamp,*,height_exaggeration):
            geometry_calls.append((stamp,height_exaggeration))
            direction=np.broadcast_to([1.,.05,.01],query.shape).copy()
            direction/=np.linalg.norm(direction,axis=-1,keepdims=True)
            return SimpleNamespace(direction=direction,ratio=np.full(len(query),2.5e-6),
                                   visibility=np.full(len(query),.7))
        def density(query,when,*,fields,strength):
            density_calls.append((when,fields,strength))
            return np.full(len(query),.00002 if when==weather_time else .0002),np.zeros_like(query)
        with patch.dict(sys.modules,{'moonlighting':SimpleNamespace(lunar_illumination=lunar)}),\
             patch.object(cloud,'_density',side_effect=density):
            options=dict(strength=.7,moonlight=4000.)
            first=cloud._moon_source(points,rays,weather_time,physical,fields,**options)
            dimmer=cloud._moon_source(points,rays,later,physical,fields,**options)
            half=cloud._moon_source(points,rays,weather_time,physical,fields,strength=.7,moonlight=2000.)
            reordered=cloud._moon_source(points[::-1],rays[::-1],weather_time,physical,fields,**options)
            repeated=cloud._moon_source(points,rays,weather_time,physical,fields,**options)
        self.assertTrue(np.all(first>0));self.assertTrue(np.all(dimmer<first))
        np.testing.assert_allclose(half,.5*first,rtol=1e-6)
        np.testing.assert_array_equal(reordered[::-1],first)
        np.testing.assert_array_equal(repeated,first)
        self.assertTrue(geometry_calls);self.assertTrue(density_calls)
        self.assertEqual(set(geometry_calls),{(physical,cloud.HEIGHT_EXAGGERATION)})
        self.assertEqual({stamp for stamp,_,_ in density_calls},{weather_time,later})
        self.assertTrue(all(actual is fields and strength==.7 for _,actual,strength in density_calls))

    def test_moon_source_direct_preserves_rgb_air_and_applies_visibility_once(self):
        points=np.array([[1.002,0.,0.]]);rays=np.array([[-1.,0.,0.]])
        physical=datetime(2030,11,17,tzinfo=timezone.utc)
        state=SimpleNamespace(direction=np.array([[1.,0.,0.]]),ratio=np.array([2.5e-6]),
                              visibility=np.ones(1))
        lunar=SimpleNamespace(lunar_illumination=Mock(return_value=state))
        rgb=np.array([[.8,.4,.1]])
        with patch.dict(sys.modules,{'moonlighting':lunar}),\
             patch.object(cloud,'_cloud_optical_depth',return_value=np.zeros(1)),\
             patch.object(atmosphere,'optical_depth',return_value=-np.log(rgb)):
            options=dict(moonlight=4000.,multiple_scattering=0.,atmosphere_strength=0.)
            clear=cloud._moon_source(points,rays,0,physical,(),with_atmosphere=False,**options)
            colored=cloud._moon_source(points,rays,0,physical,(),**options)
            state.visibility=np.full(1,.25)
            partial=cloud._moon_source(points,rays,0,physical,(),**options)
        np.testing.assert_allclose(colored,clear*rgb,rtol=2e-6,atol=1e-10)
        np.testing.assert_allclose(partial,.25*colored,rtol=2e-6,atol=1e-10)
        self.assertGreater(float(colored[0,0]),float(colored[0,2]))

    def test_explicit_source_budgets_reach_moon_direct_air_and_both_sky_paths(self):
        points=np.array([[1.002,0.,0.]]);rays=np.array([[-1.,0.,0.]])
        physical=datetime(2024,11,17,tzinfo=timezone.utc)
        state=SimpleNamespace(direction=np.array([[1.,0.,0.]]),ratio=np.array([2.5e-6]),
                              visibility=np.ones(1))
        lunar=SimpleNamespace(lunar_illumination=Mock(return_value=state))
        sky=(np.tile([1.,0.,0.],(1,3,1)),np.ones((1,3,3)),np.ones(3))
        # Small explicit budgets must stay small; normal 8/12-step profiles
        # retain their 4/6-step sky paths. Omitted budgets use the profile.
        cases=((12,1,3,1),(12,2,5,2),(12,8,7,4),(12,12,9,6),
               (4,None,None,4),(8,None,None,4),(12,None,None,6))
        for profile,cloud_count,air_count,sky_count in cases:
            quality=SimpleNamespace(cloud_sun_steps=profile,atmosphere_sun_steps=11)
            with self.subTest(profile=profile,cloud=cloud_count,air=air_count),\
                 patch.dict(sys.modules,{'moonlighting':lunar}),\
                 patch.object(cloud,'get_quality',return_value=quality),\
                 patch.object(cloud,'_cloud_optical_depth',return_value=np.zeros(1)) as cloud_depth,\
                 patch.object(atmosphere,'optical_depth',return_value=np.zeros((1,3))) as air_depth,\
                 patch.object(lighting,'sky_samples',return_value=sky):
                value=cloud._moon_source(points,rays,0,physical,(),moonlight=1.,
                    cloud_samples=cloud_count,atmosphere_samples=air_count)
                self.assertTrue(np.all(value>0))
                self.assertEqual([call.kwargs.get('samples') for call in cloud_depth.call_args_list],
                                 [cloud_count,sky_count,sky_count,sky_count])
                self.assertEqual(air_depth.call_args.kwargs['samples'],11 if air_count is None else air_count)
                cloud_depth.reset_mock()
                cloud._cloud_source(points,rays,np.array([1.,0.,0.]),0,(),np.ones(1)*.0001,
                    points/np.linalg.norm(points,axis=-1,keepdims=True),np.zeros(1),np.zeros((1,3)),
                    lighting=1.,sun_samples=cloud_count)
                self.assertEqual([call.kwargs.get('samples') for call in cloud_depth.call_args_list],
                                 [sky_count,sky_count,sky_count])

    def test_layered_integrator_forwards_explicit_budget_to_sun_and_moon_sources(self):
        def density(points,*args,**kwargs):
            return np.full(len(points),.0001),points/np.linalg.norm(points,axis=-1,keepdims=True)
        def black(points,*args,**kwargs):return np.zeros((len(points),3))
        with patch.object(cloud,'_density',side_effect=density),\
             patch.object(cloud,'_cloud_source',side_effect=black) as solar,\
             patch.object(cloud,'_moon_source',side_effect=black) as lunar,\
             patch.object(cloud,'_city_source',side_effect=black):
            cloud._integrate(np.array([[1.04,0,0]]),np.array([[-1.,0,0]]),np.zeros(1),
                np.array([.04]),0,np.array([1.,0,0]),fields=(),substeps=1,sun_samples=2,
                physical_dt=datetime(2024,11,17,tzinfo=timezone.utc))
        self.assertGreater(solar.call_count,0);self.assertEqual(lunar.call_count,solar.call_count)
        self.assertTrue(all(call.kwargs.get('sun_samples')==2 for call in solar.call_args_list))
        self.assertTrue(all(call.kwargs.get('cloud_samples')==2 for call in lunar.call_args_list))

    def test_city_glow_wrapper_clips_aircraft_prefix_and_forwards_both_clocks(self):
        physical=datetime(2030,11,17,tzinfo=timezone.utc)
        weather_time=datetime(2026,10,18,tzinfo=timezone.utc)
        origin=np.array([1.04,0,0]);rays=np.tile([-1.,0,0],(2,2,1))
        fields=object();calls=[]
        def density(points,*args,**kwargs):
            return np.full(len(points),.0001),points/np.linalg.norm(points,axis=-1,keepdims=True)
        def source(points,when,sun,physical_dt,actual_fields,**kwargs):
            calls.append((when,physical_dt,actual_fields))
            low=(cloud._geographic(points)[2]<5000)&(physical_dt is not None)
            return low[:,None]*np.array([[.3,.1,.02]])
        options=dict(size=(2,2),center=(1,1),camera_rays=(origin,rays),aircraft_depth=np.full((2,2),.02))
        quality=SimpleNamespace(cloud_scale=1.,cloud_substeps=1,cloud_sun_steps=1)
        with patch.object(cloud,'AIRCRAFT_CROP',2),patch.object(cloud,'get_quality',return_value=quality),\
             patch.object(cloud,'pixel_rays',return_value=(origin,rays)),\
             patch.object(cloud,'_frame_fields',return_value=fields),\
             patch.object(cloud,'_density',side_effect=density),patch.object(cloud,'_city_source',side_effect=source):
            baseline=cloud.render_cloud_volume(np.eye(3),[-1,0,0],weather_time,500,10000,**options)
            lit=cloud.render_cloud_volume(np.eye(3),[-1,0,0],weather_time,500,10000,physical_dt=physical,**options)
        self.assertTrue(np.all(lit.layer.radiance>baseline.layer.radiance))
        np.testing.assert_array_equal(lit.layer.transmittance,baseline.layer.transmittance)
        np.testing.assert_array_equal(lit.foreground_layer.radiance,baseline.foreground_layer.radiance)
        np.testing.assert_array_equal(lit.foreground_layer.transmittance,baseline.foreground_layer.transmittance)
        self.assertTrue(np.all(lit.foreground_layer.transmittance<1))  # The clipped prefix still contains cloud.
        self.assertEqual({w for w,_,_ in calls},{weather_time})
        self.assertEqual({p for _,p,_ in calls},{None,physical})
        self.assertTrue(all(f is fields for _,_,f in calls))


class AtmosphereTransportTests(unittest.TestCase):
    def test_tangent_optical_depth_exceeds_vertical(self):
        points=np.array([[0,0,1.001],[0,0,1.001]])
        rays=np.array([[0,0,1.],[1.,0,0]])
        _,length,_=atmosphere.sphere_interval(points,rays,atmosphere.OUTER_KM/atmosphere.EARTH_KM)
        tau=atmosphere.optical_depth(points,rays,length,samples=100)
        self.assertTrue(np.all(tau[1]>tau[0]*5))
        self.assertTrue(np.all(tau[:,2]>tau[:,0]))

    def test_sun_shadow_and_forward_phase(self):
        shadow=atmosphere.earth_shadow(np.array([[0,0,1.01],[0,0,-1.01],[1.01,0,-.01]]),[0,0,1])
        np.testing.assert_array_equal(shadow,[False,True,False])
        self.assertGreater(float(atmosphere.phase_mie(1)),float(atmosphere.phase_mie(-1))*100)

    def test_atmosphere_depth_extinction_and_multiple_scattering(self):
        origin=np.array([0,0,1.15]);rays=np.array([[0,0,-1.]])
        lit=atmosphere.integrate_atmosphere_rays(origin,rays,[0,0,1],view_samples=48,sun_samples=24)
        single=atmosphere.integrate_atmosphere_rays(origin,rays,[0,0,1],view_samples=48,sun_samples=24,multiple_scattering=0)
        short=atmosphere.integrate_atmosphere_rays(origin,rays,[0,0,1],depth=.06,view_samples=48,sun_samples=24)
        dark=atmosphere.integrate_atmosphere_rays(origin,rays,[0,0,-1],view_samples=48,sun_samples=24)
        self.assertTrue(np.all(lit[1]<short[1]))
        self.assertTrue(np.all(lit[0]>=single[0]))
        self.assertGreater(float(np.sum(lit[0])),float(np.sum(dark[0]))*10)
        self.assertTrue(np.all(np.isfinite(lit[0])))
        beyond=atmosphere.integrate_atmosphere_rays(origin,rays,[0,0,1],depth=.001)
        np.testing.assert_array_equal(beyond[0],0);np.testing.assert_array_equal(beyond[1],1)

    def test_transport_preserves_hdr_and_frame_order(self):
        args=(np.eye(3),np.array([0,0,1.]),300)
        ray=(np.array([0,0,1.2]),np.array([[[0,0,-1.]]]))
        layer=atmosphere.atmosphere_transport(*args,size=(1,1),center=(.5,.5),camera_rays=ray,strength=100)
        atmosphere.atmosphere_transport(*args,size=(1,1),center=(.5,.5),camera_rays=ray,strength=.1)
        repeated=atmosphere.atmosphere_transport(*args,size=(1,1),center=(.5,.5),camera_rays=ray,strength=100)
        np.testing.assert_array_equal(layer.radiance,repeated.radiance)
        np.testing.assert_array_equal(layer.transmittance,repeated.transmittance)
        self.assertGreater(float(layer.radiance.max()),1.)
        self.assertEqual(layer.radiance.dtype,np.float32)


if __name__=='__main__':unittest.main()

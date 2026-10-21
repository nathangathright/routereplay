"""Real-GPU weather parity, plus portable epoch/cache-selection checks."""
import ast
from functools import lru_cache
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np
from scipy.ndimage import map_coordinates

ENGINE=Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts/engine'
sys.path.insert(0,str(ENGINE))
import metal_weather as metal


def bind(filename,names,env):
    nodes=[node for node in ast.parse((ENGINE/filename).read_text()).body
           if isinstance(node,ast.FunctionDef) and node.name in names]
    exec(compile(ast.Module(body=nodes,type_ignores=[]),str(ENGINE/filename),'exec'),env)
    return env


def fixtures(zero=False):
    epoch=1792278000.
    times=epoch+np.arange(7)*3600.;heights=np.array([1500.,5500.,10500.])
    rows=np.radians(np.arange(90,-90.1,-.5))[:,None]
    cols=np.radians(np.arange(0,360,.5))[None,:]
    u=np.stack([np.stack([(18.+3*k+t)*np.cos(rows)*np.ones_like(cols) for k in range(3)]) for t in range(7)]).astype(np.float32)
    v=np.stack([np.stack([3*np.sin(cols+.3*t)*np.cos(rows)*np.ones_like(rows) for k in range(3)]) for t in range(7)]).astype(np.float32)
    if zero:u*=0;v*=0
    for a in (u,v,times,heights):a.setflags(write=False)
    winds=(u,v,times,heights)
    @lru_cache(maxsize=16)
    def wind_slice(c,i):return winds[c][i]
    env=dict(np=np,map_coordinates=map_coordinates,EARTH_M=6371000.,MATERIAL_REFERENCE=epoch,VALID_END=times[-1],
             PROFILE_TIMES=epoch+np.array([0,3,6])*3600,PROFILE_HOURS=np.array([0,3,6]),_winds=lambda:winds,_wind_slice=wind_slice)
    bind('weatherfields.py',{'timestamp','time_pair','sample_wind','_displace','backtrace_coordinates'},env)
    weather=SimpleNamespace(**env)
    cover_shape=(7,3,721,1440)
    coverage=np.broadcast_to(np.float32(0),cover_shape)
    @lru_cache(maxsize=6)
    def float_field(index,layer):
        lat=np.radians(np.arange(90,-90.01,-.25))[:,None]
        lon=np.radians(np.arange(0,360,.25))[None,:]
        value=np.asarray(.3+.04*index+.1*layer+.08*np.sin(lon)*np.cos(lat),np.float32)
        value.setflags(write=False);return value
    @lru_cache(maxsize=2)
    def column_fields(hour):
        mass=np.stack([(.3+.1*k+.03*hour+.2*np.sin(cols)*np.cos(rows))*np.ones_like(rows) for k in range(3)]).astype(np.float32)
        centroid=np.asarray(heights[:,None,None]+250*np.cos(cols)*np.cos(rows),np.float32)
        values=mass,mass*centroid
        for value in values:value.setflags(write=False)
        return values
    cl=dict(np=np,map_coordinates=map_coordinates,_forecast=lambda:(coverage,times),_float_field=float_field,
        _column_fields=column_fields,sample_wind=env['sample_wind'],_displace=env['_displace'],timestamp=env['timestamp'],
        PROFILE_TIMES=env['PROFILE_TIMES'],PROFILE_HOURS=env['PROFILE_HOURS'])
    bind('cloudlayers.py',{'_time','_coordinates','_sample','sample_layer_fields'},cl)
    return weather,SimpleNamespace(**cl)


def coordinates():
    rng=np.random.default_rng(712)
    lon=rng.uniform(-np.pi,np.pi,(4,32));lat=rng.uniform(-np.pi/2,np.pi/2,(4,32))
    lon[0,:4]=[0.,np.pi,-np.pi,1.];lat[0,:4]=[np.pi/2,-np.pi/2,0.,np.pi/2]
    return lon,lat


def run(weather,layers,stamp,morphology=True):
    lon,lat=coordinates();interval=np.floor((stamp-weather.MATERIAL_REFERENCE)/7200)
    current=weather.MATERIAL_REFERENCE+interval*7200;previous=max(weather.MATERIAL_REFERENCE,current-7200)
    x=(stamp-current)/7200;blend=0 if current==previous else x*x*(3-2*x)
    actual=metal.frame_fields(lon,lat,stamp,shape=lon.shape,morphology=morphology,
        previous=previous,current=current,blend=blend,weather=weather,layers=layers)
    reference=[]
    for layer,height in enumerate((1500,5500,10500)):
        macro=layers.sample_layer_fields(lon,lat,stamp,layer)
        def seed(epoch):
            x,y=weather.backtrace_coordinates(lon,lat,height,stamp,reference=epoch)
            return np.stack([np.cos(y)*np.cos(x),np.cos(y)*np.sin(x),np.sin(y)])
        old=seed(previous if morphology else weather.MATERIAL_REFERENCE)
        values=(*macro,*old)
        if morphology:values=(*values,*seed(current))
        arrays=[np.asarray(a,np.float32).reshape(lon.shape) for a in values]
        reference.append(tuple(arrays) if not morphology else (*arrays,blend))
    return actual,tuple(reference)


class WeatherSchedulingTests(unittest.TestCase):
    def test_exact_epoch_anchored_steps_and_long_span_budget(self):
        np.testing.assert_array_equal(metal._boundaries(7200.01,0),[7200.01,7200,3600,0])
        np.testing.assert_array_equal(metal._boundaries(7200,0),[7200,3600,0])
        np.testing.assert_array_equal(metal._boundaries(-7200.01,0),[-7200.01,-7200,-3600,0])
        self.assertEqual(len(metal._boundaries(100*86400,0)),65)
        np.testing.assert_array_equal(metal._boundaries(3,3),[3])

    def test_explicit_metal_dispatch_preserves_exact_time_and_errors(self):
        node=next(n for n in ast.parse((ENGINE/'cloudvolume.py').read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='_frame_fields')
        node.decorator_list=[]
        env=dict(np=np,TRIP=SimpleNamespace(style={'cloud_morphology':1}),
            weatherfields=SimpleNamespace(MATERIAL_REFERENCE=0.,VALID_END=3600.),
            os=SimpleNamespace(environ={'FLIGHT_COMPUTE':'metal'}),MATERIAL_INTERVAL_SECONDS=7200.,MACRO_GRID_DEGREES=1.,
            _smoothstep=lambda a,b,x:x, sample_layer_fields=lambda *a:None)
        exec(compile(ast.Module(body=[node],type_ignores=[]),'cloudvolume.py','exec'),env)
        sentinel=object();fake=SimpleNamespace()
        with patch.dict(sys.modules,cloudlayers=fake),patch.object(metal,'frame_fields',return_value=sentinel) as kernel:
            self.assertIs(env['_frame_fields'](1200.123),sentinel)
            self.assertEqual(kernel.call_args.args[2],1200.123)
        with patch.dict(sys.modules,cloudlayers=fake),patch.object(metal,'frame_fields',side_effect=RuntimeError('device failed')):
            with self.assertRaisesRegex(RuntimeError,'device failed'):env['_frame_fields'](1200.)


class MetalWeatherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:metal.backend()
        except RuntimeError as exc:raise unittest.SkipTest(str(exc))
        cls.weather,cls.layers=fixtures()

    def tearDown(self):metal.clear_upload_cache()

    def check(self,stamp,morphology=True,weather=None,layers=None):
        actual,expected=run(weather or self.weather,layers or self.layers,stamp,morphology)
        for a,b in zip(actual,expected):
            np.testing.assert_allclose(a[0],b[0],atol=3e-5,rtol=0)
            np.testing.assert_allclose(a[1],b[1],atol=3e-5,rtol=0)
            np.testing.assert_allclose(a[2],b[2],atol=.02,rtol=0)
            for x,y in zip(a[3:9],b[3:9]):np.testing.assert_allclose(x,y,atol=1e-5,rtol=0)
            self.assertTrue(all(not x.flags.writeable for x in a if isinstance(x,np.ndarray)))
        return actual

    def test_exact_forecast_endpoints_fractional_time_and_chart_boundaries(self):
        epoch=self.weather.MATERIAL_REFERENCE
        for seconds in (0.,3600.,7199.9,7200.,7200.1,10800.125,21600.):
            with self.subTest(seconds=seconds):self.check(epoch+seconds)

    def test_legacy_zero_wind_and_out_of_order_calls(self):
        epoch=self.weather.MATERIAL_REFERENCE
        self.check(epoch+15432.125,False)
        weather,layers=fixtures(zero=True)
        self.check(epoch+15432.125,weather=weather,layers=layers)
        first=self.check(epoch+12345.678)
        self.check(epoch+321.)
        again=self.check(epoch+12345.678)
        for a,b in zip(first,again):
            for x,y in zip(a,b):np.testing.assert_array_equal(x,y)

    def test_long_legacy_history_remains_bounded_and_matches_reference(self):
        weather,layers=fixtures(zero=True)
        stamp=weather.MATERIAL_REFERENCE+100*86400
        weather.VALID_END=stamp
        self.check(stamp,False,weather=weather,layers=layers)

    def test_nearly_empty_columns_keep_reference_centroid_branch(self):
        original=self.layers._column_fields
        @lru_cache(maxsize=2)
        def tiny(hour):
            tau,moment=original(hour)
            values=tau*1e-6,moment*1e-6
            for value in values:value.setflags(write=False)
            return values
        # sample_layer_fields was bound from production code, so update both
        # its globals and the source provider passed to Metal.
        env=self.layers.sample_layer_fields.__globals__
        with patch.object(self.layers,'_column_fields',side_effect=tiny),patch.dict(env,_column_fields=tiny):
            self.check(self.weather.MATERIAL_REFERENCE+12345.678)

    def test_continuously_animated_fractional_frames(self):
        epoch=self.weather.MATERIAL_REFERENCE
        before,_=run(self.weather,self.layers,epoch+12345.01)
        after,_=run(self.weather,self.layers,epoch+12345.99)
        self.assertGreater(float(np.max(np.abs(before[0][3]-after[0][3]))),1e-8)
        self.assertGreater(float(np.max(np.abs(before[0][0]-after[0][0]))),1e-8)

    def test_upload_cache_bound_immutability_and_mutable_refresh(self):
        for i in range(18):
            array=np.full(10,i,np.float32);array.setflags(write=False);metal._upload([array])
        self.assertEqual(len(metal._UPLOADS),metal._UPLOAD_LIMIT)
        mutable=np.arange(10,dtype=np.float32)
        a=np.array(metal._upload([mutable]));mutable+=20;b=np.array(metal._upload([mutable]))
        np.testing.assert_array_equal(b,a+20)

    def test_probe_without_trip_or_forecast_assets(self):metal.probe()

    def test_unsupported_grid_requests_explicit_cpu_selection(self):
        bad=(np.zeros((2,3,2,2)),np.zeros((2,3,2,2)),np.array([0.,1.]),np.array([1.,2.,3.]))
        with patch.object(self.weather,'_winds',return_value=bad):
            with self.assertRaisesRegex(ValueError,'--compute cpu'):
                run(self.weather,self.layers,self.weather.MATERIAL_REFERENCE)

    def test_coverage_validation_and_runtime_errors_are_not_silenced(self):
        epoch=self.weather.MATERIAL_REFERENCE
        with self.assertRaisesRegex(ValueError,'coverage'):run(self.weather,self.layers,epoch-1)
        with patch.object(metal,'backend',side_effect=RuntimeError('device lost')):
            with self.assertRaisesRegex(RuntimeError,'device lost'):run(self.weather,self.layers,epoch)

if __name__=='__main__':unittest.main()

"""Exact source batching: every light, clock, threshold and footprint survives."""
import ast
from datetime import datetime, timezone
import importlib
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/route-replay/scripts'
sys.path[:0]=[str(SCRIPTS),str(SCRIPTS/'engine')]
from camera_geometry import sphere_interval
from cityglow import ground_illumination
from solar_visibility import solar_visibility
from quality import get_quality

_names=('runtime','atmosphere','cloudlighting','moonlighting','celestial','starfield')
_saved={name:sys.modules.get(name) for name in _names}
for _name in _names:sys.modules.pop(_name,None)
sys.modules['runtime']=SimpleNamespace(TRIP=SimpleNamespace(style={}),ASSETS=Path('/unused'))
try:
    air=importlib.import_module('atmosphere')
    lighting=importlib.import_module('cloudlighting')
    moonlighting=importlib.import_module('moonlighting')
finally:
    for _name,_module in _saved.items():
        if _module is None:sys.modules.pop(_name,None)
        else:sys.modules[_name]=_module


def reference_cloud(style=None,depth=None):
    """Bind the complete production reference source without runtime assets."""
    path=SCRIPTS/'engine/cloudvolume.py'
    names={'_cloud_source','_sky_source','_moon_source','_sample_source'}
    nodes=[node for node in ast.parse(path.read_text()).body
           if isinstance(node,ast.FunctionDef) and node.name in names]
    env=dict(np=np,os=SimpleNamespace(environ={}),solar_visibility=solar_visibility,
             sphere_interval=sphere_interval,get_quality=get_quality,HEIGHT_EXAGGERATION=12.,
             TRIP=SimpleNamespace(style={} if style is None else style))
    calls=[]
    def optical_depth(points,directions,dt,**kwargs):
        calls.append(('depth',dt,len(points),kwargs.get('samples')))
        if depth is not None:return depth(points,directions,**kwargs)
        points=np.asarray(points,np.float32)
        directions=np.broadcast_to(np.asarray(directions,np.float32),points.shape)
        return (.4+.1*np.sum(points*directions,axis=-1)).astype(np.float32)
    def city(points,dt,sun,physical_dt,fields,*,strength=None,batched=False):
        calls.append(('city',dt,physical_dt,batched))
        if physical_dt is None:return np.zeros((len(points),3),np.float32)
        def source(lon,lat):
            return .05+np.stack((np.cos(lon)**2,np.sin(lat)**2,np.cos(lat)**2),axis=-1)*.1
        return ground_illumination(points,source,lambda p:np.full(len(p),.0002),
            height_exaggeration=12.,batched=batched)
    env.update(_cloud_optical_depth=optical_depth,_city_source=city)
    exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),env)
    return SimpleNamespace(**env),calls


class SourceBatchingTests(unittest.TestCase):
    def setUp(self):
        patcher=patch.dict(sys.modules,{'atmosphere':air,'cloudlighting':lighting,'moonlighting':moonlighting})
        patcher.start();self.addCleanup(patcher.stop)
        rng=np.random.default_rng(112)
        up=rng.normal(size=(97,3));up/=np.linalg.norm(up,axis=-1,keepdims=True)
        self.points=up*(1+rng.uniform(300,15000,(len(up),1))*12/6371000.)
        self.rays=-up
        self.sun=np.array([.2,.8,.5]);self.sun/=np.linalg.norm(self.sun)
        self.physical=datetime(2026,10,18,1,39,tzinfo=timezone.utc)
        self.weather=datetime(2026,10,17,20,39,tzinfo=timezone.utc)

    def compare(self,style=None,physical=True,depth=None):
        cloud,calls=reference_cloud(style,depth)
        when=self.physical if physical else None
        args=(self.points,self.rays,self.sun,self.weather,())
        expected=cloud._sample_source(*args,np.ones(len(self.points)),self.rays,
            physical_dt=when,sun_samples=8)
        calls.clear()
        result=lighting.sample_source_batched(cloud,*args,physical_dt=when,sun_samples=8)
        np.testing.assert_allclose(result,expected,rtol=3e-6,atol=3e-8)
        self.assertTrue(np.isfinite(result).all());self.assertTrue(np.all(result>=0))
        self.assertLessEqual(sum(call[0]=='depth' for call in calls),2)
        self.assertTrue(all(call[1]==self.weather for call in calls))
        self.assertIn(('city',self.weather,when,True),calls)
        return cloud,result

    def test_day_twilight_night_and_moon_share_paths_without_losing_sources(self):
        self.compare()
        for strength in (0.,1.,20000.):self.compare({'moonlight':strength})
        self.compare(physical=False)
        self.compare({'atmosphere_strength':0.})

    def test_tiling_order_and_repeated_calls_are_independent(self):
        cloud,expected=self.compare()
        for size in (1,31,200):
            result=lighting.sample_source_batched(cloud,self.points,self.rays,self.sun,self.weather,(),
                physical_dt=self.physical,sun_samples=8,tile_points=size)
            np.testing.assert_allclose(result,expected,rtol=3e-6,atol=3e-8)
        order=np.random.default_rng(12).permutation(len(self.points))
        result=lighting.sample_source_batched(cloud,self.points[order],self.rays[order],self.sun,self.weather,(),
            physical_dt=self.physical,sun_samples=8)
        np.testing.assert_allclose(result,expected[order],rtol=3e-6,atol=3e-8)

    def test_empty_and_invalid_requests_do_not_query_sources(self):
        cloud,calls=reference_cloud()
        result=lighting.sample_source_batched(cloud,np.empty((0,3)),np.empty((0,3)),self.sun,self.weather,())
        self.assertEqual(result.shape,(0,3));self.assertFalse(calls)
        for size in (0,-1,1.5,True):
            with self.assertRaises(ValueError):
                lighting.sample_source_batched(cloud,self.points,self.rays,self.sun,self.weather,(),tile_points=size)

    def test_selector_preserves_cpu_legacy_and_explicit_reference_paths(self):
        path=SCRIPTS/'engine/cloudvolume.py'
        node=next(node for node in ast.parse(path.read_text()).body
                  if isinstance(node,ast.FunctionDef) and node.name=='_sample_source')
        for compute,gain,selected in (('cpu',1.,'batched'),('metal',.5,'batched'),
                                      ('metal',1.,'reference')):
            env=dict(np=np,TRIP=SimpleNamespace(style={'cloud_lighting':gain}),
                os=SimpleNamespace(environ={'FLIGHT_COMPUTE':compute,'FLIGHT_CLOUD_SOURCE':selected}),
                solar_visibility=lambda p,s:np.zeros(len(p)),
                _cloud_source=lambda p,*a,**k:np.ones((len(p),3),np.float32),
                _city_source=lambda p,*a,**k:np.ones((len(p),3),np.float32)*2,
                _moon_source=lambda p,*a,**k:np.ones((len(p),3),np.float32)*3)
            exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),env)
            with patch.object(lighting,'sample_source_batched',side_effect=AssertionError('unsupported source dispatch')):
                value=env['_sample_source'](self.points,self.rays,self.sun,self.weather,(),None,None)
            np.testing.assert_array_equal(value,6.)

    def test_city_taps_and_column_sample_positions_are_identical(self):
        outputs=[];positions=[]
        for batched in (False,True):
            taps=[];columns=[]
            def source(lon,lat):
                taps.append(np.stack((lon,lat),axis=-1))
                return .1+np.stack((np.cos(lon)**2,np.sin(lat)**2,np.cos(lat)**2),axis=-1)
            def density(points):
                columns.append(points.copy())
                return (.0002+.0001*np.sin(points[:,2])).astype(np.float32)
            outputs.append(ground_illumination(self.points,source,density,height_exaggeration=12.,batched=batched))
            positions.append((np.concatenate(taps),np.concatenate(columns)))
        np.testing.assert_array_equal(outputs[0],outputs[1])
        for first,second in zip(*positions):np.testing.assert_array_equal(first,second)


class MetalSourceBatchingTests(SourceBatchingTests):
    @classmethod
    def setUpClass(cls):
        import metal_clouds
        try:metal_clouds.backend()
        except RuntimeError as exc:raise unittest.SkipTest(str(exc))

    def test_real_metal_light_paths_match_reference_source(self):
        import metal_clouds
        from test_metal_clouds import fields
        field=fields(blend=.5)
        noise=np.random.default_rng(222).random((64,64,64),dtype=np.float32);noise.setflags(write=False)
        def depth(points,directions,**kwargs):
            return metal_clouds.cloud_optical_depth(points,directions,field,noise=noise,
                samples=kwargs['samples'],strength=1.,height_exaggeration=12.,morphology=1)
        self.compare(depth=depth)


if __name__=='__main__':unittest.main()

"""Optional real-GPU cloud parity; ordinary CPU installations skip GPU cases."""
import ast
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np
from scipy.ndimage import map_coordinates,gaussian_filter

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts'
sys.path[:0]=[str(SCRIPTS),str(SCRIPTS/'engine')]
import metal_clouds as metal
from camera_geometry import sphere_interval
from cloudshapes import density_shape
from acceleration import compute_device


def reference(noise,morphology,compute="cpu"):
    """Bind production CPU density/integral without trip or weather assets."""
    path=SCRIPTS/'engine/cloudvolume.py'
    names={'_geographic','_smoothstep','_sample_field','_noise3','_density','_cloud_optical_depth'}
    nodes=[n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name in names]
    env=dict(np=np,map_coordinates=map_coordinates,EARTH_M=6371000.,HEIGHT_EXAGGERATION=12.,MAX_ALTITUDE_M=16000.,
             COLUMN_EXTINCTION_SCALE=.18,LAYER_MAX_OPTICAL_DEPTHS=(6.,4.,2.),LAYER_BASE_DEPTHS_M=(700.,1200.,1500.),
             LAYER_TOP_DEPTHS_M=(1700.,2200.,2500.),_NOISE=noise,density_shape=density_shape,sphere_interval=sphere_interval,
             TRIP=SimpleNamespace(style={'cloud_morphology':morphology}),os=SimpleNamespace(environ={'FLIGHT_COMPUTE':compute}))
    exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),env)
    return env['_cloud_optical_depth']


def fields(rows=37,columns=72,blend=None):
    lat,lon=np.meshgrid(np.linspace(np.pi/2,-np.pi/2,rows),np.arange(columns)*2*np.pi/columns,indexing='ij')
    seed=np.stack([np.cos(lat)*np.cos(lon),np.cos(lat)*np.sin(lon),np.sin(lat)])
    second=np.stack([np.cos(lat)*np.cos(lon+.03),np.cos(lat)*np.sin(lon+.03),np.sin(lat)])
    result=[]
    for height in (1500.,5500.,10500.):
        values=(.65+.3*np.sin(lon)**2,2+np.cos(lat)**2,height+200*np.sin(lon),*seed)
        if blend is not None:values=(*values,*second)
        arrays=[np.asarray(a,np.float32) for a in values]
        for array in arrays:array.setflags(write=False)
        result.append(tuple(arrays) if blend is None else (*arrays,blend))
    return tuple(result)


class CloudSelectionTests(unittest.TestCase):
    def test_cloud_probe_failure_obeys_selection_only_fallback(self):
        with patch('metal_compute.device_info',return_value={'backend':'metal'}),patch('metal_compute.optical_depth'),patch('metal_clouds.probe',side_effect=RuntimeError('cloud unavailable')):
            self.assertEqual(compute_device('auto')['backend'],'cpu')
            with self.assertRaisesRegex(RuntimeError,'--compute cpu'):compute_device('metal')

    def test_production_dispatch_preserves_sampling_and_density_settings(self):
        sentinel=np.array([.7],np.float32)
        with patch('metal_clouds.cloud_optical_depth',return_value=sentinel) as kernel:
            result=reference(np.zeros((64,64,64),np.float32),1,'metal')([[0,0,1.01]],[0,0,1],None,fields=fields(blend=.5),samples=12,strength=.8)
        self.assertIs(result,sentinel)
        self.assertEqual(kernel.call_args.kwargs['samples'],12)
        self.assertEqual(kernel.call_args.kwargs['strength'],.8)
        self.assertEqual(kernel.call_args.kwargs['morphology'],1)

    def test_density_dispatch_batches_without_runtime_fallback(self):
        noise=np.zeros((64,64,64),np.float32);field=fields(blend=.5)
        density=reference(noise,1,'metal').__globals__['_density']
        with patch('metal_clouds.cloud_density',return_value=np.ones(1024,np.float32)) as kernel:
            sigma,normal=density(np.tile([0,0,1.004],(1024,1)),None,fields=field)
        self.assertEqual(kernel.call_count,1);np.testing.assert_array_equal(sigma,1)
        np.testing.assert_allclose(normal,np.tile([0,0,1],(1024,1)))
        with patch('metal_clouds.cloud_density',side_effect=AssertionError('Tiny batch dispatched')):
            density(np.tile([0,0,1.004],(32,1)),None,fields=field)
        with patch('metal_clouds.cloud_density',side_effect=RuntimeError('device failed')):
            with self.assertRaisesRegex(RuntimeError,'device failed'):density(np.tile([0,0,1.004],(1024,1)),None,fields=field)

    def test_cpu_does_not_probe_clouds(self):
        with patch('metal_clouds.probe',side_effect=AssertionError('GPU accessed')):
            self.assertEqual(compute_device('cpu')['backend'],'cpu')


class MetalCloudTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:metal.backend()
        except RuntimeError as exc:raise unittest.SkipTest(str(exc))
        cls.noise=gaussian_filter(np.random.default_rng(32).random((64,64,64),dtype=np.float32),.32,mode='wrap')
        cls.noise.setflags(write=False)
        rng=np.random.default_rng(192)
        unit=rng.normal(size=(2000,3));unit/=np.linalg.norm(unit,axis=1)[:,None]
        cls.points=(unit*(1+rng.uniform(-100,17000,(2000,1))*12/6371000)).astype(np.float32)
        direction=unit+rng.normal(size=(2000,3))*.8;direction/=np.linalg.norm(direction,axis=1)[:,None]
        cls.directions=direction.astype(np.float32)

    def tearDown(self):metal.clear_upload_cache()

    def compare(self,points,directions,field,morphology,samples=6):
        expected=reference(self.noise,morphology)(points,directions,None,fields=field,samples=samples)
        actual=metal.cloud_optical_depth(points,directions,field,noise=self.noise,samples=samples,morphology=morphology)
        self.assertTrue(np.isfinite(actual).all());self.assertTrue((actual>=0).all())
        np.testing.assert_allclose(np.exp(-actual),np.exp(-expected),atol=.001,rtol=0)
        return actual

    def test_legacy_and_cellular_models_with_seed_blends_and_sample_budgets(self):
        for morphology,blend in ((0,None),(1,None),(1,0.),(1,.5),(1,1.)):
            for samples in (4,12):
                with self.subTest(morphology=morphology,blend=blend,samples=samples):
                    self.compare(self.points,self.directions,fields(blend=blend),morphology,samples)

    def test_grid_sizes_poles_dateline_tangents_and_nonhits(self):
        radius=1+16000*12/6371000
        points=np.array([[0,0,1.001],[0,0,-1.001],[-1.003,1e-6,0],[-1.003,-1e-6,0],
                         [0,0,radius],[0,0,radius+1e-6],[0,0,1.03],[0,0,1.04]],np.float32)
        directions=np.array([[0,0,1],[0,0,-1],[-1,0,0],[-1,0,0],[1,0,0],[1,0,0],[1,0,0],[0,0,1]],np.float32)
        for shape in ((19,36),(41,93)):
            result=self.compare(points,directions,fields(*shape,blend=.5),1,12)
            np.testing.assert_array_equal(result[-3:-2],0)
        self.compare(self.points[:40],[0,0,1],fields(),0)

    def test_empty_zero_strength_and_bad_arguments(self):
        field=fields()
        self.assertEqual(metal.cloud_optical_depth(np.zeros((0,3)),[0,0,1],field,noise=self.noise,samples=4).shape,(0,))
        np.testing.assert_array_equal(metal.cloud_optical_depth(self.points,self.directions,field,noise=self.noise,samples=4,strength=0),0)
        for samples in (0,-1,True,1.5):
            with self.assertRaises(ValueError):metal.cloud_optical_depth(self.points,self.directions,field,noise=self.noise,samples=samples)

    def test_snapshot_cache_is_bounded_and_mutable_inputs_are_refreshed(self):
        for blend in (0.,.5,1.):
            field=fields(blend=blend)
            self.compare(self.points[:100],self.directions[:100],field,1)
        self.assertEqual(len(metal._FIELD_CACHE),2)
        field=tuple(tuple(a.copy() if isinstance(a,np.ndarray) else a for a in layer) for layer in fields(blend=.5))
        first=self.compare(self.points,self.directions,field,1)
        for layer in field:layer[1][:]=0
        second=self.compare(self.points,self.directions,field,1)
        self.assertGreater(float(np.max(first)),0);np.testing.assert_array_equal(second,0)

    def test_chunk_and_call_order_do_not_change_outputs(self):
        field=fields(blend=.5)
        whole=metal.cloud_optical_depth(self.points,self.directions,field,noise=self.noise,samples=4)
        parts=[metal.cloud_optical_depth(p,d,field,noise=self.noise,samples=4) for p,d in zip(np.array_split(self.points,3),np.array_split(self.directions,3))]
        np.testing.assert_array_equal(whole,np.concatenate(parts))
        repeated=metal.cloud_optical_depth(self.points,self.directions,field,noise=self.noise,samples=4)
        np.testing.assert_array_equal(whole,repeated)

    def test_night_visibility_remains_outside_cloud_kernel(self):
        from solar_visibility import solar_visibility
        path=SCRIPTS/'engine/cloudvolume.py'
        node=next(n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='_solar_transmission')
        points=np.array([[1.002,0,0],[-1.002,0,0],[0,0,1.002]],np.float32)
        outputs=[]
        for compute in ('cpu','metal'):
            env=dict(np=np,solar_visibility=solar_visibility,_cloud_optical_depth=reference(self.noise,1,compute))
            exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),env)
            outputs.append(env['_solar_transmission'](points,[1,0,0],None,fields=fields(blend=.5),samples=12))
        self.assertEqual(outputs[1][1],0.)
        np.testing.assert_allclose(outputs[0],outputs[1],atol=.001,rtol=0)

    def test_standalone_density_matches_cpu_for_blends_and_boundary_heights(self):
        for morphology,blend in ((0,None),(1,0.),(1,.5),(1,1.)):
            field=fields(blend=blend)
            cpu=reference(self.noise,morphology).__globals__['_density']
            expected=cpu(self.points,None,fields=field)[0]
            actual=metal.cloud_density(self.points,field,noise=self.noise,morphology=morphology)
            np.testing.assert_allclose(np.exp(-actual*1000),np.exp(-expected*1000),atol=.001,rtol=0)
            np.testing.assert_array_equal(actual,np.concatenate([metal.cloud_density(p,field,noise=self.noise,morphology=morphology) for p in np.array_split(self.points,3)]))
        heights=np.array([-100.,0.,120.,16000.,18000.])
        points=np.zeros((5,3));points[:,2]=1+heights*12/6371000
        np.testing.assert_array_equal(metal.cloud_density(points,fields(),noise=self.noise),0)
        self.assertEqual(metal.cloud_density(np.empty((0,3)),fields(),noise=self.noise).shape,(0,))

    def test_joint_primary_solar_preserves_visibility_and_clipped_geometry(self):
        from solar_visibility import solar_visibility
        path=SCRIPTS/'engine/jointtransport.py'
        nodes=[n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name in ('_cloud_density','solar_optical_depth')]
        for morphology in (0,1):
            field=fields(blend=.5)
            density=reference(self.noise,morphology).__globals__['_density']
            cloud=SimpleNamespace(_density=density,_NOISE=self.noise,MAX_ALTITUDE_M=16000.,HEIGHT_EXAGGERATION=12.,EARTH_M=6371000.)
            results=[]
            for compute in ('cpu','metal'):
                env=dict(np=np,cloud=cloud,sphere_interval=sphere_interval,solar_visibility=solar_visibility,
                         os=SimpleNamespace(environ={'FLIGHT_COMPUTE':compute}),TRIP=SimpleNamespace(style={'cloud_morphology':morphology}))
                exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),env)
                tau,air=env['solar_optical_depth'](self.points,[1.,0.,0.],None,fields=field,with_atmosphere=False,cloud_samples=12)
                np.testing.assert_array_equal(air,0);results.append(tau)
            np.testing.assert_allclose(np.exp(-results[0]),np.exp(-results[1]),atol=.001,rtol=0)
            dark=solar_visibility(self.points,np.array([1.,0.,0.]))==0
            np.testing.assert_array_equal(results[1][dark],0)

    def test_explicit_interval_input_validation_and_runtime_failure_propagates(self):
        for start,step in ((-1.,.1),(0.,-1.),(0.,float('nan'))):
            with self.assertRaises(ValueError):metal.cloud_interval_optical_depth([[0.,0.,1.01]],[0,0,1],start,step,fields(),noise=self.noise,samples=4)
        with patch('metal_clouds.backend',side_effect=RuntimeError('device failed')):
            with self.assertRaisesRegex(RuntimeError,'device failed'):metal.cloud_density(self.points,fields(),noise=self.noise)
            with self.assertRaisesRegex(RuntimeError,'device failed'):metal.cloud_interval_optical_depth(self.points,self.directions,0.,.001,fields(),noise=self.noise,samples=4)

    def test_probe_compiles_both_density_models_without_weather(self):metal.probe()


if __name__=='__main__':unittest.main()

"""Cloud view batching preserves depth, solar boundaries and transport ordering."""
import ast
import importlib
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np

ENGINE=Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts/engine'
sys.path.insert(0,str(ENGINE))
from cloudview import view_samples, integrate_cloud_view
from camera_geometry import sphere_interval
from solar_visibility import shadow_boundaries, split_intervals
import metal_clouds


class CloudViewGeometryTests(unittest.TestCase):
    def test_radial_depth_and_limb_lengths_are_conserved(self):
        origins=np.array([[0.,0.,2.],[0.,0.,2.],[1.01,0.,2.],[2.,0.,2.]])
        rays=np.tile([0.,0.,-1.],(4,1));sun=np.array([1.,0.,0.])
        start,stop,hit=sphere_interval(origins,rays,1+16000*12/6371000)
        ground,_,ground_hit=sphere_interval(origins,rays,1.)
        stop=np.where(ground_hit,np.minimum(stop,ground),stop)
        stop[1]=(stop[1]+start[1])*.5
        p,steps=view_samples(origins,rays,start,stop,sun,substeps=2,height_exaggeration=12.)
        expected=np.where(hit,np.maximum(stop-start,0),0)*6371000/12
        np.testing.assert_allclose(steps.sum(axis=1),expected,rtol=2e-7,atol=.001)
        self.assertTrue(np.isfinite(p).all());self.assertTrue(np.isfinite(steps).all())
        self.assertLess(steps[1].sum(),steps[0].sum())
        for row in range(3):
            distance=np.sum((p[row]-origins[row])*rays[row],axis=-1)[steps[row]>0]
            self.assertTrue(np.all(np.diff(distance)>=-1e-7))
            self.assertGreaterEqual(distance.min()+1e-7,start[row])
            self.assertLessEqual(distance.max()-1e-7,stop[row])

    def test_terminator_subdivision_retains_every_finite_boundary(self):
        origins=np.array([[1.001,0.,2.],[1.005,0.,2.]])
        rays=np.tile([0.,0.,-1.],(2,1));sun=np.array([0.,0.,1.])
        start,stop,_=sphere_interval(origins,rays,1.031)
        points,steps=view_samples(origins,rays,start,stop,sun,substeps=1,height_exaggeration=12.)
        mid=np.sum((points-origins[:,None,:])*rays[:,None,:],axis=-1)
        half=steps*12/6371000/2
        edges=shadow_boundaries(origins,rays,sun)
        for row in range(2):
            for edge in edges[row]:
                self.assertFalse(np.any((steps[row]>0)&(edge>mid[row]-half[row]+2e-7)&(edge<mid[row]+half[row]-2e-7)))

    def test_empty_reversed_depth_and_bad_substeps(self):
        p,steps=view_samples([[0,0,2]],[[0,0,-1]],[1.1],[.9],[1,0,0],substeps=1,height_exaggeration=12)
        self.assertEqual(steps.shape,(1,0));self.assertEqual(p.shape,(1,0,3))
        for count in (0,-1,1.5,True):
            with self.assertRaises(ValueError):view_samples([[0,0,2]],[[0,0,-1]],[0],[1],[1,0,0],substeps=count,height_exaggeration=12)

    def test_all_lighting_sources_and_clocks_survive_shared_helper(self):
        path=ENGINE/'cloudvolume.py'
        node=next(n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='_sample_source')
        calls=[]
        def source(kind,color):
            def call(points,*args,**kwargs):
                calls.append((kind,args,kwargs));return np.broadcast_to(color,(len(points),3)).copy().astype(np.float32)
            return call
        env=dict(np=np,TRIP=SimpleNamespace(style={'cloud_lighting':0}),solar_visibility=lambda p,s:np.zeros(len(p)),
            _cloud_source=source('solar_sky',[1,2,3]),_city_source=source('city',[4,5,6]),_moon_source=source('moon',[7,8,9]))
        exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),env)
        result=env['_sample_source'](np.ones((2,3)),np.ones((2,3)),[0,0,1],100,(),[1,1],np.ones((2,3)),physical_dt=200,sun_samples=8,strength=.8)
        np.testing.assert_array_equal(result,[[12,15,18],[12,15,18]])
        self.assertEqual([c[0] for c in calls],['solar_sky','city','moon'])
        self.assertEqual(calls[1][1][0],100);self.assertEqual(calls[1][1][2],200)
        self.assertEqual(calls[2][1][1:3],(100,200))
        self.assertEqual(calls[2][2]['cloud_samples'],8)

    def test_cpu_and_legacy_lighting_never_enter_metal_view(self):
        path=ENGINE/'cloudvolume.py'
        node=next(n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='_integrate')
        for compute,lighting in (('cpu',1.),('metal',0.),('metal',.5)):
            env=dict(np=np,TRIP=SimpleNamespace(style={'cloud_lighting':lighting}),
                     os=SimpleNamespace(environ={'FLIGHT_COMPUTE':compute,'FLIGHT_CLOUD_VIEW':'batched'}),
                     EARTH_M=6371000.,HEIGHT_EXAGGERATION=12.,MAX_ALTITUDE_M=16000.,VERTICAL_STEP_M=1000.,
                     sphere_interval=sphere_interval,shadow_boundaries=shadow_boundaries,split_intervals=split_intervals)
            exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),env)
            with patch('cloudview.integrate_cloud_view',side_effect=AssertionError('unsupported dispatch')):
                light,t=env['_integrate'](np.array([[0.,0.,2.]]),np.array([[0.,0.,-1.]]),np.array([1.1]),np.array([.9]),0,[1,0,0],fields=(),substeps=1)
            np.testing.assert_array_equal(light,0);np.testing.assert_array_equal(t,1)


class CloudViewValidationTests(unittest.TestCase):
    def test_invalid_prefix_and_reduction_inputs_fail_before_gpu(self):
        with patch('metal_clouds.backend',side_effect=AssertionError('GPU accessed')):
            for positions,steps in ((np.zeros((1,3)),np.zeros(1)),(np.zeros((1,1,3)),np.full((1,1),-1)),(np.full((1,1,3),np.nan),np.zeros((1,1)))):
                with self.assertRaises(ValueError):metal_clouds.cloud_view_prefix(positions,steps,None,noise=None)
            for offsets in ([1,1],[0,2],[0.,1.],[0,1,0]):
                with self.assertRaises(ValueError):metal_clouds.cloud_view_radiance([[1,1,1]],[1],offsets)
            with self.assertRaises(ValueError):metal_clouds.cloud_view_radiance([[1,-1,1]],[1],[0,1])


class MetalCloudViewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:metal_clouds.backend()
        except RuntimeError as exc:raise unittest.SkipTest(str(exc))
        # The CPU density is the production reference fixture, already exercised
        # against the unchanged standalone Metal density and light-ray kernels.
        sys.path.insert(0,str(Path(__file__).resolve().parent))
        from test_metal_clouds import fields,reference
        cls.field=fields(blend=.5);cls.reference=staticmethod(reference)
        from scipy.ndimage import gaussian_filter
        cls.noise=gaussian_filter(np.random.default_rng(73).random((64,64,64),dtype=np.float32),.32,mode='wrap')
        cls.noise.setflags(write=False)

    def test_fused_prefix_matches_cpu_density_and_ordered_termination(self):
        rng=np.random.default_rng(24)
        up=rng.normal(size=(300,3));up/=np.linalg.norm(up,axis=-1,keepdims=True)
        heights=np.linspace(15500,300,33)
        points=(up[:,None,:]*(1+heights[None,:,None]*12/6371000)).astype(np.float32)
        steps=np.full(points.shape[:2],600,np.float32);steps[:10]=0
        steps[-10:]=1e6  # Exercise the early-opaque cutoff, not just thin rays.
        for morphology in (0,1):
            density=self.reference(self.noise,morphology).__globals__['_density']
            sigma=density(points.reshape(-1,3),None,fields=self.field)[0].reshape(steps.shape)
            expected_t=np.ones(len(points),np.float32);expected_w=np.zeros_like(steps)
            for j in range(steps.shape[1]):
                active=(steps[:,j]>0)&(expected_t>1e-4)&(sigma[:,j]>1e-9)
                opacity=-np.expm1(-sigma[active,j]*steps[active,j])
                expected_w[active,j]=expected_t[active]*opacity;expected_t[active]*=1-opacity
            actual_sigma,weights,t=metal_clouds.cloud_view_prefix(points,steps,self.field,noise=self.noise,morphology=morphology)
            np.testing.assert_allclose(weights,expected_w,atol=.0015,rtol=0)
            np.testing.assert_allclose(t,expected_t,atol=.0015,rtol=0)
            np.testing.assert_allclose(weights.sum(axis=-1)+t,1,atol=2e-6)
            np.testing.assert_array_equal(weights[:10],0)
            for split in (97,205):
                prefix=metal_clouds.cloud_view_prefix(points[:split],steps[:split],self.field,noise=self.noise,morphology=morphology)
                np.testing.assert_array_equal(prefix[1],weights[:split])
                np.testing.assert_array_equal(prefix[2],t[:split])

    def test_macro_support_is_bitwise_exact_for_sparse_gpu_cells(self):
        field=tuple(tuple(a.copy() if isinstance(a,np.ndarray) else a for a in layer) for layer in self.field)
        for layer in field:
            layer[0][:]=0;layer[1][:]=0
            layer[0][4:7,0:2]=.9;layer[1][4:7,0:2]=12
            layer[0][-3:,-2:]=1.;layer[1][-3:,-2:]=20
        rng=np.random.default_rng(98)
        up=rng.normal(size=(30000,3));up/=np.linalg.norm(up,axis=-1,keepdims=True)
        points=(up*(1+rng.uniform(100,16000,(len(up),1))*12/6371000)).astype(np.float32)
        for morphology in (0,1):
            baseline=metal_clouds.cloud_density(points,field,noise=self.noise,morphology=morphology,occupancy=False)
            skipped=metal_clouds.cloud_density(points,field,noise=self.noise,morphology=morphology,occupancy=True)
            np.testing.assert_array_equal(skipped,baseline)
            self.assertGreater(np.count_nonzero(baseline),0)

    def test_gpu_reduction_preserves_empty_rays_and_source_rgb(self):
        colors=np.array([[1,2,3],[4,5,6],[.1,.2,.3]],np.float32)
        result=metal_clouds.cloud_view_radiance(colors,[.1,.2,.9],[0,2,2,3])
        np.testing.assert_allclose(result,[[.9,1.2,1.5],[0,0,0],[.09,.18,.27]],atol=2e-7)
        self.assertEqual(metal_clouds.cloud_view_radiance(np.empty((0,3)),[],[0]).shape,(0,3))


class MacroSupportTests(unittest.TestCase):
    def test_zero_and_sparse_corner_support_wraps_and_covers_density(self):
        from cloud_occupancy import macro_support
        sys.path.insert(0,str(Path(__file__).resolve().parent))
        from test_metal_clouds import fields,reference
        field=tuple(tuple(a.copy() if isinstance(a,np.ndarray) else a for a in layer) for layer in fields(19,36,blend=.5))
        for layer in field:layer[0][:]=0;layer[1][:]=0
        np.testing.assert_array_equal(macro_support(field),0)
        # One cloudy dateline corner must preserve all cells touching it, even
        # when a sample is outside that corner's nearest-neighbor footprint.
        for layer in field:layer[0][5,0]=1;layer[1][5,0]=20
        mask=macro_support(field)
        self.assertFalse(mask.flags.writeable)
        self.assertTrue(np.all(mask[[4,5]][:,[0,35]]>0))
        rng=np.random.default_rng(97);unit=rng.normal(size=(30000,3));unit/=np.linalg.norm(unit,axis=-1,keepdims=True)
        height=rng.uniform(121,15899,len(unit));points=(unit*(1+height[:,None]*12/6371000)).astype(np.float32)
        noise=np.random.default_rng(71).random((64,64,64),dtype=np.float32)
        radius=np.linalg.norm(points,axis=-1)
        row=np.floor(np.clip((90-np.degrees(np.arcsin(np.clip(points[:,2]/radius,-1,1))))*18/180,0,18)).astype(int)
        col=np.floor((np.degrees(np.arctan2(points[:,1],points[:,0]))%360)*36/360).astype(int)%36
        bins=np.clip(((radius-1)*6371000/12/1000).astype(int),0,15)
        allowed=(mask[row,col]&(np.uint32(1)<<bins.astype(np.uint32)))!=0
        for morphology in (0,1):
            density=reference(noise,morphology).__globals__['_density'](points,None,fields=field)[0]
            np.testing.assert_array_equal(density[~allowed],0)
        self.assertLess(allowed.sum(),len(points)//10)


if __name__=='__main__':unittest.main()

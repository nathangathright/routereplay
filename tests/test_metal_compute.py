"""Optional real GPU parity tests; CPU-only installations skip the GPU cases."""
import ast
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts'
sys.path[:0]=[str(SCRIPTS),str(SCRIPTS/'engine')]
from acceleration import compute_device
from metal_compute import optical_depth,backend
CONSTANTS=[6371.,720.,57.6,8.64,.0058/7.2,.0135/7.2,.0331/7.2,.0030/7.2/.9]


def reference(compute="cpu"):
    source=SCRIPTS/'engine/atmosphere.py'
    node=next(n for n in ast.parse(source.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='optical_depth')
    # Bind the CPU dispatch off even when called from an accelerated environment.
    env={'np':np,'os':SimpleNamespace(environ={'FLIGHT_COMPUTE':compute}),'EARTH_KM':6371.,'OUTER_KM':7091.,'H_R':57.6,'H_M':8.64,
         'BETA_R':np.array(CONSTANTS[4:7],np.float32),'MIE_EXTINCTION':CONSTANTS[7]}
    exec(compile(ast.Module(body=[node],type_ignores=[]),str(source),'exec'),env)
    return env['optical_depth']


class ComputeSelectionTests(unittest.TestCase):
    def test_cpu_does_not_import_optional_backend(self):
        with patch('metal_compute.device_info',side_effect=AssertionError('GPU accessed')):
            self.assertEqual(compute_device('cpu')['backend'],'cpu')

    def test_production_optical_depth_dispatches_when_metal_selected(self):
        sentinel=np.array([[.1,.2,.3]])
        with patch('metal_compute.optical_depth',return_value=sentinel) as kernel:
            result=reference('metal')([[0,0,1.01]],[0,0,1],[.01],samples=6)
        self.assertIs(result,sentinel)
        self.assertEqual(kernel.call_args.kwargs['samples'],6)
        self.assertEqual(len(kernel.call_args.kwargs['constants']),8)

    def test_unavailable_optional_backend_has_explicit_fallback(self):
        with patch('metal_compute.device_info',side_effect=RuntimeError('unavailable')):
            self.assertEqual(compute_device('auto')['backend'],'cpu')
            with self.assertRaisesRegex(RuntimeError,'--compute cpu'):compute_device('metal')


class MetalComputeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:backend()
        except RuntimeError as exc:raise unittest.SkipTest(str(exc))

    def test_cpu_parity_spherical_sun_paths_and_sample_budgets(self):
        rng=np.random.default_rng(834)
        points=rng.normal(size=(5000,3));points/=np.linalg.norm(points,axis=1)[:,None]
        points*=rng.uniform(1.0001,1.112,size=(len(points),1))
        direction=np.array([.8,.2,.3]);direction/=np.linalg.norm(direction)
        b=points@direction
        length=np.maximum(-b+np.sqrt(np.maximum(b*b+(7091/6371)**2-np.sum(points*points,axis=1),0)),0)
        for samples in (6,16,32):
            expected=reference()(points,direction,length,samples=samples)
            actual=optical_depth(points,direction,length,samples=samples,constants=CONSTANTS)
            self.assertTrue(np.isfinite(actual).all());self.assertTrue((actual>=0).all())
            np.testing.assert_allclose(np.exp(-actual),np.exp(-expected),atol=3e-5,rtol=0)

    def test_near_ground_density_classification_uses_original_float64_inputs(self):
        offsets=np.linspace(-1e-8,1e-8,101)
        points=np.tile([0.,0.,1.01],(len(offsets),1));points[:,2]+=offsets
        lengths=np.full(len(offsets),.02)
        expected=reference()(points,[0.,0.,-1.],lengths,samples=3)
        actual=optical_depth(points,[0.,0.,-1.],lengths,samples=3,constants=CONSTANTS)
        np.testing.assert_allclose(np.exp(-actual),np.exp(-expected),atol=1e-7,rtol=0)

    def test_shapes_zero_segments_and_invalid_samples(self):
        result=optical_depth([0,0,1.01],[0,0,1],np.zeros((2,3)),samples=2,constants=CONSTANTS)
        self.assertEqual(result.shape,(2,3,3));np.testing.assert_array_equal(result,0)
        empty=optical_depth(np.zeros((0,3)),[0,0,1],[],samples=2,constants=CONSTANTS)
        self.assertEqual(empty.shape,(0,3))
        for value in (0,-1,True,2.5):
            with self.assertRaises(ValueError):optical_depth([0,0,1],[0,0,1],1,samples=value,constants=CONSTANTS)


if __name__=='__main__':unittest.main()

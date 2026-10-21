"""Clear-air lookup parity, conservative coverage, and bounded table reuse."""
import ast
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/route-replay/scripts'
sys.path[:0]=[str(SCRIPTS),str(SCRIPTS/'engine')]
from atmosphere_lookup import optical_depth_lookup, column_table

CONSTANTS=(6371.,720.,57.6,8.64,.0058/7.2,.0135/7.2,.0331/7.2,.003/7.2/.9)


def transport():
    source=SCRIPTS/'engine/atmosphere.py'
    node=next(n for n in ast.parse(source.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='optical_depth')
    env=dict(np=np,os=SimpleNamespace(environ={'FLIGHT_COMPUTE':'cpu'}),
             EARTH_KM=6371.,OUTER_KM=7091.,H_R=57.6,H_M=8.64,
             BETA_R=np.asarray(CONSTANTS[4:7]),MIE_EXTINCTION=CONSTANTS[7])
    exec(compile(ast.Module(body=[node],type_ignores=[]),str(source),'exec'),env)
    return env['optical_depth']


def outward_rays(count=12000):
    rng=np.random.default_rng(901)
    height=np.expm1(rng.uniform(0,np.log1p(720),count))
    radius=1+height/6371.
    mu=rng.uniform(.02,1,count)
    points=np.column_stack((np.zeros(count),np.zeros(count),radius))
    direction=np.column_stack((np.sqrt(1-mu*mu),np.zeros(count),mu))
    b=radius*mu
    length=-b+np.sqrt(b*b+(7091/6371)**2-radius*radius)
    return points,direction,length


class AtmosphereLookupTests(unittest.TestCase):
    def test_transmission_matches_reference_across_budgets(self):
        points,direction,length=outward_rays()
        for samples in (6,10,16,32):
            result,eligible=optical_depth_lookup(points,direction,length,samples=samples,constants=CONSTANTS)
            self.assertTrue(eligible.all())
            reference=transport()(points,direction,length,samples=samples)
            np.testing.assert_allclose(np.exp(-result),np.exp(-reference),atol=1.1e-5,rtol=0)

    def test_partial_inward_tangent_and_nonunit_rays_use_reference(self):
        points,direction,length=outward_rays(10)
        direction[0]=[0,0,-1]
        direction[1]=[1,0,0]
        direction[2]*=1.01
        length[3]*=.5
        result,eligible=optical_depth_lookup(points,direction,length,samples=10,constants=CONSTANTS)
        self.assertFalse(eligible[:4].any())
        self.assertTrue(eligible[4:].all())
        actual=transport()(points,direction,length,samples=10,method='lookup')
        expected=transport()(points,direction,length,samples=10,method='integrate')
        np.testing.assert_array_equal(actual[:4],expected[:4])
        np.testing.assert_allclose(np.exp(-actual[4:]),np.exp(-expected[4:]),atol=1.1e-5,rtol=0)

    def test_boundary_zero_and_empty_paths(self):
        radius=7091/6371
        points=np.array([[0,0,1.],[0,0,radius],[0,0,.99]])
        value,mask=optical_depth_lookup(points,[0,0,1],[radius-1,0,.1],samples=10,constants=CONSTANTS)
        np.testing.assert_array_equal(mask,[True,False,False])
        self.assertTrue(np.isfinite(value).all())
        value,mask=optical_depth_lookup(np.empty((0,3)),[0,0,1],[],samples=10,constants=CONSTANTS)
        self.assertEqual(value.shape,(0,3));self.assertEqual(mask.shape,(0,))

    def test_rotation_and_broadcast_preserve_results(self):
        points,direction,length=outward_rays(24)
        result,mask=optical_depth_lookup(points,direction,length,samples=10,constants=CONSTANTS)
        rotated,_=optical_depth_lookup(points[:,[1,2,0]],direction[:,[1,2,0]],length,samples=10,constants=CONSTANTS)
        np.testing.assert_allclose(result,rotated,atol=1e-14)
        shaped,eligible=optical_depth_lookup(points.reshape(4,6,3),direction.reshape(4,6,3),length.reshape(4,6),samples=10,constants=CONSTANTS)
        np.testing.assert_array_equal(result,shaped.reshape(24,3))
        self.assertEqual(eligible.shape,(4,6))

    def test_dated_aerosol_is_added_exactly_once(self):
        points,direction,length=outward_rays(6);length[0]*=.5
        clear=transport()(points,direction,length,samples=10,method='lookup')
        extra=np.full_like(clear,.125)
        with patch('environmentlighting.product',return_value='dated-local-product'), patch('environmentlighting.aerosol_optical_depth',return_value=extra) as aerosol:
            actual=transport()(points,direction,length,samples=10,method='lookup',weather_dt=object())
        np.testing.assert_allclose(actual,clear+extra,rtol=0,atol=0)
        aerosol.assert_called_once()

    def test_table_cache_is_immutable_and_bounded(self):
        first=column_table(10,CONSTANTS)
        self.assertIs(first,column_table(10,CONSTANTS))
        self.assertFalse(first.flags.writeable)
        for samples in range(1,7):column_table(samples,CONSTANTS)
        self.assertLessEqual(column_table.cache_info().currsize,4)

    def test_invalid_sample_counts(self):
        for samples in (0,-1,True,1.5):
            with self.assertRaises(ValueError):
                optical_depth_lookup([0,0,1],[0,0,1],.1,samples=samples,constants=CONSTANTS)


class MetalAtmosphereLookupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from metal_compute import backend
        try:backend()
        except RuntimeError as error:raise unittest.SkipTest(str(error))

    def test_actual_gpu_table_and_mixed_fallback_transmission(self):
        from metal_compute import optical_depth
        points,direction,length=outward_rays(6000)
        direction[:10]=[0,0,-1]
        length[10:20]*=.5
        for samples in (6,10,16):
            actual=optical_depth(points,direction,length,samples=samples,constants=CONSTANTS,lookup=True)
            expected=transport()(points,direction,length,samples=samples)
            np.testing.assert_allclose(np.exp(-actual),np.exp(-expected),atol=4e-5,rtol=0)

    def test_ground_classification_repair_is_retained(self):
        from metal_compute import optical_depth
        offsets=np.linspace(-1e-8,1e-8,101)
        points=np.tile([0.,0.,1.01],(len(offsets),1));points[:,2]+=offsets
        length=np.full(len(points),.02)
        actual=optical_depth(points,[0,0,-1],length,samples=3,constants=CONSTANTS,lookup=True)
        expected=transport()(points,[0,0,-1],length,samples=3)
        np.testing.assert_allclose(np.exp(-actual),np.exp(-expected),atol=1e-7,rtol=0)


if __name__=='__main__':unittest.main()

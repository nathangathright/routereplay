"""Bounded native cloud-grid geometry without a Blender installation."""
from pathlib import Path
import sys
import unittest
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts/engine'))
from chase_cloud_grid import grid_geometry, GRID_STORAGE_SCALE, NATIVE_CLIPPING_DEFAULT


class NativeCloudGridTests(unittest.TestCase):
    def test_inclusive_world_nodes_and_bounded_far_grid(self):
        bounds=np.array([[-500000,-500000,-40000],[500000,500000,16000]],float)
        actual,resolution,spacing=grid_geometry(bounds,(160,160,192))
        np.testing.assert_array_equal(actual,bounds)
        np.testing.assert_allclose(actual[0]+(np.array(resolution)-1)*spacing,actual[1])
        self.assertEqual(resolution,(160,160,192))
        self.assertLess(spacing[2],300.)

    def test_vertical_column_discretization_retains_smooth_optical_depth(self):
        # Quantify this test's approximation for a kilometre-scale smooth layer;
        # this is not an accuracy promise for every forecast or tiny cloud gap.
        bounds,resolution,spacing=grid_geometry([[-500000,-500000,-40000],[500000,500000,16000]],(160,160,192))
        z=np.linspace(bounds[0,2],bounds[1,2],resolution[2])
        profile=lambda h:.002*np.exp(-((h-3500.)/900.)**2)
        coarse=np.trapezoid(profile(z),z)
        dense=np.linspace(-40000,16000,20001)
        reference=np.trapezoid(profile(dense),dense)
        self.assertAlmostEqual(coarse,reference,places=8)

    def test_storage_scaling_preserves_thin_clouds_and_bounds_clipping_loss(self):
        sigma=np.array([0.,1e-8,1e-6,.0005205,.005],np.float32)
        stored=sigma*GRID_STORAGE_SCALE
        self.assertTrue(np.all(stored[1:]>NATIVE_CLIPPING_DEFAULT))
        np.testing.assert_allclose(stored/GRID_STORAGE_SCALE,sigma,rtol=1e-7)
        threshold=NATIVE_CLIPPING_DEFAULT/GRID_STORAGE_SCALE
        self.assertAlmostEqual(threshold*500000.,.0005)
        self.assertLess(1.-np.exp(-threshold*500000.),.0005)
        self.assertLess(1.-np.exp(-threshold*1500000.),.0015)

    def test_invalid_budget_and_geometry_fail_before_blender(self):
        for resolution in ((1,2,2),(256,256,256),(True,64,64),(64.0,64,64),(64,64)):
            with self.subTest(resolution=resolution),self.assertRaises(ValueError):
                grid_geometry([[0,0,0],[1,1,1]],resolution)
        for bounds in ([[0,0,0],[0,1,1]],[[0,0,0],[1,np.inf,1]],[[0,0],[1,1]]):
            with self.subTest(bounds=bounds),self.assertRaises(ValueError):grid_geometry(bounds,(64,64,64))


if __name__=='__main__':unittest.main()

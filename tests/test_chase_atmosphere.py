"""Physical optical depth references for the shared chase atmosphere."""
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'skills/route-replay/scripts/engine'))
import chase_atmosphere as air


class ChaseAtmosphereTests(unittest.TestCase):
    def test_shared_air_rejects_older_volume_integrator_before_scene_changes(self):
        old_bpy = SimpleNamespace(app=SimpleNamespace(version=(4, 5, 0)))
        with patch.dict(sys.modules, {"bpy": old_bpy}):
            with self.assertRaisesRegex(ValueError, "Blender 5.0"):
                air.build(None)

    def test_height_tracks_sphere_including_distant_clouds(self):
        for x, y, h in ((0, 0, 0), (500000, 500000, 6000), (-400000, 0, 120)):
            z = np.sqrt((air.EARTH_M+h)**2-x*x-y*y)-air.EARTH_M
            self.assertAlmostEqual(float(air.radial_height([x, y, z])), h, places=7)

    def test_zenith_optical_depth_matches_integrated_exponentials(self):
        start = np.array([0., 0., 5000.])
        actual = air.transmittance(start, [0, 0, air.TOP_M], samples=4096)
        expected_tau = (air.RAYLEIGH*air.RAYLEIGH_HEIGHT_M*
                        (np.exp(-5000/air.RAYLEIGH_HEIGHT_M)-np.exp(-air.TOP_M/air.RAYLEIGH_HEIGHT_M)) +
                        air.MIE_SCATTER/air.MIE_ALBEDO*air.MIE_HEIGHT_M*
                        (np.exp(-5000/air.MIE_HEIGHT_M)-np.exp(-air.TOP_M/air.MIE_HEIGHT_M)))
        np.testing.assert_allclose(actual, np.exp(-expected_tau), rtol=1e-6)

    def test_near_aircraft_stays_clear_while_distant_horizon_loses_contrast(self):
        start = [0, 0, 5000]
        near = air.transmittance(start, [160, 0, 5000])
        far = air.transmittance(start, [250000, 0, 100])
        self.assertGreater(near.min(), .997)
        self.assertLess(far.max(), .5)
        self.assertTrue(np.all(far < near))
        self.assertGreater(far[0], far[1])
        self.assertGreater(far[1], far[2])

    def test_reciprocity_and_path_composition(self):
        a, b, c = np.array([0, 0, 10000]), np.array([20000, 0, 10000]), np.array([40000, 0, 10000])
        np.testing.assert_allclose(air.transmittance(a,c), air.transmittance(c,a), atol=1e-12)
        np.testing.assert_allclose(air.transmittance(a,c), air.transmittance(a,b)*air.transmittance(b,c), atol=1e-7)

    def test_profiles_vanish_outside_shell_and_thin_with_altitude(self):
        np.testing.assert_array_equal(air.extinction([-1, 100001]), np.zeros((2,3)))
        self.assertTrue(np.all(np.diff(air.extinction([0, 1500, 5000, 15000]), axis=0) < 0))


if __name__ == '__main__':
    unittest.main()

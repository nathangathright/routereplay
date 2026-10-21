"""Physical contracts for local ground-to-cloud illumination, without asset I/O."""
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

import numpy as np

ENGINE = Path(__file__).resolve().parents[1] / 'skills/route-replay/scripts/engine'
sys.path.insert(0, str(ENGINE))
from cityglow import ground_illumination

EARTH_M = 6_371_000.


def world_points(lon, lat, height_m, scale=1.):
    """Radian locations and physical MSL heights in the exaggerated scene."""
    lon, lat, height_m = np.broadcast_arrays(lon, lat, height_m)
    up = np.stack((np.cos(lat)*np.cos(lon), np.cos(lat)*np.sin(lon), np.sin(lat)), axis=-1)
    return (up * (1 + height_m*scale/EARTH_M)[..., None]).reshape(-1, 3)


def constant_source(color):
    color = np.asarray(color, float)
    return lambda lon, lat: np.broadcast_to(color, (len(lon), 3))


def dark_density(points):
    return np.zeros(len(points))


def local_source(lon, lat):
    """A smooth luminous district near the equator, with a 3 km radius."""
    up = np.column_stack((np.cos(lat)*np.cos(lon), np.cos(lat)*np.sin(lon), np.sin(lat)))
    distance = np.linalg.norm(up - np.array([1., 0., 0.]), axis=-1) * EARTH_M
    brightness = np.exp(-.5*(distance/3000.)**2)
    return brightness[:, None] * np.array([8., 3., 1.])


class CityGlowTests(unittest.TestCase):
    def test_disabled_strength_does_not_read_any_data_provider(self):
        source = Mock(side_effect=AssertionError('source data read'))
        density = Mock(side_effect=AssertionError('weather data read'))
        ground = Mock(side_effect=AssertionError('terrain data read'))
        result = ground_illumination(world_points(0., 0., [500., 3000.]), source, density,
                                     strength=0., ground_height=ground)
        np.testing.assert_array_equal(result, np.zeros((2, 3)))
        source.assert_not_called()
        density.assert_not_called()
        ground.assert_not_called()

    def test_unlit_ground_emits_nothing_and_does_not_sample_extinction(self):
        density = Mock(side_effect=AssertionError('unlit column sampled'))
        result = ground_illumination(world_points(0., 0., [500., 3000.]),
                                     constant_source([0., 0., 0.]), density)
        np.testing.assert_array_equal(result, np.zeros((2, 3)))
        density.assert_not_called()

    def test_uniform_color_response_is_bounded_linear_and_preserves_hdr(self):
        points = world_points(0., 0., 1000.)
        color = np.array([8., 4., 2.])
        base = ground_illumination(points, constant_source(color), dark_density)
        doubled = ground_illumination(points, constant_source(2*color), dark_density)
        dimmed = ground_illumination(points, constant_source(color), dark_density, strength=.25)
        np.testing.assert_allclose(doubled, 2*base, rtol=2e-7)
        np.testing.assert_allclose(dimmed, .25*base, rtol=2e-7)
        self.assertTrue(np.all(np.isfinite(base)) and np.all(base > 0))
        self.assertTrue(np.all(base <= color))
        self.assertGreater(float(base[0, 0]), 1., 'Linear HDR must not clip at display white')
        retention = base[0]/color
        # The documented mild clear-air loss preferentially removes blue.
        self.assertGreater(retention[0], retention[1])
        self.assertGreater(retention[1], retention[2])
        self.assertGreater(retention[2]/retention[0], .9)
        red = ground_illumination(points, constant_source([8., 0., 0.]), dark_density)
        green_blue = ground_illumination(points, constant_source([0., 4., 2.]), dark_density)
        np.testing.assert_allclose(red + green_blue, base, rtol=2e-7)

    def test_increasing_column_density_extinguishes_light_without_a_floor(self):
        points = world_points(0., 0., [500., 2000., 6000.])
        outputs = []
        for extinction in (0., .0002, .002, 1.):
            outputs.append(ground_illumination(points, constant_source([4., 2., 1.]),
                lambda query, sigma=extinction: np.full(len(query), sigma)))
        outputs = np.asarray(outputs)
        self.assertTrue(np.isfinite(outputs).all())
        self.assertTrue((outputs >= 0).all())
        self.assertTrue((np.diff(outputs, axis=0) < 0).all())
        self.assertLess(float(outputs[-1].max()), 1e-30,
                        'Optically thick columns must not retain an ambient-light floor')

    def test_height_exaggeration_preserves_physical_footprint_and_extinction(self):
        results = []
        for scale in (1., 12., 40.):
            points = world_points([0., .0002], [0., -.0001], [1600., 3600.], scale)
            def density(query):
                physical_msl = (np.linalg.norm(query, axis=-1)-1)*EARTH_M/scale
                return .0002 * (1 + .2*np.sin(physical_msl/1000.))
            results.append(ground_illumination(points, local_source, density,
                height_exaggeration=scale, ground_height=lambda up: np.full(len(up), 600.)))
        self.assertTrue(np.all(results[0] > 0))
        for result in results[1:]:
            np.testing.assert_allclose(result, results[0], rtol=3e-6, atol=1e-8)

    def test_continuous_source_is_finite_across_dateline_and_poles(self):
        def continuous_source(lon, lat):
            up = np.column_stack((np.cos(lat)*np.cos(lon), np.cos(lat)*np.sin(lon), np.sin(lat)))
            return .6 + .2*up
        epsilon = 1e-8
        pairs = [
            ((np.pi-epsilon, .4), (-np.pi+epsilon, .4)),
            ((0., np.pi/2-epsilon), (np.pi, np.pi/2-epsilon)),
            ((0., -np.pi/2+epsilon), (np.pi, -np.pi/2+epsilon)),
        ]
        for first, second in pairs:
            points = world_points([first[0], second[0]], [first[1], second[1]], 3000.)
            result = ground_illumination(points, continuous_source, dark_density)
            self.assertTrue(np.isfinite(result).all() and (result >= 0).all())
            np.testing.assert_allclose(result[0], result[1], rtol=1e-6, atol=1e-8)
        pole = ground_illumination(world_points(0., [np.pi/2, -np.pi/2], 3000.),
                                   continuous_source, dark_density)
        self.assertTrue(np.isfinite(pole).all() and (pole > 0).all())

    def test_local_ground_height_sets_agl_footprint_and_attenuation_column(self):
        agl, ground, scale = 1500., 3000., 12.
        reference = ground_illumination(world_points(0., 0., agl, scale), local_source,
                                        dark_density, height_exaggeration=scale)
        queried_heights = []
        def terrain(up):
            np.testing.assert_allclose(np.linalg.norm(up, axis=-1), 1., atol=1e-12)
            return np.full(len(up), ground)
        def density(query):
            physical_msl = (np.linalg.norm(query, axis=-1)-1)*EARTH_M/scale
            queried_heights.extend(physical_msl)
            # A below-terrain sample would spuriously black out this clear column.
            return np.where(physical_msl < ground-1e-6, 1., 0.)
        elevated = ground_illumination(world_points(0., 0., ground+agl, scale),
            local_source, density, height_exaggeration=scale, ground_height=terrain)
        self.assertTrue(queried_heights)
        self.assertGreaterEqual(min(queried_heights), ground-1e-6)
        self.assertLessEqual(max(queried_heights), ground+agl+1e-6)
        np.testing.assert_allclose(elevated, reference, rtol=3e-6, atol=1e-8)

    def test_points_at_or_below_local_ground_receive_no_city_glow(self):
        source = Mock(side_effect=AssertionError('buried point queried lamps'))
        density = Mock(side_effect=AssertionError('buried point queried weather'))
        result = ground_illumination(world_points(0., 0., [1000., 1200.]), source, density,
                                     ground_height=lambda up: np.full(len(up), 1200.))
        np.testing.assert_array_equal(result, np.zeros((2, 3)))
        source.assert_not_called()
        density.assert_not_called()


if __name__ == '__main__':
    unittest.main()

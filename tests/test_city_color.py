"""Population color survives source scheduling, local evidence and cloud transport."""
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

import numpy as np

SCRIPTS = Path(__file__).resolve().parents[1] / 'skills/route-replay/scripts'
ENGINE = SCRIPTS / 'engine'
sys.path[:0] = [str(ENGINE), str(SCRIPTS)]

from causal_lights import build_lamp_timeline
from cityglow import ground_illumination
from citypopulations import LUMA
from lighting_profile import validate_profile, xy_linear_rgb

EPOCH = datetime(2030, 6, 1, tzinfo=timezone.utc)


def chromaticity(rgb):
    rgb = np.asarray(rgb)
    return rgb / (rgb @ LUMA)[..., None]


def profile_v1():
    return validate_profile({
        'schema_version': 1,
        'title': 'Synthetic local color evidence',
        'source': {'url': 'https://example.org/fixture', 'credit': 'Synthetic test fixture',
                   'license_url': 'https://opensource.org/license/mit',
                   'notes': 'Not a measurement or real city inventory.'},
        'regions': [{'id': 'fixture', 'lat': 0., 'lon': 0., 'radius_km': 200.,
                     'valid_from': '2030-01-01T00:00:00Z',
                     'valid_until': '2031-01-01T00:00:00Z', 'basis': 'modeled',
                     'xy': [.42, .39], 'notes': 'Synthetic common color.'}]})


class PopulationPaletteTests(unittest.TestCase):
    def test_mixtures_are_bounded_and_each_population_has_unit_luminance(self):
        from citypopulations import population_colors, population_mixtures
        longitude = np.radians(np.array([[-100., 15., 120.], [-87.7, -87.6, -87.5]]))
        latitude = np.radians(np.array([[40., 50., 34.], [41.9, 41.9, 41.9]]))
        mixtures = population_mixtures(longitude, latitude)
        colors = population_colors(longitude, latitude)
        self.assertEqual(mixtures.shape, (2, 3, 4, 6))
        self.assertEqual(colors.shape, (2, 3, 4, 3))
        self.assertTrue(np.isfinite(mixtures).all() and (mixtures >= 0).all())
        self.assertTrue(np.isfinite(colors).all() and (colors >= 0).all())
        np.testing.assert_allclose(mixtures.sum(axis=-1), 1., atol=2e-7)
        np.testing.assert_allclose(colors @ LUMA, 1., atol=2e-6)
        self.assertGreater(float(np.max(np.ptp(colors[0], axis=1))), .05,
                           'Population types need distinct source mixtures')
        self.assertFalse(np.allclose(colors[1, 0], colors[1, -1], atol=1e-5),
                         'Neighboring districts should retain geographic variety')

    def test_population_colors_do_not_mutate_priors_or_depend_on_batch_order(self):
        from citypopulations import population_colors, population_mixtures, regional_populations
        lon = np.radians(np.array([-179.9, -87.65, 0., 15., 145., 179.9]))
        lat = np.radians(np.array([10., 41.9, 0., 50., -37., 10.]))
        priors = regional_populations(lon, lat)
        saved = {key: value.copy() for key, value in priors.items()}
        colors = population_colors(lon, lat, priors=priors)
        mixtures = population_mixtures(lon, lat, priors=priors)
        order = np.array([4, 1, 5, 0, 3, 2])
        reordered = {key: value[order] for key, value in priors.items()}
        np.testing.assert_array_equal(population_colors(lon[order], lat[order], priors=reordered),
                                      colors[order])
        np.testing.assert_array_equal(population_mixtures(lon[order], lat[order], priors=reordered),
                                      mixtures[order])
        for key in priors:
            np.testing.assert_array_equal(priors[key], saved[key])


class PopulationEmissionTests(unittest.TestCase):
    def setUp(self):
        # Replace only unavailable asset/runtime state. The emission adapter,
        # regional colors, schedules and profile application remain production code.
        self.runtime = types.SimpleNamespace(
            ASSETS=Path('/unused'), BUNDLE={},
            TRIP=types.SimpleNamespace(style={'city_light_strength': 1.}))
        runtime_patch = patch.dict(sys.modules, {'runtime': self.runtime})
        runtime_patch.start()
        self.addCleanup(runtime_patch.stop)
        spec = importlib.util.spec_from_file_location('population_nightlighting_for_test',
                                                     ENGINE / 'nightlighting.py')
        self.lights = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.lights)
        self.lights.light_texture = lambda: np.full((8, 16), 255, np.uint8)
        self.lights._lighting_profile = lambda: None
        self.lights._timeline = lambda: types.SimpleNamespace(
            sample=lambda lo, la, when: np.ones((len(lo), 2), np.float32))

    def equal_population_shares(self):
        original = self.lights.regional_populations
        def equal_shares(lon, lat, fields=None):
            priors = original(lon, lat, fields)
            priors['shares'] = np.full_like(priors['shares'], .25)
            return priors
        self.lights.regional_populations = equal_shares

    def select_activity(self, activity):
        values = np.asarray(activity, np.float32)
        self.lights.schedule_fractions = lambda lon, lat, when, priors: np.broadcast_to(
            values, np.shape(lon) + (4,))

    def emitted(self, lon=0., lat=0., when=EPOCH, weather=None):
        return self.lights.city_emission(lon, lat, -.5, physical_dt=when,
                                        weather_dt=weather or when)

    def test_population_activity_changes_color_at_equal_emitted_luminance(self):
        self.equal_population_shares()
        output = []
        for population in range(4):
            self.select_activity(np.eye(4)[population])
            output.append(self.emitted())
        output = np.asarray(output)
        self.assertEqual(output.dtype, np.float32)
        self.assertTrue(np.isfinite(output).all() and (output >= 0).all())
        np.testing.assert_allclose(output @ LUMA, self.lights.EMISSION_LUMINANCE / 4,
                                   rtol=2e-6)
        self.assertGreater(float(np.max(np.ptp(chromaticity(output), axis=0))), .05,
                           'Switching populations must change color, not just brightness')
        self.select_activity([.5, .5, 0., 0.])
        np.testing.assert_allclose(self.emitted(), (output[0] + output[1]) / 2, rtol=2e-6)

    def test_legacy_xy_profile_applies_to_every_population_at_equal_budget(self):
        self.equal_population_shares()
        profile = profile_v1()
        self.lights._lighting_profile = lambda: profile
        expected = xy_linear_rgb(profile['regions'][0]['xy'])
        for population in range(4):
            with self.subTest(population=population):
                self.select_activity(np.eye(4)[population])
                actual = self.emitted()
                np.testing.assert_allclose(chromaticity(actual), expected, rtol=2e-6)
                self.assertAlmostEqual(float(actual @ LUMA),
                                       self.lights.EMISSION_LUMINANCE / 4, places=6)

    def test_v2_outdoor_evidence_leaves_other_population_colors_intact(self):
        from lampspectra import LAMP_IDS, LINEAR_PALETTE
        self.equal_population_shares()
        baseline = []
        for population in range(4):
            self.select_activity(np.eye(4)[population])
            baseline.append(self.emitted())
        # Choose a distinct reference family rather than depending on palette ordering.
        selected = int(np.argmax(np.linalg.norm(LINEAR_PALETTE - chromaticity(baseline[0]), axis=1)))
        profile = profile_v1()
        profile['schema_version'] = 2
        profile['regions'][0].pop('xy')
        profile['regions'][0]['population_mixtures'] = {'outdoor': {LAMP_IDS[selected]: 1.}}
        validate_profile(profile)
        self.lights._lighting_profile = lambda: profile
        for population in range(4):
            with self.subTest(population=population):
                self.select_activity(np.eye(4)[population])
                actual = self.emitted()
                if population == 0:
                    np.testing.assert_allclose(chromaticity(actual), LINEAR_PALETTE[selected], rtol=2e-6)
                    self.assertFalse(np.allclose(actual, baseline[population]))
                else:
                    np.testing.assert_array_equal(actual, baseline[population])
                self.assertAlmostEqual(float(actual @ LUMA), float(baseline[population] @ LUMA), places=6)

    def test_profile_dates_follow_physical_utc_while_weather_can_differ(self):
        self.equal_population_shares()
        self.select_activity([1., 0., 0., 0.])
        baseline = self.emitted()
        profile = profile_v1()
        self.lights._lighting_profile = lambda: profile
        active = self.emitted(weather=EPOCH.replace(year=2026))
        np.testing.assert_array_equal(active, self.emitted(weather=EPOCH.replace(year=2040)))
        self.assertFalse(np.allclose(active, baseline))
        for outside in (EPOCH.replace(year=2029), datetime(2031, 1, 1, tzinfo=timezone.utc)):
            np.testing.assert_array_equal(self.emitted(when=outside, weather=EPOCH), baseline)

    def test_profile_cannot_add_light_to_zero_source_pixels(self):
        self.lights.light_texture = lambda: np.zeros((8, 16), np.uint8)
        self.lights._lighting_profile = lambda: profile_v1()
        self.runtime.TRIP.style['city_light_strength'] = 100.
        for when in (EPOCH, EPOCH + timedelta(hours=12)):
            np.testing.assert_array_equal(self.emitted([0., .001], [0., .001], when), 0)

    def test_geographic_colors_and_emission_are_continuous_at_seam_and_poles(self):
        for latitude in (0., .7, np.pi / 2, -np.pi / 2):
            with self.subTest(latitude=latitude):
                seam = self.emitted(np.array([-np.pi, np.pi]), np.full(2, latitude))
                np.testing.assert_allclose(seam[0], seam[1], atol=1e-7)
        for latitude in (np.pi / 2, -np.pi / 2):
            longitude = np.linspace(-np.pi, np.pi, 19)
            colors = self.emitted(longitude, np.full_like(longitude, latitude))
            np.testing.assert_allclose(colors, np.broadcast_to(colors[0], colors.shape), atol=1e-7)

    def test_real_timeline_colors_are_independent_of_frame_and_point_order(self):
        times = [EPOCH + timedelta(hours=hour) for hour in (0., 6., 12.)]
        timeline = build_lamp_timeline(times, lambda lon, lat, when:
            np.cos(2 * np.pi * (when.timestamp() / 86400 + lon / (2 * np.pi))),
            grid_degrees=30.)
        self.lights._timeline = lambda: timeline
        lon = np.radians(np.array([-179.9, -100., -87., 0., 25., 145., 179.9]))
        lat = np.radians(np.array([10., 40., 42., 0., 48., -37., 10.]))
        inputs = lon.copy(), lat.copy(), timeline.states.copy()
        expected = [self.emitted(lon, lat, when) for when in times]
        order = np.array([6, 2, 0, 4, 1, 5, 3])
        for index in (2, 0, 1, 2, 0):
            np.testing.assert_array_equal(self.emitted(lon, lat, times[index]), expected[index])
            np.testing.assert_array_equal(self.emitted(lon[order], lat[order], times[index]),
                                          expected[index][order])
        for actual, original in zip((lon, lat, timeline.states), inputs):
            np.testing.assert_array_equal(actual, original)

    def test_changed_population_source_color_reaches_cloud_illumination(self):
        self.equal_population_shares()
        # A 1 km physical cloud column samples actual geographic source RGB.
        points = np.array([[1 + 1000. / 6_371_000., 0., 0.]])
        outputs, sources = [], []
        for population in (0, 1):
            self.select_activity(np.eye(4)[population])
            sources.append(self.emitted())
            outputs.append(ground_illumination(points,
                lambda lon, lat: self.emitted(lon, lat), lambda query: np.zeros(len(query))))
        output = np.asarray(outputs)[:, 0]
        self.assertTrue((output > 0).all())
        self.assertGreater(float(np.linalg.norm(chromaticity(output[0]) -
                                                chromaticity(output[1]))), .01)
        # Transport must retain the direction of the source's red/blue difference.
        source_ratio = np.asarray(sources)[:, 0] / np.asarray(sources)[:, 2]
        cloud_ratio = output[:, 0] / output[:, 2]
        self.assertGreater(float(np.diff(source_ratio)[0] * np.diff(cloud_ratio)[0]), 0.)
        self.select_activity([.5, .5, 0., 0.])
        mixed = ground_illumination(points, lambda lon, lat: self.emitted(lon, lat),
                                    lambda query: np.zeros(len(query)))
        np.testing.assert_allclose(mixed[0], output.mean(axis=0), rtol=2e-6)


if __name__ == '__main__':
    unittest.main()

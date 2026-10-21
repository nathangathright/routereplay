"""Asset-free checks for shared lunar irradiance before material shading."""
from datetime import datetime, timedelta, timezone
import importlib
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np

ENGINE = Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts/engine'
sys.path.insert(0, str(ENGINE))
_names = ('runtime', 'starfield', 'celestial', 'moonlighting')
_saved = {name: sys.modules.get(name) for name in _names}
for _name in _names:
    sys.modules.pop(_name, None)
sys.modules['runtime'] = SimpleNamespace(TRIP=SimpleNamespace(style={}), ASSETS=Path('/unused'))
try:
    moon = importlib.import_module('moonlighting')
finally:
    for _name, _module in _saved.items():
        if _module is None:
            sys.modules.pop(_name, None)
        else:
            sys.modules[_name] = _module

PHYSICAL = datetime(2030, 11, 17, tzinfo=timezone.utc)
WEATHER = datetime(2025, 11, 17, tzinfo=timezone.utc)


def state(visibility, ratio=None, directions=None):
    count = len(visibility)
    return moon.LunarIllumination(
        np.tile([0., 0., 1.], (count, 1)) if directions is None else directions,
        np.full(count, 2.5e-6) if ratio is None else ratio, np.asarray(visibility),
        np.full(count, .0045), np.zeros(count), np.ones(count),
        np.full(count, 384400.), 1.)


class LunarIncidentTests(unittest.TestCase):
    def setUp(self):
        self.cloud = SimpleNamespace(_cloud_optical_depth=Mock(
            side_effect=lambda points, *args, **kwargs: np.full(len(points), .7)))
        self.air = SimpleNamespace(EARTH_KM=6371., OUTER_KM=7091., optical_depth=Mock(
            side_effect=lambda points, *args, **kwargs: np.tile([.1, .2, .4], (len(points), 1))))
        self.quality = SimpleNamespace(get_quality=Mock(return_value=SimpleNamespace(
            cloud_sun_steps=4, atmosphere_sun_steps=6)))
        self.runtime = SimpleNamespace(TRIP=SimpleNamespace(style={'relief_exaggeration': 12.}))
        self.modules = {'cloudvolume': self.cloud, 'atmosphere': self.air,
                        'quality': self.quality, 'runtime': self.runtime}
        self.addCleanup(moon._frame_geometry.cache_clear)

    def test_visibility_air_color_cloud_depth_and_gain_apply_exactly_once(self):
        points = np.tile([0., 0., 1.001], (3, 1))
        geometry = state([1., .25, 0.], ratio=np.array([2e-6, 3e-6, 4e-6]))
        with patch.object(moon, 'lunar_illumination', return_value=geometry), patch.dict(sys.modules, self.modules):
            returned, incoming = moon.lunar_incident(points, PHYSICAL, WEATHER, strength=4000.)
        self.assertIs(returned, geometry)
        expected = (4000.*geometry.ratio*geometry.visibility)[:, None]*np.exp(-np.array([.8, .9, 1.1]))
        np.testing.assert_allclose(incoming, expected, rtol=1e-7, atol=0.)
        self.assertEqual(incoming.dtype, np.float32)
        cloud_args, cloud_kw = self.cloud._cloud_optical_depth.call_args
        self.assertEqual(len(cloud_args[0]), 2)  # Hidden points never reach either sampler.
        self.assertEqual(cloud_args[2], WEATHER)
        self.assertEqual(cloud_kw, {'samples': 4})  # Lunar gain cannot change cloud density.
        self.assertEqual(self.air.optical_depth.call_args.kwargs, {'samples': 6, 'weather_dt': WEATHER})

    def test_zero_hidden_and_zero_photometry_skip_transport_imports(self):
        points = np.array([[0., 0., 1.]])
        blocked = dict.fromkeys(self.modules)  # Importing a disabled module now raises.
        for gain, geometry in ((0., state([1.])), (4000., state([0.])),
                               (4000., state([1.], ratio=[0.]))):
            with self.subTest(gain=gain, visibility=geometry.visibility):
                with patch.object(moon, 'lunar_illumination', return_value=geometry) as lunar, patch.dict(sys.modules, blocked):
                    returned, incoming = moon.lunar_incident(points, PHYSICAL, WEATHER, strength=gain)
                self.assertIs(returned, geometry)
                lunar.assert_called_once_with(points, PHYSICAL, height_exaggeration=1.)
                np.testing.assert_array_equal(incoming, np.zeros((1, 3)))

    def test_clear_weather_retains_air_attenuation_and_explicit_sample_budget(self):
        points = np.array([[0., 0., 1.]])
        modules = dict(self.modules, cloudvolume=None)
        geometry = state([.5])
        with patch.object(moon, 'lunar_illumination', return_value=geometry), patch.dict(sys.modules, modules):
            _, incoming = moon.lunar_incident(points, PHYSICAL, None, strength=1.,
                with_weather=False, cloud_samples=3, atmosphere_samples=11)
        np.testing.assert_allclose(incoming, .5*2.5e-6*np.exp(-np.array([[.1, .2, .4]])), rtol=1e-7)
        self.cloud._cloud_optical_depth.assert_not_called()
        self.assertEqual(self.air.optical_depth.call_args.kwargs, {'samples': 11, 'weather_dt': None})

    def test_gain_is_linear_and_weather_clock_does_not_change_lunar_geometry(self):
        points = np.array([[0., 0., 1.001]])
        geometry = state([1.])
        later_weather = WEATHER+timedelta(hours=6)
        with patch.object(moon, 'lunar_illumination', return_value=geometry) as lunar, patch.dict(sys.modules, self.modules):
            first, dim = moon.lunar_incident(points, PHYSICAL, WEATHER, strength=1., cloud_samples=7)
            second, bright = moon.lunar_incident(points, PHYSICAL, later_weather, strength=4000., cloud_samples=7)
        self.assertIs(first, second)
        for call in lunar.call_args_list:
            self.assertEqual(call.args[1], PHYSICAL)
        self.assertEqual([call.args[2] for call in self.cloud._cloud_optical_depth.call_args_list],
                         [WEATHER, later_weather])
        self.assertEqual(self.cloud._cloud_optical_depth.call_args.kwargs, {'samples': 7})
        np.testing.assert_allclose(bright, 4000.*dim, rtol=1e-7)

    def test_physical_and_displayed_points_share_geometry_and_extinction_paths(self):
        up = np.array([[.01, .02, 1.], [.03, 0., 1.]])
        up /= np.linalg.norm(up, axis=-1, keepdims=True)
        heights = np.array([.8, 11.])/moon.EARTH_KM
        points = up*(1.+heights)[:, None]
        displayed = up*(1.+12.*heights)[:, None]
        originals = (points.copy(), displayed.copy())
        lunar_position = np.array([0., 0., 384400.])
        sun = moon.AU_KM*np.array([np.sin(.1), 0., -np.cos(.1)])
        with patch.object(moon, '_frame_geometry', return_value=(lunar_position, sun, 1.)), patch.dict(sys.modules, self.modules):
            physical, a = moon.lunar_incident(points, PHYSICAL, WEATHER, strength=4000.)
            exaggerated, b = moon.lunar_incident(displayed, PHYSICAL, WEATHER, strength=4000., height_exaggeration=12.)
        for field in ('direction', 'ratio', 'visibility', 'angular_radius'):
            np.testing.assert_allclose(getattr(physical, field), getattr(exaggerated, field), rtol=1e-12, atol=1e-14)
        np.testing.assert_allclose(a, b, rtol=1e-7)
        cloud_calls = self.cloud._cloud_optical_depth.call_args_list
        np.testing.assert_allclose(cloud_calls[0].args[0], displayed, rtol=1e-12)
        np.testing.assert_allclose(cloud_calls[0].args[0], cloud_calls[1].args[0], rtol=1e-12)
        air_calls = self.air.optical_depth.call_args_list
        np.testing.assert_allclose(air_calls[0].args[0], air_calls[1].args[0], rtol=1e-12)
        np.testing.assert_array_equal(points, originals[0])
        np.testing.assert_array_equal(displayed, originals[1])

    def test_atmosphere_segment_starts_at_forward_shell_entry(self):
        # An elevated observer can see an inward lunar ray without the ray
        # intersecting Earth. Start the air integral at the shell, not observer.
        point = np.array([[0., 0., 2.]])
        direction = np.array([[.52, 0., -np.sqrt(1.-.52**2)]])
        self.runtime.TRIP.style['relief_exaggeration'] = 1.
        geometry = state([1.], directions=direction)
        with patch.object(moon, 'lunar_illumination', return_value=geometry), patch.dict(sys.modules, self.modules):
            moon.lunar_incident(point, PHYSICAL, WEATHER, strength=1., with_weather=False)
        entry, ray, length = self.air.optical_depth.call_args.args
        np.testing.assert_allclose(np.linalg.norm(entry, axis=-1), self.air.OUTER_KM/self.air.EARTH_KM, atol=1e-12)
        self.assertGreater(float(length[0]), 0.)
        self.assertLess(float(length[0]), 1.)
        np.testing.assert_array_equal(ray, direction)

    def test_invalid_gain_or_sample_counts_fail_before_transport(self):
        points = np.array([[0., 0., 1.]])
        for gain in (-1., np.inf, np.nan):
            with self.subTest(gain=gain), self.assertRaisesRegex(ValueError, 'strength'):
                moon.lunar_incident(points, PHYSICAL, WEATHER, strength=gain)
        for key in ('cloud_samples', 'atmosphere_samples'):
            for count in (0, -1, 1.5, True, np.nan):
                with self.subTest(key=key, count=count), self.assertRaisesRegex(ValueError, key):
                    moon.lunar_incident(points, PHYSICAL, WEATHER, strength=0., **{key: count})
        self.cloud._cloud_optical_depth.assert_not_called()
        self.air.optical_depth.assert_not_called()


if __name__ == '__main__':
    unittest.main()

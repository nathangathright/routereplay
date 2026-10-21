"""Portable causal populations, clock policy and immutable lamp sampling."""
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import numpy as np

ENGINE = Path(__file__).resolve().parents[1] / 'skills/cinematic-flight-videos/scripts/engine'
sys.path[:0] = [str(ENGINE), str(ENGINE.parent)]
from causal_lights import LampTimeline, RelayPopulation, build_lamp_timeline
from citypopulations import (LINEAR_PALETTE, LUMA, geographic_fields, local_solar_hour,
                             regional_populations, schedule_fractions)

EPOCH = datetime(2031, 3, 9, 0, tzinfo=timezone.utc)


def cosine_for_lux(lux):
    # Inverse of the model's clear-sky curve over the measured twilight range.
    altitude = np.interp(np.log10(lux), np.log10([.054, 1.35, 43., 430.]), [-9., -6., -3., 0.])
    return np.sin(np.radians(altitude))


class RelayTests(unittest.TestCase):
    def test_dawn_dusk_hysteresis_retains_real_history(self):
        population = RelayPopulation([1.])
        off = population.step([100.])[0, 0]
        dusk = population.step([30.])[0, 0]
        night = population.step([1.])[0, 0]
        dawn = population.step([30.])[0, 0]
        self.assertLess(dusk, dawn)
        self.assertLess(off, dusk)
        self.assertGreaterEqual(night, dawn)
        np.testing.assert_array_equal(population.step([30.]), population.step([30.]))
        self.assertEqual(float(population.step([1000.])[0, 0]), 0.)

    def test_cloud_trigger_persists_in_deadband(self):
        population = RelayPopulation([1.])
        clear = population.step([100.])[0, 0]
        cloud = population.step([8.])[0, 0]
        recovered_twilight = population.step([25.])[0, 0]
        self.assertGreater(cloud, clear + .6)
        self.assertGreater(recovered_twilight, .6)
        reset = population.step([200.])[0, 0]
        self.assertLess(reset, .1)

    def test_reject_invalid_sensor_inputs(self):
        for value in [-1, np.nan, np.inf]:
            with self.assertRaises(ValueError):
                RelayPopulation([1.]).step([value])


class PopulationTests(unittest.TestCase):
    def test_regional_priors_are_normalized_and_differ(self):
        lon, lat = np.radians([-100., 15., 120.]), np.radians([40., 50., 34.])
        priors = regional_populations(lon, lat)
        np.testing.assert_allclose(priors['shares'].sum(axis=-1), 1, atol=1e-7)
        np.testing.assert_allclose(priors['color_weights'].sum(axis=-1), 1, atol=1e-7)
        self.assertGreater(np.ptp(priors['shares'][:, 0]), .015)
        self.assertGreater(np.ptp(priors['color_weights'][:, 2]), .03)
        np.testing.assert_allclose(LINEAR_PALETTE @ LUMA, 1, atol=1e-7)

    def test_dateline_and_poles_continuous_for_all_geographic_fields(self):
        lon = np.array([-np.pi, np.pi])
        for lat in [0, np.pi/2, -np.pi/2]:
            a = regional_populations(lon, np.full(2, lat))
            for values in a.values():
                np.testing.assert_allclose(values[0], values[1], atol=1e-7)
            np.testing.assert_allclose(schedule_fractions(lon, np.full(2, lat), EPOCH)[0],
                                       schedule_fractions(lon, np.full(2, lat), EPOCH)[1], atol=1e-7)
        for pole in [-np.pi/2, np.pi/2]:
            lon = np.linspace(-np.pi, np.pi, 31)
            lat = np.full_like(lon, pole)
            for values in regional_populations(lon, lat).values():
                np.testing.assert_allclose(values, np.broadcast_to(values[0], values.shape), atol=1e-7)
            schedule = schedule_fractions(lon, lat, EPOCH)
            np.testing.assert_allclose(schedule, np.broadcast_to(schedule[0], schedule.shape), atol=1e-7)

    def test_schedule_midnight_continuity_and_overnight_curfew(self):
        before = EPOCH - timedelta(seconds=.01)
        after = EPOCH + timedelta(seconds=.01)
        np.testing.assert_allclose(schedule_fractions(0., 0., before),
                                   schedule_fractions(0., 0., after), atol=1e-5)
        evening = schedule_fractions(0., 0., EPOCH + timedelta(hours=20))
        deep_night = schedule_fractions(0., 0., EPOCH + timedelta(hours=3))
        self.assertGreater(evening[1], deep_night[1])
        self.assertGreater(evening[2], deep_night[2])
        self.assertEqual(evening[3], 1.)
        self.assertEqual(deep_night[3], 1.)

    def test_mean_solar_time_explicitly_ignores_dst(self):
        # Same UTC instant, two display offsets: source schedules remain equal.
        before = datetime.fromisoformat('2031-11-02T01:30:00-05:00')
        utc = before.astimezone(timezone.utc)
        np.testing.assert_array_equal(schedule_fractions(-1.5, .7, before),
                                      schedule_fractions(-1.5, .7, utc))
        later = before + timedelta(hours=1)
        self.assertAlmostEqual(float((local_solar_hour(-1.5, later) - local_solar_hour(-1.5, before)) % 24), 1.)
        with self.assertRaises(ValueError):
            local_solar_hour(0., datetime(2031, 1, 1))


class TimelineTests(unittest.TestCase):
    def build(self, times, solar=None, **kwargs):
        if solar is None:
            def solar(lon, lat, when):
                hour = (when - EPOCH).total_seconds() / 3600
                lux = 100 if hour < 1 or hour >= 4 else (2 if hour < 2 else 30)
                return np.full_like(lon, cosine_for_lux(lux))
        return build_lamp_timeline(times, solar, grid_degrees=30, **kwargs)

    def test_frame_order_and_repeated_visits_are_identical(self):
        times = [EPOCH + timedelta(hours=h) for h in [0, 1.5, 2.5, 4, 5]]
        timeline = self.build(times)
        lon, lat = np.radians([-87, 20, 130]), np.radians([42, 50, -20])
        expected = [timeline.sample(lon, lat, dt) for dt in times]
        order = [4, 1, 0, 3, 2, 1, 4]
        for i in order:
            np.testing.assert_array_equal(timeline.sample(lon, lat, times[i]), expected[i])
        with self.assertRaises(ValueError):
            timeline.states[0] = 0
        with self.assertRaises(ValueError):
            timeline.sample(0., 0., EPOCH - timedelta(seconds=1))

    def test_no_future_activation_leaks_between_snapshots(self):
        timeline = self.build([EPOCH, EPOCH + timedelta(hours=1.5)])
        first = timeline.sample(0., 0., EPOCH)
        between = timeline.sample(0., 0., EPOCH + timedelta(hours=1.4))
        last = timeline.sample(0., 0., EPOCH + timedelta(hours=1.5))
        np.testing.assert_array_equal(first, between)
        self.assertGreater(last[0], first[0])

    def test_cloud_sensor_uses_weather_clock_only(self):
        physical = [EPOCH + timedelta(hours=i) for i in range(3)]
        seen = []
        def cloud(lon, lat, when):
            seen.append(when)
            return .05 if when >= EPOCH + timedelta(days=100, hours=1) else 1.
        solar = lambda lon, lat, when: np.full_like(lon, cosine_for_lux(100.))
        timeline = self.build(physical, solar, sensor_transmission=cloud,
                              weather_time=lambda when: when + timedelta(days=100))
        self.assertGreater(timeline.sample(0., 0., physical[-1])[0],
                           timeline.sample(0., 0., physical[0])[0])
        self.assertTrue(all(when.year == 2031 and when.month >= 6 for when in seen))
        self.assertEqual(timeline.metadata['schedule_policy'], 'mean_solar_time_no_dst')

    def test_multi_day_layover_advances_through_each_day(self):
        times = [EPOCH + timedelta(hours=i) for i in range(73)]
        def solar(lon, lat, when):
            return np.cos(2 * np.pi * (when.timestamp() / 86400 + lon / (2*np.pi)))
        timeline = self.build(times, solar)
        values = np.array([timeline.sample(0., 0., when)[0] for when in times])
        for day in range(3):
            np.testing.assert_allclose(values[day*24:(day+1)*24], values[:24], atol=1/255)
        self.assertEqual(timeline.metadata['gap_restart_count'], 0)
        self.assertLess(values[0], values[12])

    def test_decade_gap_is_bounded_and_recorded(self):
        times = [EPOCH, EPOCH.replace(year=2041)]
        timeline = self.build(times)
        self.assertEqual(timeline.metadata['gap_restart_count'], 1)
        self.assertLess(timeline.metadata['integration_steps'], 600)
        self.assertLess(timeline.states.nbytes, 10000)

    def test_mmap_roundtrip_and_storage_budget(self):
        times = [EPOCH + timedelta(minutes=i) for i in range(40)]
        with tempfile.TemporaryDirectory() as directory:
            timeline = build_lamp_timeline(times, lambda lo, la, dt: -.5,
                                           output_dir=directory, max_storage_bytes=400000)
            self.assertIsInstance(timeline.states, np.memmap)
            self.assertFalse(timeline.states.flags.writeable)
            self.assertLessEqual(timeline.states.nbytes, 400000)
            self.assertGreater(timeline.metadata['effective_grid_degrees'], 2.)
            loaded = LampTimeline.load(directory)
            np.testing.assert_array_equal(loaded.sample(np.array([-np.pi, np.pi]), 0., times[-1]),
                                          timeline.sample(np.array([-np.pi, np.pi]), 0., times[-1]))

    def test_calendar_boundary_requires_warmup(self):
        with self.assertRaisesRegex(ValueError, 'warmup'):
            self.build([datetime(1, 1, 1, tzinfo=timezone.utc)])


class ForecastHoldIntegrationTests(unittest.TestCase):
    def test_real_forecast_prepass_freezes_lamps_while_end_hold_weather_advances(self):
        # Exercise the production preparation adapter and disk timeline, with
        # forecast samplers replaced only at the external data boundary.
        from trip import trip_from_dict
        trip = trip_from_dict({
            'schema_version': 1, 'title': 'Synthetic forecast hold regression',
            'airports': {
                'AAA': {'name': 'Synthetic A', 'lat': 40., 'lon': 0., 'timezone': 'UTC'},
                'BBB': {'name': 'Synthetic B', 'lat': 40., 'lon': 10., 'timezone': 'UTC'}},
            'flights': [{'from': 'AAA', 'to': 'BBB', 'departure': EPOCH.isoformat(),
                         'arrival': (EPOCH+timedelta(hours=1)).isoformat(), 'aircraft': 'a321neo'}],
            'video': {'duration_s': 12, 'fps': 2, 'departure_hold_s': 2, 'arrival_hold_s': 2},
            'weather': {'mode': 'forecast'}})
        forecast_queries = []
        def coverage(lon, lat, when):
            forecast_queries.append(when.timestamp())
            return np.full((len(lon), 3), .8, np.float32)
        def column(lon, lat, when, layer):
            # Weather really changes through both holds; invariant emission
            # must come from the frozen physical clock, not a constant field.
            mass = 6. + 5. * np.sin(when.timestamp()/1800 + layer)
            return np.full(len(lon), mass, np.float32), np.full(len(lon), 2000., np.float32)
        fake_clouds = types.SimpleNamespace(sample_layers=coverage, sample_column=column)
        physical_times = [trip.travel_time(tick/trip.fps) for tick in range(trip.frame_count)]
        with tempfile.TemporaryDirectory() as temporary:
            first, second = Path(temporary)/'first', Path(temporary)/'second'
            runtime = types.SimpleNamespace(ASSETS=Path('/unused'), WORK=first, TRIP=trip)
            spec = importlib.util.spec_from_file_location('forecast_nightlighting_for_test', ENGINE/'nightlighting.py')
            with patch.dict(sys.modules, {'runtime': runtime, 'cloudlayers': fake_clouds}):
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                module.light_texture = lambda: np.full((8, 16), 255, np.uint8)
                metadata = module.prepare_city_lights(trip, first, physical_times=physical_times[::-1])
                first_queries = forecast_queries.copy()
                forecast_queries.clear()
                module.prepare_city_lights(trip, second, physical_times=physical_times+physical_times[:4])
                self.assertEqual(forecast_queries, first_queries)
                self.assertTrue(all(a <= b for a, b in zip(first_queries, first_queries[1:])))
                one, two = LampTimeline.load(first/'city-lights'), LampTimeline.load(second/'city-lights')
                np.testing.assert_array_equal(one.times, two.times)
                np.testing.assert_array_equal(one.states, two.states)
                np.testing.assert_array_equal(one.times, np.unique([dt.timestamp() for dt in physical_times]))
                self.assertTrue(metadata['cloud_darkened_sensor'])
                self.assertIn('Frozen physical end holds preserve lamp state', metadata['weather_policy'])
                query_count = len(forecast_queries)
                for before, after in [(0., 1.9), (10., 11.5)]:
                    physical_before, physical_after = trip.travel_time(before), trip.travel_time(after)
                    weather_before, weather_after = trip.weather_time(before), trip.weather_time(after)
                    self.assertEqual(physical_before, physical_after)
                    self.assertLess(weather_before, weather_after)
                    self.assertNotEqual(float(column([0.], [0.], weather_before, 0)[0][0]),
                                        float(column([0.], [0.], weather_after, 0)[0][0]))
                    np.testing.assert_array_equal(one.sample(0., .7, physical_before),
                                                  one.sample(0., .7, physical_after))
                    # Reverse order deliberately: rendering cannot mutate the
                    # relays or resample meteorology after preparation.
                    late = module.city_emission(0., .7, -.5, physical_dt=physical_after, weather_dt=weather_after)
                    early = module.city_emission(0., .7, -.5, physical_dt=physical_before, weather_dt=weather_before)
                    np.testing.assert_array_equal(early, late)
                self.assertEqual(len(forecast_queries), query_count)


class LinearEmissionTests(unittest.TestCase):
    def setUp(self):
        self.runtime = types.SimpleNamespace(ASSETS=Path('/unused'), TRIP=types.SimpleNamespace(style={'city_light_strength': 1.}))
        spec = importlib.util.spec_from_file_location('canonical_nightlighting_for_test', ENGINE/'nightlighting.py')
        with patch.dict(sys.modules, {'runtime': self.runtime}):
            self.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.module)
        self.module._timeline = lambda: types.SimpleNamespace(sample=lambda lo, la, dt: np.ones((len(lo), 2), np.float32))

    def test_zero_source_never_creates_ocean_light(self):
        self.module.light_texture = lambda: np.zeros((8, 16), np.uint8)
        with patch.dict(sys.modules, {'runtime': self.runtime}):
            for when in [EPOCH, EPOCH + timedelta(hours=12)]:
                out = self.module.city_emission(np.radians([-150, -140, -130]), 0, -.5, physical_dt=when)
                np.testing.assert_array_equal(out, 0)
                self.assertEqual(out.dtype, np.float32)

    def test_persistent_day_source_and_linear_unclipped_strength(self):
        self.module.light_texture = lambda: np.full((8, 16), 255, np.uint8)
        self.module._timeline = lambda: types.SimpleNamespace(sample=lambda lo, la, dt: np.zeros((len(lo), 2), np.float32))
        with patch.dict(sys.modules, {'runtime': self.runtime}):
            base = self.module.city_emission(0., 0., .5, physical_dt=EPOCH)
            self.assertTrue(np.all(base > 0))
            self.runtime.TRIP.style['city_light_strength'] = 100
            bright = self.module.city_emission(0., 0., .5, physical_dt=EPOCH, weather_dt=EPOCH.replace(year=2026))
            self.assertEqual(bright.shape, (3,))
            self.assertEqual(bright.dtype, np.float32)
            self.assertGreater(bright.max(), 1)
            np.testing.assert_allclose(bright, base * 100, rtol=1e-6)


if __name__ == '__main__':
    unittest.main()

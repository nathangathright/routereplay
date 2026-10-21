"""Portable geometry, temporal determinism and cache isolation checks (no data downloads)."""
import copy
from datetime import timedelta
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import numpy as np

SCRIPTS = Path(__file__).resolve().parents[1]/'skills'/'route-replay'/'scripts'
sys.path[:0] = [str(SCRIPTS), str(SCRIPTS/'engine')]
from trip import load_trip, trip_from_dict
from motion import Motion
from labels import Labels
from astronomy import sun_direction
from flight_video import cache_key, lighting_samples, ranges


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.trip = load_trip(SCRIPTS.parent/'examples'/'sample-three-leg.json')
        self.motion = Motion(self.trip)

    def test_north_up_orthonormal_camera_every_leg(self):
        for t in np.linspace(0, self.trip.duration_s, 73):
            matrix = np.asarray(self.motion.camera(float(t)))
            np.testing.assert_allclose(matrix @ matrix.T, np.eye(3), atol=1e-12)
            self.assertGreaterEqual(matrix[1, 2], -1e-12)
            self.assertAlmostEqual(matrix[0, 2], 0.)

    def test_every_arrival_and_departure_matches_airport(self):
        for i, (start, end) in enumerate(self.trip.leg_intervals):
            np.testing.assert_allclose(self.motion.camera(start)[2], self.motion.vectors[i], atol=1e-12)
            np.testing.assert_allclose(self.motion.camera(end)[2], self.motion.vectors[i+1], atol=1e-12)
            self.assertAlmostEqual(self.motion.altitude(start), 0.)
            self.assertAlmostEqual(self.motion.altitude(end), 0.)

    def test_only_longest_leg_has_full_globe_apex(self):
        radii = [self.motion.zoom((a+b)/2) for a,b in self.trip.leg_intervals]
        longest = int(np.argmax(self.motion.angles))
        self.assertAlmostEqual(radii[longest], self.trip.style['summit_radius'])
        self.assertTrue(all(r > radii[longest] for i,r in enumerate(radii) if i != longest))

    def test_heading_and_plane_transition_are_continuous(self):
        for i, (start, end) in enumerate(self.trip.leg_intervals):
            for boundary in (start, end):
                change = (self.motion.heading(boundary+1e-5)-self.motion.heading(boundary-1e-5)+180)%360-180
                self.assertLess(abs(change), .01)
        for t in np.linspace(0, self.trip.duration_s, 151):
            mix = self.motion.aircraft_mix(float(t))
            self.assertAlmostEqual(sum(w for _,w in mix), 1.)
            self.assertTrue(all(0 <= leg < len(self.trip.legs) and 0 < w <= 1 for leg,w in mix))

    def test_labels_are_deterministic_and_retire(self):
        labels = Labels(self.motion)
        for i,start in enumerate(labels.appearances):
            self.assertIsNotNone(start)
            self.assertFalse(labels.active(i, start-1/self.trip.fps))
        for i,lock in labels.locks.items():
            x,y,w,h,a = labels.state(i,lock)
            np.testing.assert_allclose((x,y), labels.positions[i], atol=1)
            self.assertEqual((w,h,a), (220,120,1.))
            self.assertFalse(labels.active(i, self.trip.duration_s))
        samples = [(i,float(t)) for i in range(len(labels.positions)) for t in np.linspace(0,self.trip.duration_s,31)]
        expected = [labels.state(i,t) for i,t in samples]
        actual = [labels.state(i,t) for i,t in reversed(samples)]
        self.assertEqual(expected, list(reversed(actual)))

    def test_lighting_prepass_uses_actual_clock(self):
        def incident(points, physical, weather, **kwargs):
            # Ephemeris/extinction have their own numerical tests. This test
            # isolates prepass coordinates and clocks without runtime assets.
            direction=np.array([[1.,0.,0.]])
            state=SimpleNamespace(direction=direction,angular_radius=np.array([.0045]))
            return state,np.full((1,3),kwargs['strength']*2.5e-6)
        data = self.trip.to_dict()
        data['weather'] = {'mode':'illustrative_replay', 'sample_start':'2026-10-17T23:00:00Z', 'sample_end':'2026-10-18T20:00:00Z'}
        replay = trip_from_dict(data)
        with patch.dict(sys.modules,{'moonlighting':SimpleNamespace(lunar_incident=incident)}), \
                patch('moonlighting.lunar_incident',side_effect=incident) as incoming:
            samples = lighting_samples(replay)
            calls=list(incoming.call_args_list)
            self.assertEqual(samples, lighting_samples(self.trip))
        self.assertEqual(len(samples), replay.frame_count)
        self.assertTrue(all(s['utc'].startswith('2031-') for s in samples))
        self.assertTrue(all(0 <= s['sun_visibility'] <= 1 for s in samples))
        for tick,(sample,call) in enumerate(zip(samples,calls)):
            self.assertEqual(call.args[1],replay.travel_time(tick/replay.fps))
            self.assertEqual(call.args[2],replay.weather_time(tick/replay.fps))
            self.assertAlmostEqual(np.linalg.norm(call.args[0][0]),
                                   1+sample['aircraft_altitude_m']/6371000.)
            np.testing.assert_allclose(np.linalg.norm(sample['moon_camera']),1.,atol=1e-12)
            self.assertTrue(all(value>=0 for value in sample['moon_rgb']))
            self.assertTrue(sample['moonlight_enabled'])

    def test_one_leg_has_no_transition_assumption(self):
        trip = load_trip(SCRIPTS.parent/'examples'/'sample-single-leg.json')
        motion = Motion(trip)
        for t in [0,3,trip.duration_s]:
            self.assertEqual(motion.aircraft_mix(t), [(0,1.)])
        self.assertEqual(len(Labels(motion).positions), 2)

    def test_preview_lighting_only_samples_requested_frames(self):
        def incident(points,*args,**kwargs):
            return SimpleNamespace(direction=np.array([[1.,0.,0.]]),angular_radius=np.array([.0045])),np.zeros((1,3))
        with patch.dict(sys.modules,{'moonlighting':SimpleNamespace(lunar_incident=incident)}), \
                patch('moonlighting.lunar_incident',side_effect=incident) as incoming:
            values=lighting_samples(self.trip,frames=[13,7,13])
            self.assertEqual(incoming.call_count,2)
            self.assertEqual(len(values),self.trip.frame_count)
            self.assertEqual([i for i,v in enumerate(values) if v is not None],[7,13])
            self.assertEqual(values[7]['frame'],7)
            self.assertEqual(values[13]['frame'],13)
            for frames in ([-1],[self.trip.frame_count],[True],[1.2]):
                with self.assertRaises(ValueError):lighting_samples(self.trip,frames=frames)

    def test_cache_changes_with_data_dates_and_aircraft_mode(self):
        env = {'packages': {'Pillow': 'test'}, 'tools': {}}
        bundle = {'assets': {'surface': {'sha256': 'abc'}}}
        baseline = cache_key(self.trip,bundle,'diagram',env)
        self.assertNotEqual(baseline, cache_key(self.trip,bundle,'cycles',env))
        self.assertNotEqual(baseline, cache_key(self.trip,{'assets': {}},'diagram',env))
        changed = self.trip.to_dict()
        changed['style']['star_strength'] = 2
        self.assertNotEqual(baseline, cache_key(trip_from_dict(changed),bundle,'diagram',env))

    def test_sparse_aircraft_frame_ranges(self):
        self.assertEqual(list(ranges([3,1,2,3,7,8,12])), [(1,4),(7,9),(12,13)])
        self.assertEqual(list(ranges([])), [])

    def test_solar_vector_is_finite_unit_length(self):
        for year in [1999,2024,2031,2040]:
            moment = self.trip.legs[0].depart.replace(year=year)
            vector = sun_direction(moment)
            self.assertAlmostEqual(float(np.linalg.norm(vector)),1.)
            self.assertGreater(np.linalg.norm(vector-sun_direction(moment+timedelta(hours=6))), .1)


if __name__ == '__main__':
    unittest.main()

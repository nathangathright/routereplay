"""Adversarial itinerary/track cases beyond the normal trip regression matrix."""
from datetime import datetime, timedelta, timezone
import math
from pathlib import Path
import sys
import unittest

import numpy as np

SCRIPTS = Path(__file__).resolve().parents[1] / 'skills/cinematic-flight-videos/scripts'
sys.path[:0] = [str(SCRIPTS), str(SCRIPTS/'engine')]
from trip import trip_from_dict
from motion import Motion
from labels import Labels, PANEL_W, PANEL_H
from frame_context import context_at


def synthetic_route(coordinates, *, ground=1300, summit=440, layover_hours=72):
    codes = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'][:len(coordinates)]
    airports = {code: {'name': 'Synthetic fixture '+code, 'lat': lat, 'lon': lon, 'timezone': 'UTC'}
                for code, (lat, lon) in zip(codes, coordinates)}
    cursor = datetime(2030, 12, 30, 20, tzinfo=timezone.utc)
    flights = []
    for a, b in zip(codes, codes[1:]):
        arrive = cursor + timedelta(hours=4)
        flights.append({'from': a, 'to': b, 'departure': cursor.isoformat(),
                        'arrival': arrive.isoformat(), 'aircraft': 'a321neo'})
        cursor = arrive + timedelta(hours=layover_hours)
    return {'schema_version': 1, 'title': 'Synthetic adversarial fixture',
            'airports': airports, 'flights': flights,
            'video': {'duration_s': 30, 'fps': 12, 'departure_hold_s': 1,
                      'arrival_hold_s': 2, 'layover_hold_s': 2},
            'weather': {'mode': 'clear'},
            'style': {'ground_radius': ground, 'summit_radius': summit}}


def add_track(data, points):
    leg = data['flights'][0]
    depart, arrive = datetime.fromisoformat(leg['departure']), datetime.fromisoformat(leg['arrival'])
    leg['trajectory'] = {'source': 'Synthetic fixture; not an observed flight',
                         'altitude_reference': 'MSL', 'max_gap_s': 120,
                         'points': [{'time': (depart+(arrive-depart)*p).isoformat(),
                                     'lat': lat, 'lon': lon, 'altitude_m': alt}
                                    for p, lat, lon, alt in points]}
    return data


def time_at_progress(trip, wanted):
    low, high = trip.leg_intervals[0]
    for _ in range(50):
        middle = (low+high)/2
        if trip.progress(0, middle) < wanted:
            low = middle
        else:
            high = middle
    return (low+high)/2


class AdversarialLabelTests(unittest.TestCase):
    def test_forced_retirement_fades_without_moving_or_changing_natural_ends(self):
        trip = trip_from_dict(synthetic_route([(89.95, -120), (89.95, 60),
                                               (89.95, -120), (89.95, 60)]))
        labels = Labels(Motion(trip))
        forced = [i for i, deadline in labels.forced_ends.items()
                  if labels.ends[i] == deadline and deadline < trip.duration_s]
        self.assertTrue(forced)
        cases = []
        for i in forced:
            deadline = labels.forced_ends[i]
            last_frame = (math.ceil(deadline*trip.fps)-1)/trip.fps
            self.assertTrue(labels.active(i, last_frame))
            self.assertGreater(labels.ground_panel(i, last_frame)[4], .5)
            self.assertLess(labels.state(i, last_frame)[4], 1/255)
            early = deadline-1/trip.fps-.31
            self.assertEqual(labels.state(i, early), labels.ground_panel(i, early))
            self.assertEqual(labels.ends[i], deadline)
            for when in np.linspace(early, deadline, 17):
                self.assertEqual(labels.state(i, when)[:4], labels.ground_panel(i, when)[:4])
                cases.append((i, when))
        original = {case: labels.state(*case) for case in cases}
        np.random.default_rng(7).shuffle(cases)
        self.assertEqual(original, {case: labels.state(*case) for case in cases})

        # Natural recession still sets its own retirement time and opacity.
        natural = Labels(Motion(trip_from_dict(synthetic_route([(42, -88), (35, 140),
                                                                 (-37, 175), (42, -88)]))))
        retired = [i for i in natural.ends if natural.ends[i] < natural.forced_ends[i]]
        self.assertTrue(retired)
        for i in retired:
            for when in np.linspace(natural.locks[i], natural.ends[i], 17):
                self.assertEqual(natural.state(i, when), natural.ground_panel(i, when))

    def test_near_pole_repeated_visits_retire_before_later_legs(self):
        data = synthetic_route([(89.95, -120), (89.95, 60), (89.95, -120),
                                (89.95, 60), (89.95, -120)])
        trip = trip_from_dict(data)
        labels = Labels(Motion(trip))
        self.assertTrue(all(row['first_visible_s'] is not None for row in labels.report()))
        for tick in range(trip.frame_count):
            when = tick/trip.fps
            active = [i for i in range(5) if labels.active(i, when)]
            self.assertLessEqual(len(active), 2)
            self.assertTrue(all(i >= trip.active_leg(when) for i in active))
        for i, end in labels.ends.items():
            self.assertFalse(labels.active(i, end))
            if i+1 < len(trip.legs):
                self.assertFalse(labels.active(i, trip.duration_s-1/trip.fps))

    def test_valid_small_globe_style_has_safe_ground_anchors(self):
        for ground, summit in [(300, 200), (650, 440), (1200, 1100), (6000, 1200)]:
            trip = trip_from_dict(synthetic_route([(40, -100), (50, 10), (-30, 150), (42, -80)],
                                                  ground=ground, summit=summit))
            labels = Labels(Motion(trip))
            for x, y in labels.positions:
                self.assertTrue(12 <= x <= 1080-PANEL_W-12)
                self.assertTrue(12 <= y <= 1920-PANEL_H-12)
            for i, when in labels.locks.items():
                x, y, width, height, opacity = labels.state(i, when)
                np.testing.assert_allclose((x, y), labels.positions[i], atol=1)
                self.assertEqual((width, height), (PANEL_W, PANEL_H))
                self.assertGreater(opacity, .99)

    def test_four_stop_dates_and_label_lifetimes_do_not_depend_on_order(self):
        trip = trip_from_dict(synthetic_route([(42, -88), (35, 140), (61, -150),
                                               (-37, 175), (42, -88)]))
        motion, labels = Motion(trip), Labels(Motion(trip))
        times = np.linspace(0, trip.duration_s, 151)
        before = [(context_at(motion, t).to_dict(), [labels.active(i, t) for i in range(5)]) for t in times]
        after = [(context_at(motion, t).to_dict(), [labels.active(i, t) for i in range(5)]) for t in times[::-1]]
        self.assertEqual(before, after[::-1])
        self.assertGreater(trip.legs[-1].depart-trip.legs[0].arrive, timedelta(days=9))
        self.assertTrue(all(row['first_visible_s'] is not None for row in labels.report()))


class AdversarialTrajectoryTests(unittest.TestCase):
    def test_stationary_track_heading_uses_nearest_moving_segment(self):
        data = synthetic_route([(0, 0), (20, 10)])
        add_track(data, [(0, 0, 0, 0), (.2, 0, 10, 7000), (.4, 10, 10, 10000),
                         (.6, 10, 10, 10000), (.8, 10, 10, 10000), (1, 20, 10, 0)])
        motion = Motion(trip_from_dict(data))
        heading = motion.route_heading(0, .65)
        self.assertLess(abs((heading+180) % 360-180), 1e-5)

    def test_missing_endpoints_use_terrain_without_changing_observed_msl(self):
        data = synthetic_route([(0, 0), (0, 20)])
        add_track(data, [(.25, 0, 5, 10000), (.75, 0, 15, 6000)])
        trip = trip_from_dict(data)
        motion = Motion(trip)
        self.assertEqual(motion.altitude(0, terrain_m=2500), 2500)
        self.assertEqual(motion.altitude(trip.duration_s, terrain_m=1800), 1800)
        for progress, expected in [(.25, 10000), (.75, 6000)]:
            when = time_at_progress(trip, progress)
            self.assertAlmostEqual(motion.altitude(when, terrain_m=12000), expected, places=6)
        when = time_at_progress(trip, .125)
        self.assertAlmostEqual(motion.altitude(when, terrain_m=8000), 9000, places=6)
        when = time_at_progress(trip, .875)
        self.assertAlmostEqual(motion.altitude(when, terrain_m=2000), 4000, places=6)
        self.assertEqual(motion.altitude(0, terrain_m=-100), -100)

    def test_observed_endpoint_below_terrain_is_preserved_and_reported(self):
        data = synthetic_route([(0, 0), (0, 20)])
        add_track(data, [(0, 0, 0, 200), (.5, 0, 10, 9000), (1, 0, 20, 300)])
        motion = Motion(trip_from_dict(data))
        terrain = type('Terrain', (), {'sample': lambda self, point: 2000.})()
        ctx = context_at(motion, 0, terrain)
        self.assertEqual(ctx.aircraft_altitude_m, 200)
        self.assertEqual(ctx.to_dict()['terrain_clearance_m'], -1800)
        self.assertEqual(ctx.trajectory_mode, 'observed')

    def test_dateline_polar_record_gap_has_finite_geometry(self):
        data = synthetic_route([(75, 170), (75, -170)])
        add_track(data, [(.2, 80, 179.5, 6000), (.4, 89.9, 179.9, 10000),
                         (.6, 89.9, -179.9, 10000), (.8, 80, -179.5, 6000)])
        trip = trip_from_dict(data)
        motion = Motion(trip)
        for when in np.linspace(0, trip.duration_s, 121):
            ctx = context_at(motion, when)
            self.assertTrue(np.isfinite(ctx.camera_basis).all())
            self.assertTrue(math.isfinite(ctx.heading_deg))
            self.assertTrue(math.isfinite(ctx.aircraft_altitude_m))
            np.testing.assert_allclose(np.asarray(ctx.camera_basis) @ np.asarray(ctx.camera_basis).T,
                                       np.eye(3), atol=1e-12)
        labels = Labels(motion)
        self.assertTrue(all(row['first_visible_s'] is not None for row in labels.report()))


if __name__ == '__main__':
    unittest.main()

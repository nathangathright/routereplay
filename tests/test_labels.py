"""Fixed airport slots must clear the visible approach without chasing it."""
import copy
import json
from pathlib import Path
import sys
import unittest

import numpy as np

SCRIPTS = Path(__file__).resolve().parents[1]/'skills/route-replay/scripts'
sys.path[:0] = [str(SCRIPTS), str(SCRIPTS/'engine')]
from trip import trip_from_dict
from motion import Motion
from labels import Labels, visible
from camera_geometry import project


def outbound_fixture():
    data = json.loads((SCRIPTS.parent/'examples/sample-three-leg.json').read_text())
    data['title'] = 'Synthetic outbound lettering regression'
    data['flights'] = data['flights'][:2]
    del data['airports']['MEL']
    data['video'] = {'duration_s': 18, 'fps': 30}
    return data


def overlaps(a, b):
    x, y, w, h = a
    xx, yy, ww, hh = b
    return x < xx+ww and xx < x+w and y < yy+hh and yy < y+h


def edge_distance(point, box):
    x, y, w, h = box
    delta = np.maximum(np.maximum(np.array([x, y])-point,
                                  point-np.array([x+w, y+h])), 0)
    return float(np.linalg.norm(delta))


def zigzag_fixture(coordinates):
    return {
        'schema_version': 1, 'title': 'Synthetic short zigzag regression',
        'airports': {code: {'name': code, 'lat': lat, 'lon': lon, 'timezone': 'UTC'}
                     for code, (lat, lon) in zip(['AAA', 'BBB', 'CCC'], coordinates)},
        'flights': [
            {'from': 'AAA', 'to': 'BBB', 'departure': '2030-06-01T00:00:00+00:00',
             'arrival': '2030-06-01T04:00:00+00:00', 'aircraft': 'a321neo'},
            {'from': 'BBB', 'to': 'CCC', 'departure': '2030-06-01T06:00:00+00:00',
             'arrival': '2030-06-01T10:00:00+00:00', 'aircraft': 'a321neo'}],
        'weather': {'mode': 'clear'},
    }


class FixedLabelSlotTests(unittest.TestCase):
    def test_arrival_marker_clears_fixed_panel_for_entire_outbound_approach(self):
        trip = trip_from_dict(outbound_fixture())
        motion = Motion(trip)
        labels = Labels(motion)
        previous_slot_collisions = 0
        distances = []
        for tick in range(trip.frame_count):
            when = tick/trip.fps
            points = project(motion.vectors, motion.camera(when), motion.zoom(when))
            boxes = {}
            for index, point in enumerate(points):
                if not labels.active(index, when):
                    continue
                x, y, width, height, opacity = labels.state(index, when)
                box = (x, y, width, height)
                if opacity <= 0 or not overlaps(box, (0, 0, 1080, 1920)):
                    continue
                self.assertFalse(overlaps(box, (428, 848, 224, 224)))
                boxes[index] = box
                if visible(*point):
                    self.assertGreaterEqual(edge_distance(point[:2], box), 18)
                    if index == 2:
                        distances.append(edge_distance(point[:2], box))
                        previous_slot_collisions += edge_distance(point[:2], (220, 1130, 220, 120)) < 13
            for first in boxes:
                for second in boxes:
                    if first < second:
                        self.assertFalse(overlaps(boxes[first], boxes[second]))
            if 0 in boxes and 1 in boxes:
                self.assertLess(boxes[1][0]+boxes[1][2], boxes[0][0])
        self.assertGreater(previous_slot_collisions, 30)
        self.assertLess(max(distances), 300)  # Keep the label near its airport.

    def test_choice_is_geographic_and_symmetric_not_airport_specific(self):
        original = outbound_fixture()
        renamed = copy.deepcopy(original)
        names = dict(zip(renamed['airports'], ['AAA', 'BBB', 'CCC']))
        renamed['airports'] = {names[key]: value for key, value in renamed['airports'].items()}
        for leg in renamed['flights']:
            leg['from'], leg['to'] = names[leg['from']], names[leg['to']]
        original_labels = Labels(Motion(trip_from_dict(original)))
        self.assertEqual(Labels(Motion(trip_from_dict(renamed))).positions, original_labels.positions)
        for airport in renamed['airports'].values():
            airport['lon'] *= -1
        mirrored = trip_from_dict(renamed)
        motion = Motion(mirrored)
        labels = Labels(motion)
        self.assertGreater(labels.positions[-1][0], 540)
        for tick in range(mirrored.frame_count):
            when = tick/mirrored.fps
            point = project(motion.vectors[-1], motion.camera(when), motion.zoom(when))
            if labels.active(2, when) and visible(*point):
                self.assertGreaterEqual(edge_distance(point[:2], (*labels.positions[-1], 220, 120)), 18)

    def test_safe_slots_and_ground_lock_handoffs_are_preserved(self):
        trip = trip_from_dict(outbound_fixture())
        labels = Labels(Motion(trip))
        self.assertEqual(labels.positions[:2], [(640, 1130), (220, 610)])
        for index, lock in labels.locks.items():
            expected = (*labels.positions[index], 220, 120, 1.)
            self.assertEqual(labels.state(index, lock), expected)
            hold_end = trip.leg_intervals[index][0]
            for when in np.linspace(lock, hold_end, 31):
                self.assertEqual(labels.state(index, float(when)), expected)
            states = [labels.state(index, tick/trip.fps) for tick in range(trip.frame_count)
                      if hold_end <= tick/trip.fps < labels.ends[index]]
            self.assertTrue(np.all(np.diff(np.asarray(states)[:, 2:4], axis=0) <= 0))
            self.assertFalse(labels.active(index, labels.ends[index]))

    def test_chosen_arrival_slot_never_moves_and_frame_order_does_not_change_it(self):
        trip = trip_from_dict(outbound_fixture())
        labels = Labels(Motion(trip))
        times = [tick/trip.fps for tick in range(trip.frame_count) if labels.active(2, tick/trip.fps)]
        before = [labels.state(2, when) for when in times]
        self.assertTrue(all(value == (*labels.positions[2], 220, 120, 1.) for value in before))
        self.assertEqual(before, [labels.state(2, when) for when in reversed(times)][::-1])
        self.assertEqual(labels.report(), Labels(Motion(trip)).report())

    def test_short_zigzag_alternate_lanes_have_positive_panel_gap(self):
        coordinates = [(-27.4, 39.7), (-19.6, 32.7), (-27.1, 26.9)]
        data = zigzag_fixture(coordinates)
        # Mirroring also exercises the same alternate lanes on the right.
        for direction in (1, -1):
            for airport, (_, longitude) in zip(data['airports'].values(), coordinates):
                airport['lon'] = direction * longitude
            trip = trip_from_dict(data)
            labels = Labels(Motion(trip))
            simultaneously_full_size = 0
            for tick in range(trip.frame_count):
                when = tick / trip.fps
                if not (labels.active(1, when) and labels.active(2, when)):
                    continue
                first, second = labels.state(1, when), labels.state(2, when)
                if first[4] <= 0 or second[4] <= 0:
                    continue
                if not (overlaps(first[:4], (0, 0, 1080, 1920))
                        and overlaps(second[:4], (0, 0, 1080, 1920))):
                    continue
                x, y, w, h = first[:4]
                xx, yy, ww, hh = second[:4]
                separation = max(xx-x-w, x-xx-ww, yy-y-h, y-yy-hh)
                self.assertGreater(separation, 0, (direction, tick, first, second))
                if first[2:4] == second[2:4] == (220, 120):
                    simultaneously_full_size += 1
                    self.assertGreaterEqual(separation, 10)
            self.assertGreater(simultaneously_full_size, 0)


    def test_small_globe_fitting_does_not_overlap_alternate_lanes(self):
        coordinates = [(14.915378964504944, 55.44628251554337),
                       (39.66146111622102, 26.258760350857365),
                       (-9.83070318721113, -3.8364320891884915)]
        for ground in (300, 310, 320, 330):
            for direction in (1, -1):
                data = zigzag_fixture([(lat, direction*lon) for lat, lon in coordinates])
                data['style'] = {'ground_radius': ground, 'summit_radius': 200}
                trip = trip_from_dict(data)
                labels = Labels(Motion(trip))
                co_visible = 0
                for tick in range(trip.frame_count):
                    when = tick/trip.fps
                    if not (labels.active(1, when) and labels.active(2, when)):
                        continue
                    first, second = labels.state(1, when), labels.state(2, when)
                    if first[4] <= 0 or second[4] <= 0:
                        continue
                    co_visible += 1
                    self.assertFalse(overlaps(first[:4], second[:4]),
                                     (ground, direction, tick, first, second))
                self.assertGreater(co_visible, 0)

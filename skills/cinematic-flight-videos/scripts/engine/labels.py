"""Deterministic per-visit lettering: screen lock, then ground recession.

Only the endpoints of the current flight are introduced. Repeated airport
visits receive independent lifetimes. Fixed slots are selected before rendering;
they never chase a marker or react to worker/frame evaluation order.
"""
import math
import numpy as np
from camera_geometry import distance, focal_length, sphere_interval, project

WIDTH, HEIGHT = 1080, 1920
PANEL_W, PANEL_H = 220, 120


def visible(x, y, margin):
    return margin >= .06 and 12 <= x <= WIDTH-12 and 12 <= y <= HEIGHT-12


class Labels:
    def __init__(self, motion):
        self.motion, self.trip = motion, motion.trip
        self.positions = self._positions()
        self.locks = {0: 0., **{i: self.trip.leg_intervals[i-1][1]
                               for i in range(1, len(self.trip.legs))}}
        self.anchors = {i: self._anchor(i) for i in self.locks}
        self.appearances = [None] * len(motion.vectors)
        # A departed visit must retire before another leg starts even when a
        # short/polar route never carries its ground anchor off screen.
        self.forced_ends = {i: (self.trip.leg_intervals[i+1][0] if i+1 < len(self.trip.legs)
                                else self.trip.duration_s) for i in self.locks}
        self.ends = self.forced_ends.copy()
        for tick in range(self.trip.frame_count):
            t = tick/self.trip.fps
            points = project(motion.vectors, motion.camera(t), motion.zoom(t))
            for i, point in enumerate(points):
                introduction = 0 if i == 0 else self.trip.leg_intervals[i-1][0]
                if t >= introduction and self.appearances[i] is None and visible(*point):
                    self.appearances[i] = t
                if i in self.locks and self.locks[i] <= t < self.ends[i]:
                    x, y, w, h, alpha = self.ground_panel(i, t)
                    if alpha == 0 or x >= WIDTH or x+w <= 0 or y >= HEIGHT or y+h <= 0:
                        self.ends[i] = t

    def _positions(self):
        # Look at geographic ordering from the middle of each incoming flight.
        # Consecutive visits alternate vertical lanes, permitting the horizontal
        # order to stay readable even on zigzags and multi-stop journeys.
        result = []
        for i in range(len(self.motion.vectors)):
            leg = max(0, i-1)
            start, end = self.trip.leg_intervals[leg]
            t = (start+end)/2
            points = project(self.motion.vectors[leg:leg+2], self.motion.camera(t), self.motion.zoom(t))
            dx = points[1, 0]-points[0, 0]
            if abs(dx) < 35:
                x = 430
            elif i == 0:
                x = 220 if dx > 0 else 640
            else:
                x = 640 if dx > 0 else 220
            # Keep the established side/lane when its fixed panel clears the
            # visible approach. Otherwise choose a nearby fixed slot before
            # rendering, never chase the marker during playback.
            y = 610 if i % 2 else 1130
            candidates = [(x, y), (x, y-120 if i % 2 else y+120)]
            if x != 430:
                # Offer these lanes only when fitting preserves their 10 px gap.
                side = 170 if x < 430 else 690
                upper, lower = self._fit_slot(side, 820), self._fit_slot(side, 950)
                if upper[1]+PANEL_H+10 <= lower[1]:
                    candidates.append((side, 820 if i % 2 else 950))
            slots = list(dict.fromkeys(self._fit_slot(*slot) for slot in candidates))
            times = ([0.] if i == 0 else
                     [tick/self.trip.fps for tick in range(math.ceil(start*self.trip.fps),
                                                           math.ceil(end*self.trip.fps))]+[end])
            trajectory = []
            for when in times:
                point = project(self.motion.vectors[i], self.motion.camera(when), self.motion.zoom(when))
                if visible(*point):
                    trajectory.append(point[:2])
            trajectory = np.asarray(trajectory).reshape(-1, 2)

            def score(slot):
                xx, yy = slot
                aircraft = xx < 652 and xx+PANEL_W > 428 and yy < 1072 and yy+PANEL_H > 848
                delta = np.maximum(np.maximum(np.array(slot)-trajectory,
                                              trajectory-np.array(slot)-[PANEL_W, PANEL_H]), 0)
                distance = np.linalg.norm(delta, axis=1)
                # Airport ring radius is 13 px; retain a further 5 px gap.
                return (aircraft, int(np.count_nonzero(distance < 18)),
                        float(np.mean(distance)) if len(distance) else 0.)

            scores = [score(slot) for slot in slots]
            chosen = 0 if scores[0][:2] == (False, 0) else min(range(len(slots)), key=scores.__getitem__)
            result.append(slots[chosen])
        return result

    def _fit_slot(self, x, y):
        # Keep ground anchors inside small-globe silhouettes and the viewport.
        center = np.array([x+PANEL_W/2, y+PANEL_H/2], dtype=float)
        offset = center-np.array([WIDTH/2, HEIGHT/2])
        limit = .82*self.trip.style['ground_radius']
        length = float(np.linalg.norm(offset))
        if length > limit:
            center = np.array([WIDTH/2, HEIGHT/2])+offset*(limit/length)
        return (round(float(np.clip(center[0]-PANEL_W/2, 12, WIDTH-PANEL_W-12))),
                round(float(np.clip(center[1]-PANEL_H/2, 12, HEIGHT-PANEL_H-12))))

    def _anchor(self, i):
        t = self.locks[i]
        bs = self.motion.camera(t)
        d = distance(self.motion.zoom(t))
        center = np.array(self.positions[i])+[PANEL_W/2, PANEL_H/2]
        ray = np.array([(center[0]-540)/focal_length(), (960-center[1])/focal_length(), -1.])
        ray /= np.linalg.norm(ray)
        origin = np.array([0., 0., d])
        near, _, hit = sphere_interval(origin, ray)
        if not hit:
            raise ValueError('Label anchor lies outside the ground-level globe; increase ground_radius.')
        local = origin+float(near)*ray
        return local @ np.asarray(bs), d-local[2]

    def ground_panel(self, i, t):
        bs, radius = self.motion.camera(t), self.motion.zoom(t)
        anchor, reference_depth = self.anchors[i]
        x, y, margin = project(anchor, bs, radius)
        depth = distance(radius)-float(anchor @ bs[2])
        scale = reference_depth/depth
        width, height = max(1, round(PANEL_W*scale)), max(1, round(PANEL_H*scale))
        amount = float(np.clip((scale-.12)/.18, 0, 1))
        opacity = amount**3*(amount*(amount*6-15)+10) if margin > 0 else 0.
        if opacity < 1/255:
            opacity = 0.
        return round(x-width/2), round(y-height/2), width, height, opacity

    def active(self, i, t):
        start = self.appearances[i]
        return start is not None and t >= start and t < self.ends.get(i, self.trip.duration_s)

    def state(self, i, t):
        if i in self.locks and t >= self.locks[i]:
            panel = self.ground_panel(i, t)
        else:
            panel = (*self.positions[i], PANEL_W, PANEL_H, 1.)
        deadline = self.forced_ends.get(i)
        if deadline is not None and self.ends[i] == deadline:
            # Short/polar flights can leave an old ground anchor on screen.
            # Fade only these forced retirements, ending before the final
            # visible frame. Keep this independent of the natural-end scan.
            amount = float(np.clip((deadline-1/self.trip.fps-t)/.3, 0, 1))
            fade = amount**3*(amount*(amount*6-15)+10)
            opacity = panel[4]*fade
            return (*panel[:4], opacity if opacity >= 1/255 else 0.)
        return panel

    def report(self):
        return [{'airport': a.code, 'visit': i, 'position': self.positions[i],
                 'first_visible_s': self.appearances[i],
                 'ground_lock_s': self.locks.get(i), 'retired_s': self.ends.get(i)}
                for i, a in enumerate(self.trip.airport_sequence)]

import { describe, expect, it } from 'vitest';
import { EARTH_RADIUS_KM, centralAngle } from '../src/shared/geo/greatCircle';
import { type LatLon, encodePolyline } from '../src/shared/geo/polyline';
import { SmoothPath } from '../src/shared/geo/smoothPath';
import { PathTrack } from '../src/shared/geo/track';
import { type Vec3, cross, dot, latLonToVec, length, normalize as unit, scale, sub, vecToLatLon } from '../src/shared/geo/vec';
import type { NormalizedSceneV1 } from '../src/shared/scene/types';
import {
  ASPECT_VALUE,
  type CameraState,
  FOCAL_PX,
  GLIDE_WINDOW,
  SURFACE_RAMP,
  SURFACE_SAFE_RADIUS,
  SURFACE_SCREEN_SPEED,
  type Timeline,
  buildTimeline,
  droneHeight,
  evaluate,
  surfaceProgress,
  surfaceSpeed,
} from '../src/shared/timeline/evaluate';
import { keyframeAt } from '../src/shared/timeline/storyboard';
import { leg, normalize, spec, surface } from './helpers';

const KM = 1 / EARTH_RADIUS_KM;
/** Camera distance from Earth's centre at the airports' zoom: a 1300-pixel globe radius. */
const HOLD = Math.sqrt(1 + (FOCAL_PX / 1300) ** 2);

/** Where a ground point lands in the frame, in pixels of a 1080-pixel short side from the centre. */
function onScreen(camera: CameraState, p: Vec3): { x: number; y: number } {
  const forward = unit(scale(camera.position, -1));
  const right = unit(cross(forward, camera.up));
  const up = cross(right, forward);
  const v = sub(p, camera.position);
  const z = dot(v, forward);
  return { x: (FOCAL_PX * dot(v, right)) / z, y: (FOCAL_PX * dot(v, up)) / z };
}

const eye = (camera: CameraState) => unit(camera.position);

/** Gives leg `i` a route through these points, as the server stores a traced one. */
function withRoute(scene: NormalizedSceneV1, i: number, points: LatLon[]): NormalizedSceneV1 {
  const legs = scene.legs.map((l, k) => (k === i ? { ...l, path: encodePolyline(points) } : l));
  return { ...scene, legs };
}

/**
 * A winding mountain railway from ZRH to MXP: a point every kilometre, swinging 6 km either side every 20 km and
 * up to 25 km either side over 120 km, with a switchback that doubles back on itself for 15 km.
 */
function windingRoute(scene: NormalizedSceneV1, from: string, to: string): LatLon[] {
  const a = scene.airports[from]!;
  const b = scene.airports[to]!;
  const straight = centralAngle(latLonToVec(a.lat, a.lon), latLonToVec(b.lat, b.lon)) / KM;
  const points: LatLon[] = [];
  const n = Math.round(straight);
  // Kilometres east and north per degree at the route's latitude.
  const kmLat = 111.2;
  const kmLon = 111.2 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const dx = (b.lon - a.lon) * kmLon;
  const dy = (b.lat - a.lat) * kmLat;
  const along = [dx / straight, dy / straight];
  const across = [-along[1]!, along[0]!];
  const at = (s: number, off: number): LatLon => [
    a.lat + (along[1]! * s + across[1]! * off) / kmLat,
    a.lon + (along[0]! * s + across[0]! * off) / kmLon,
  ];
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * straight;
    const taper = Math.sin(Math.PI * (s / straight));
    const off = taper * (6 * Math.sin((2 * Math.PI * s) / 20) + 25 * Math.sin((2 * Math.PI * s) / 120));
    points.push(at(s, off));
    // A switchback halfway: 15 km back down the valley and up again.
    if (i === Math.round(n / 2)) {
      for (let k = 1; k <= 15; k++) points.push(at(s - k, off + 1.5));
      for (let k = 14; k >= 1; k--) points.push(at(s - k, off + 3));
    }
  }
  return points;
}

describe('surface legs: pacing', () => {
  it('gets up to speed and slows to a stop over a fifth of the leg, steady between', () => {
    expect(surfaceProgress(0)).toBe(0);
    expect(surfaceProgress(1)).toBe(1);
    let prev = -1;
    for (let i = 0; i <= 1000; i++) {
      const u = i / 1000;
      const p = surfaceProgress(u);
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p + surfaceProgress(1 - u)).toBeCloseTo(1, 12);
      prev = p;
    }
    expect(surfaceSpeed(0)).toBe(0);
    expect(surfaceSpeed(1)).toBe(0);
    for (const u of [SURFACE_RAMP, 0.3, 0.5, 0.7, 1 - SURFACE_RAMP]) expect(surfaceSpeed(u)).toBeCloseTo(1.25, 12);
  });

  it('is the integral of its speed, with speed and acceleration continuous', () => {
    const h = 1e-6;
    for (let i = 1; i < 200; i++) {
      const u = i / 200;
      expect((surfaceProgress(u + h) - surfaceProgress(u - h)) / (2 * h)).toBeCloseTo(surfaceSpeed(u), 6);
    }
    for (const u of [SURFACE_RAMP, 1 - SURFACE_RAMP]) {
      expect(Math.abs(surfaceSpeed(u + 1e-9) - surfaceSpeed(u - 1e-9))).toBeLessThan(1e-8);
      // The speed levels off into the steady part: no kink in it.
      const slope = (x: number) => (surfaceSpeed(x + 1e-7) - surfaceSpeed(x - 1e-7)) / 2e-7;
      expect(Math.abs(slope(u - 2e-7))).toBeLessThan(1e-3);
    }
  });
});

describe('surface legs: the drone camera zooms by the leg alone', () => {
  // A ferry and a bus, then a long flight home.
  const baltic = normalize(
    spec([
      surface('hel-tll', 'HEL', 'TLL', '2026-11-06T13:30:00+02:00', '2026-11-06T15:30:00+02:00', 'ferry'),
      surface('tll-rix', 'TLL', 'RIX', '2026-11-06T16:30:00+02:00', '2026-11-06T21:00:00+02:00', 'bus'),
    ]),
  );
  const home = normalize(
    spec([
      surface('hel-tll', 'HEL', 'TLL', '2026-11-06T13:30:00+02:00', '2026-11-06T15:30:00+02:00', 'ferry'),
      surface('tll-rix', 'TLL', 'RIX', '2026-11-06T16:30:00+02:00', '2026-11-06T21:00:00+02:00', 'bus'),
      leg('rix-jfk', 'RIX', 'JFK', '2026-11-07T10:00:00+02:00', '2026-11-07T13:30:00-05:00', 'A333'),
    ]),
  );
  const samples = (tl: Timeline, i: number) => {
    const seg = tl.segments.find((s) => s.kind === 'surface' && s.leg === i)!;
    return Array.from({ length: 101 }, (_, k) => {
      const u = k / 100;
      return { u, seconds: seg.t1 - seg.t0, distance: length(evaluate(tl, seg.t0 + (seg.t1 - seg.t0) * u).camera.position) };
    });
  };

  it("stays at the airports' zoom on an ordinary leg: no climb", () => {
    // The bus was the trip's longest leg, so before it climbed to a whole-globe view mid-ride.
    const tl = buildTimeline(baltic);
    for (const i of [0, 1]) {
      for (const { distance } of samples(tl, i)) {
        expect(distance).toBeGreaterThanOrEqual(HOLD - 1e-12);
        expect(distance - 1).toBeLessThan((HOLD - 1) * 1.01);
      }
    }
  });

  it("zooms by the leg's own length, speed, and screen time, whatever the trip's other legs", () => {
    for (const scene of [baltic, home]) {
      const tl = buildTimeline(scene);
      for (const i of [0, 1]) {
        for (const { u, seconds, distance } of samples(tl, i)) {
          expect(distance).toBeCloseTo(1 + droneHeight((tl.legs[i]!.track.angle * surfaceSpeed(u)) / seconds), 12);
        }
      }
    }
    // With the long flight home, the bus has a third as long on screen, so it rises a little to keep the ground
    // from racing past; the flight still climbs.
    const tl = buildTimeline(home);
    const bus = Math.max(...samples(tl, 1).map((s) => s.distance));
    expect(bus - 1).toBeGreaterThan((HOLD - 1) * 1.01);
    expect(bus - 1).toBeLessThan((HOLD - 1) * 1.1);
    const flight = tl.segments.find((s) => s.kind === 'flight')!;
    expect(length(evaluate(tl, (flight.t0 + flight.t1) / 2).camera.position)).toBeGreaterThan(1.5);
  });

  it('rises only as far as keeps the ground from racing across the frame', () => {
    // Moscow to Vladivostok by train in 10 seconds.
    const scene = normalize(
      spec([surface('svo-vvo', 'SVO', 'VVO', '2026-10-25T23:45:00+03:00', '2026-11-01T11:00:00+10:00', 'train')], {
        presentation: { durationSeconds: 14.3 },
      } as never),
    );
    const tl = buildTimeline(scene);
    const seg = tl.segments.find((s) => s.kind === 'surface')!;
    const dt = 1 / 240;
    let highest = 0;
    let previous = length(evaluate(tl, seg.t0).camera.position);
    expect(previous).toBeCloseTo(HOLD, 12);
    for (let t = seg.t0 + dt; t <= seg.t1; t += dt) {
      const a = evaluate(tl, t - dt);
      const b = evaluate(tl, t);
      const height = length(b.camera.position) - 1;
      // Pixels a second the ground below crosses the frame (on a 1080-pixel short side).
      const speed = (FOCAL_PX * centralAngle(a.aircraft.ground, b.aircraft.ground)) / dt / height;
      expect(speed).toBeLessThan(SURFACE_SCREEN_SPEED * 1.01);
      // The height follows the speed smoothly.
      expect(Math.abs(height + 1 - previous)).toBeLessThan(0.01);
      previous = height + 1;
      highest = Math.max(highest, height + 1);
    }
    expect(highest).toBeGreaterThan(1.4);
    expect(length(evaluate(tl, seg.t1).camera.position)).toBeCloseTo(HOLD, 12);
  });

  it("is exactly the airports' height at a standstill", () => {
    expect(1 + droneHeight(0)).toBe(HOLD);
    expect(droneHeight(1e-9)).toBeCloseTo(HOLD - 1, 15);
  });

  it("still counts surface legs in the scale a flight's pull-back is measured against", () => {
    // A short hop after a long bus ride pulls back less than the same hop on its own.
    const hop = leg('rix-vno', 'RIX', 'VNO', '2026-11-07T10:00:00+02:00', '2026-11-07T11:00:00+02:00', 'A320');
    const mixed = buildTimeline(
      normalize(spec([surface('tll-rix', 'TLL', 'RIX', '2026-11-06T16:30:00+02:00', '2026-11-06T21:00:00+02:00', 'bus'), hop])),
    );
    const alone = buildTimeline(normalize(spec([hop])));
    expect(mixed.legs[1]!.height).toBeLessThan(1);
    expect(alone.legs[0]!.height).toBe(1);
    const peak = (tl: Timeline, i: number) => length(evaluate(tl, (tl.legs[i]!.flightStart + tl.legs[i]!.flightEnd) / 2).camera.position);
    expect(peak(mixed, 1)).toBeLessThan(peak(alone, 0));
  });
});

describe('surface legs: the camera glides over the route', () => {
  const base = normalize(spec([surface('zrh-mxp', 'ZRH', 'MXP', '2026-11-08T08:30:00+01:00', '2026-11-08T12:10:00+01:00', 'train')]));
  const scene = withRoute(base, 0, windingRoute(base, 'ZRH', 'MXP'));
  const tl = buildTimeline(scene);
  const seg = tl.segments.find((s) => s.kind === 'surface')!;
  const track = tl.legs[0]!.track as PathTrack;
  const dt = 1 / 240;
  const samples = Array.from({ length: Math.floor((seg.t1 - seg.t0) / dt) + 1 }, (_, i) => evaluate(tl, seg.t0 + i * dt));

  it('keeps the vehicle on the railway, heading along it', () => {
    expect(track.points.length).toBeGreaterThan(200);
    for (const s of samples.filter((_, i) => i % 37 === 0)) {
      expect(dot(s.aircraft.ground, track.at(s.legProgress))).toBeCloseTo(1, 12);
      expect(dot(s.aircraft.heading, track.tangent(s.legProgress))).toBeCloseTo(1, 12);
    }
  });

  it('keeps the vehicle in the safe area at the centre of the frame, north up and straight down', () => {
    let widest = 0;
    for (const s of samples) {
      const { x, y } = onScreen(s.camera, s.aircraft.ground);
      widest = Math.max(widest, Math.hypot(x, y));
      // Straight down, north up.
      expect(s.camera.target).toEqual([0, 0, 0]);
      const e = eye(s.camera);
      const east = unit([e[2], 0, -e[0]]);
      expect(Math.abs(dot(s.camera.up, east))).toBeLessThan(1e-9);
    }
    // The window keeps it within a twelfth of the short side; the safe area is an eighth.
    expect(widest).toBeLessThan((GLIDE_WINDOW / 3) * 540 * 1.001);
    expect(widest).toBeLessThan(SURFACE_SAFE_RADIUS * 1080);
    // It does drift: the camera isn't simply locked to the vehicle.
    expect(widest).toBeGreaterThan(5);
    // The camera frames the same ground for every shape, so the vehicle stays as far inside each one.
    const mid = samples[Math.floor(samples.length / 2)]!.t;
    for (const aspect of Object.values(ASPECT_VALUE)) expect(evaluate(tl, mid, aspect).camera.position).toEqual(evaluate(tl, mid).camera.position);
  });

  it('glides where the vehicle swerves', () => {
    // Acceleration across the screen, in pixels a second squared, from second differences.
    const accel = (points: Vec3[], i: number, h: number) =>
      (FOCAL_PX * length(sub(sub(points[i + 1]!, points[i]!), sub(points[i]!, points[i - 1]!)))) / (dt * dt) / h;
    // How far the direction of travel swings over one 30 fps frame, in degrees.
    const swing = (points: Vec3[], i: number) => {
      const before = sub(points[i]!, points[i - 8]!);
      const after = sub(points[i + 8]!, points[i]!);
      return (Math.acos(Math.min(1, dot(unit(before), unit(after)))) * 180) / Math.PI;
    };
    const cameras = samples.map((s) => eye(s.camera));
    const vehicles = samples.map((s) => s.aircraft.ground);
    let camera = { accel: 0, swing: 0 };
    let vehicle = { accel: 0, swing: 0 };
    for (let i = 8; i < samples.length - 8; i++) {
      const h = length(samples[i]!.camera.position) - 1;
      camera = { accel: Math.max(camera.accel, accel(cameras, i, h)), swing: Math.max(camera.swing, swing(cameras, i)) };
      vehicle = { accel: Math.max(vehicle.accel, accel(vehicles, i, h)), swing: Math.max(vehicle.swing, swing(vehicles, i)) };
    }
    expect(vehicle.swing).toBeGreaterThan(90); // The switchback.
    expect(camera.swing).toBeLessThan(3);
    expect(camera.accel).toBeLessThan(vehicle.accel / 20);
    // No harder than the vehicle's own getting up to speed: the route's length × the peak of surfaceProgress''.
    const T = seg.t1 - seg.t0;
    const easing = (FOCAL_PX * (track.angle * (1.5 / (1 - SURFACE_RAMP) / SURFACE_RAMP))) / (T * T) / (HOLD - 1);
    expect(camera.accel).toBeLessThan(easing * 1.05);
  });

  it('is a pure function of the record and the time', () => {
    const fresh = buildTimeline(withRoute(base, 0, windingRoute(base, 'ZRH', 'MXP')));
    const times = samples.map((s) => s.t).filter((_, i) => i % 13 === 0);
    for (const t of [...times].reverse()) expect(evaluate(fresh, t)).toEqual(evaluate(tl, t));
  });

  it('reports the same camera in storyboards and labels', () => {
    const t = samples[Math.floor(samples.length * 0.4)]!.t;
    const s = evaluate(tl, t);
    const k = keyframeAt(tl, t);
    const centre = vecToLatLon(eye(s.camera));
    expect(k.camera.centerLat).toBeCloseTo(centre.lat, 2);
    expect(k.camera.centerLon).toBeCloseTo(centre.lon, 2);
    expect(k.camera.viewRadiusKm).toBeLessThan(800);
    // Labels place the airports with the same camera (their y runs down the frame).
    for (const label of s.labels) {
      if (!label.marker) continue;
      const p = onScreen(s.camera, label.position);
      expect(label.marker.x).toBeCloseTo(p.x, 6);
      expect(label.marker.y).toBeCloseTo(-p.y, 6);
    }
  });
});

describe('surface legs: holds and stops join without a jump', () => {
  const lhrZrh = leg('lhr-zrh', 'LHR', 'ZRH', '2026-11-08T06:00:00+00:00', '2026-11-08T08:45:00+01:00', 'A320');
  const zrhMxp = surface('zrh-mxp', 'ZRH', 'MXP', '2026-11-08T10:00:00+01:00', '2026-11-08T13:40:00+01:00', 'train');
  const mxpLhr = leg('mxp-lhr', 'MXP', 'LHR', '2026-11-08T16:00:00+01:00', '2026-11-08T17:00:00+00:00', 'A320');
  const routed = (legs: ReturnType<typeof leg>[], i: number) => {
    const scene = normalize(spec(legs));
    return buildTimeline(withRoute(scene, i, windingRoute(scene, 'ZRH', 'MXP')));
  };
  const trips: [string, Timeline][] = [
    ['flight, train, flight', routed([lhrZrh, zrhMxp, mxpLhr] as never, 1)],
    ['train first, then a flight', routed([zrhMxp, mxpLhr] as never, 0)],
    ['a flight, then the train last', routed([lhrZrh, zrhMxp] as never, 1)],
  ];

  it.each(trips)('%s', (_, tl) => {
    expect(tl.segments.some((s) => s.kind === 'surface')).toBe(true);
    for (const seg of tl.segments.slice(1)) {
      const t = seg.t0;
      const before = evaluate(tl, t - 1e-9);
      const after = evaluate(tl, t + 1e-9);
      expect(length(sub(before.camera.position, after.camera.position))).toBeLessThan(1e-8);
      expect(length(sub(before.camera.up, after.camera.up))).toBeLessThan(1e-6);
      if (seg.kind === 'surface' || tl.segments[tl.segments.indexOf(seg) - 1]!.kind === 'surface') {
        // The camera comes to rest over the airport: no speed and no acceleration at the join.
        const at = evaluate(tl, t).camera.position;
        for (const d of [-1e-3, 1e-3]) {
          if (t + d < 0 || t + d > tl.duration) continue;
          expect(length(sub(evaluate(tl, t + d).camera.position, at))).toBeLessThan(1e-9);
        }
        expect(length(at)).toBeCloseTo(HOLD, 12);
      }
    }
  });
});

describe('smooth path', () => {
  const route = (points: LatLon[]) => PathTrack.fromPoints(points.map(([lat, lon]) => latLonToVec(lat, lon)))!;
  const smooth = (t: PathTrack) => new SmoothPath(t.points, t.distances);
  // A road that runs east for 100 km and turns straight back on itself.
  const hairpin = route([
    [46, 7],
    [46, 8.3],
    [46.02, 8.3],
    [46.02, 7],
  ]);

  it('meets the route at both ends', () => {
    const s = smooth(hairpin);
    for (const w of [0.001, 0.01, s.length]) {
      expect(centralAngle(s.at(0, w), hairpin.a)).toBeLessThan(1e-12);
      expect(centralAngle(s.at(s.length, w), hairpin.b)).toBeLessThan(1e-12);
    }
  });

  it('stays within a third of its window of the route, even where it doubles back', () => {
    const s = smooth(hairpin);
    for (const w of [5 * KM, 50 * KM, 150 * KM]) {
      let worst = 0;
      for (let i = 0; i <= 1000; i++) {
        const f = i / 1000;
        worst = Math.max(worst, centralAngle(s.at(f * s.length, w), hairpin.at(f)) / w);
      }
      expect(worst).toBeLessThan(1 / 3 + 1e-6);
      expect(worst).toBeGreaterThan(0.2);
    }
  });

  it('leaves a straight route where it is', () => {
    const line = route([
      [10, 20],
      [10.5, 20.5],
      [11, 21],
    ]);
    const s = smooth(line);
    for (let i = 0; i <= 20; i++) expect(centralAngle(s.at((i / 20) * s.length, 0.01), line.at(i / 20))).toBeLessThan(1e-5);
  });

  it('moves no faster than the route and continuously in its window', () => {
    const s = smooth(hairpin);
    const w = 30 * KM;
    const ds = s.length / 5000;
    for (let i = 0; i < 5000; i++) {
      // The mean of the route's chords lies just inside the globe; bringing it back to the surface stretches it a
      // little (by about w² / 2).
      expect(centralAngle(s.at(i * ds, w), s.at((i + 1) * ds, w))).toBeLessThan(ds * (1 + w * w));
      expect(centralAngle(s.at(i * ds, w), s.at(i * ds, w * (1 + 1e-6)))).toBeLessThan(1e-6 * w);
    }
  });

  it('averages away bends much shorter than its window', () => {
    // 10 km zigzags along a 300 km road.
    const zigzag = route(Array.from({ length: 61 }, (_, i): LatLon => [45 + (i % 2) * 0.09, 7 + i * 0.0635]));
    const s = smooth(zigzag);
    for (let i = 10; i <= 50; i++) {
      // Within 0.2 km of the zigzag's centre line, 5 km from either edge.
      const p = vecToLatLon(s.at((i / 60) * s.length, 100 * KM));
      expect(Math.abs(p.lat - 45.045)).toBeLessThan(0.2 / 111);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { GreatCircle } from '../src/shared/geo/greatCircle';
import { moonPosition, subsolarPoint, sunDirection } from '../src/shared/geo/solar';
import { dot, length, normalize as unit, vecToLatLon } from '../src/shared/geo/vec';
import { EXAMPLE_SCENE } from '../src/shared/scene/examples';
import { validateScene } from '../src/shared/scene/validate';
import { ASPECT_VALUE, buildTimeline, evaluate, flightProgress, verticalFovFor } from '../src/shared/timeline/evaluate';
import { clone, issues, leg, normalize, spec, synthetic, syntheticLookup } from './helpers';

const example = () => buildTimeline(normalize(EXAMPLE_SCENE));

/** Deterministic pseudo-random sequence for test sampling. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe('flight progress profile', () => {
  it('is monotonic and spans 0..1', () => {
    expect(flightProgress(0)).toBe(0);
    expect(flightProgress(1)).toBeCloseTo(1, 12);
    let prev = -1;
    for (let i = 0; i <= 1000; i++) {
      const p = flightProgress(i / 1000);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
    expect(flightProgress(0.5)).toBeCloseTo(0.5, 12);
  });

  it('starts and ends with zero speed and acceleration (smootherstep)', () => {
    const h = 1e-4;
    const speed = (u: number) => (flightProgress(u + h) - flightProgress(u - h)) / (2 * h);
    expect(speed(h)).toBeLessThan(1e-3);
    expect(speed(1 - h)).toBeLessThan(1e-3);
    expect(speed(0.5)).toBeCloseTo(1.875, 3);
    // About 31 % of a flight's screen time covers its first 18 % of the route.
    let u = 0;
    while (flightProgress(u) < 0.18) u += 1e-4;
    expect(u).toBeCloseTo(0.31, 2);
  });
});

describe('time mapping', () => {
  it('segments cover the whole presentation', () => {
    const tl = example();
    expect(tl.duration).toBeCloseTo(20, 6);
    expect(tl.durationInFrames).toBe(600);
    expect(tl.segments.map((s) => s.kind)).toEqual(['start', 'flight', 'stop', 'flight', 'end']);
    for (let i = 1; i < tl.segments.length; i++) expect(tl.segments[i]!.t0).toBeCloseTo(tl.segments[i - 1]!.t1, 9);
  });

  it('maps presentation time to physical time', () => {
    const tl = example();
    const [start, f0, stop, f1, end] = tl.segments;
    const dep0 = Date.parse('2031-01-05T16:00:00Z');
    const arr0 = Date.parse('2031-01-05T20:45:00Z');
    const dep1 = Date.parse('2031-01-06T05:30:00Z');
    const arr1 = Date.parse('2031-01-06T18:15:00Z');
    // The start hold runs the last 20 minutes before departure; everything shares this one clock.
    expect(evaluate(tl, 0).physicalUtcMs).toBe(dep0 - 20 * 60_000);
    expect(evaluate(tl, start!.t1 * 0.5).physicalUtcMs).toBeCloseTo(dep0 - 10 * 60_000, -1);
    expect(evaluate(tl, f0!.t0).physicalUtcMs).toBe(dep0);
    expect(evaluate(tl, f0!.t1 - 1e-9).physicalUtcMs).toBeCloseTo(arr0, -1);
    // The layover hold animates the real connection while the aircraft waits.
    const mid = evaluate(tl, (stop!.t0 + stop!.t1) / 2);
    expect(mid.phase).toBe('stop');
    expect(mid.physicalUtcMs).toBeCloseTo((arr0 + dep1) / 2, -1);
    expect(mid.aircraft.altitude).toBe(0);
    expect(evaluate(tl, f1!.t0).physicalUtcMs).toBeCloseTo(dep1, -1);
    // The end hold runs on to 20 minutes after arrival while the aircraft waits at the gate.
    const after = evaluate(tl, end!.t0 + 0.5);
    expect(after.physicalUtcMs).toBeGreaterThan(arr1);
    expect(after.aircraft.ground).toEqual(evaluate(tl, end!.t0).aircraft.ground);
    expect(evaluate(tl, tl.duration).physicalUtcMs).toBe(arr1 + 20 * 60_000);
  });

  it('flies each leg in its own aircraft, dissolving from one to the next through the middle of a stop', () => {
    const tl = example();
    const [start, f0, stop, f1, end] = tl.segments;
    const only = (t: number) => evaluate(tl, t).aircraft.mix;
    expect(only(start!.t0)).toEqual([{ type: 'B739', weight: 1 }]);
    expect(only((f0!.t0 + f0!.t1) / 2)).toEqual([{ type: 'B739', weight: 1 }]);
    const at = (u: number) => only(stop!.t0 + u * (stop!.t1 - stop!.t0));
    expect(at(0.2)).toEqual([{ type: 'B739', weight: 1 }]);
    const mid = at(0.5);
    expect(mid.map((m) => m.type)).toEqual(['B739', 'B789']);
    expect(mid[0]!.weight).toBeCloseTo(0.5, 9);
    expect(mid[0]!.weight + mid[1]!.weight).toBe(1);
    expect(at(0.8)).toEqual([{ type: 'B789', weight: 1 }]);
    expect(only((f1!.t0 + f1!.t1) / 2)).toEqual([{ type: 'B789', weight: 1 }]);
    expect(only(end!.t1)).toEqual([{ type: 'B789', weight: 1 }]);
    // The same type on both sides of a stop is one plane that simply waits.
    const same = clone(EXAMPLE_SCENE);
    same.legs[1]!.aircraft = 'B739';
    const t2 = buildTimeline(normalize(same));
    const s = t2.segments[2]!;
    expect(evaluate(t2, (s.t0 + s.t1) / 2).aircraft.mix).toEqual([{ type: 'B739', weight: 1 }]);
  });

  it('physical time is monotonic across the presentation', () => {
    const tl = example();
    let prev = -Infinity;
    for (let f = 0; f <= tl.durationInFrames; f++) {
      const s = evaluate(tl, f / tl.fps);
      expect(s.physicalUtcMs).toBeGreaterThanOrEqual(prev);
      prev = s.physicalUtcMs;
    }
  });

  it('a zero-length hold is an explicit time cut', () => {
    const s = clone(EXAMPLE_SCENE);
    s.presentation = { durationSeconds: 20, stopHolds: { 'ord-sfo': 0 } };
    const tl = buildTimeline(normalize(s));
    expect(tl.segments.map((x) => x.kind)).toEqual(['start', 'flight', 'flight', 'end']);
    const boundary = tl.segments[1]!.t1;
    const before = evaluate(tl, boundary - 1e-6);
    const after = evaluate(tl, boundary);
    expect(before.physicalUtcMs).toBeCloseTo(Date.parse('2031-01-05T20:45:00Z'), -2);
    expect(after.physicalUtcMs).toBe(Date.parse('2031-01-06T05:30:00Z'));
  });

  it('clamps out-of-range and non-finite times', () => {
    const tl = example();
    expect(evaluate(tl, -5)).toEqual(evaluate(tl, 0));
    expect(evaluate(tl, 1e9)).toEqual(evaluate(tl, tl.duration));
    expect(evaluate(tl, Number.NaN)).toEqual(evaluate(tl, 0));
  });
});

describe('determinism', () => {
  it('produces identical state regardless of seek order or history', () => {
    const tl = example();
    const rand = lcg(7);
    const times = Array.from({ length: 200 }, () => rand() * tl.duration);
    const forward = new Map(times.map((t) => [t, evaluate(tl, t)]));
    const shuffled = [...times].sort(() => (rand() < 0.5 ? -1 : 1));
    const fresh = buildTimeline(normalize(EXAMPLE_SCENE));
    for (const t of shuffled) {
      expect(evaluate(fresh, t)).toEqual(forward.get(t));
      expect(evaluate(tl, t)).toEqual(forward.get(t));
    }
  });

  it('frame-indexed evaluation matches time-indexed evaluation', () => {
    const tl = example();
    for (const frame of [0, 1, 29, 30, 299, 599, 600]) {
      expect(evaluate(tl, frame / 30)).toEqual(evaluate(tl, frame / 30));
    }
  });
});

describe('geometry', () => {
  it('crosses the date line continuously', () => {
    const tl = buildTimeline(normalize(spec([leg('a', 'SFO', 'AKL', '2031-01-05T21:30:00-08:00', '2031-01-07T07:15:00+13:00')])));
    const seg = tl.segments.find((s) => s.kind === 'flight')!;
    let prev = evaluate(tl, seg.t0).aircraft.ground;
    let crossed = false;
    for (let i = 1; i <= 300; i++) {
      const s = evaluate(tl, seg.t0 + ((seg.t1 - seg.t0) * i) / 300);
      const step = Math.acos(Math.min(1, dot(prev, s.aircraft.ground)));
      expect(step).toBeLessThan(0.05);
      const ll = vecToLatLon(s.aircraft.ground);
      if (Math.abs(ll.lon) > 179) crossed = true;
      prev = s.aircraft.ground;
    }
    expect(crossed).toBe(true);
    const end = vecToLatLon(evaluate(tl, tl.duration).aircraft.ground);
    expect(end.lat).toBeCloseTo(-37.012, 2);
    expect(end.lon).toBeCloseTo(174.786, 2);
  });

  it('keeps the camera well-defined over the pole', () => {
    const lookup = syntheticLookup([synthetic('PLA', 80, 0), synthetic('PLB', 80, 180)]);
    const r = validateScene(spec([leg('p', 'PLA', 'PLB', '2031-06-01T00:00:00Z', '2031-06-01T03:00:00Z')]), lookup);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    for (const camera of ['globe', 'follow'] as const) {
      const n = { ...r.normalized, presentation: { ...r.normalized.presentation, camera } };
      const tl = buildTimeline(n);
      let maxLat = -90;
      for (let f = 0; f <= tl.durationInFrames; f++) {
        const s = evaluate(tl, f / tl.fps);
        maxLat = Math.max(maxLat, vecToLatLon(s.aircraft.ground).lat);
        for (const v of [s.camera.position, s.camera.up, s.aircraft.heading]) {
          for (const x of v) expect(Number.isFinite(x)).toBe(true);
        }
        expect(length(s.camera.up)).toBeCloseTo(1, 6);
        expect(length(s.aircraft.heading)).toBeCloseTo(1, 6);
      }
      expect(maxLat).toBeGreaterThan(89.9);
    }
  });

  it('great circle tangent is perpendicular to position', () => {
    const gc = GreatCircle.fromLatLon(41.97, -87.9, -37.0, 174.8);
    for (let i = 0; i <= 10; i++) expect(Math.abs(dot(gc.at(i / 10), gc.tangent(i / 10)))).toBeLessThan(1e-9);
  });

  it('places the subsolar point correctly at a solstice', () => {
    // 2031-06-21 12:00 UTC: declination near +23.44°, longitude near 0° (equation of time ~ -1.6 min).
    const p = subsolarPoint(Date.parse('2031-06-21T12:00:00Z'));
    expect(p.lat).toBeCloseTo(23.43, 0);
    expect(Math.abs(p.lon)).toBeLessThan(1);
    const dec = subsolarPoint(Date.parse('2031-12-21T12:00:00Z'));
    expect(dec.lat).toBeCloseTo(-23.43, 0);
  });

  it('places the Moon opposite the Sun at a lunar eclipse and in front of it at a solar eclipse', () => {
    const degreesApart = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
      (Math.acos(Math.min(1, dot(unit(a), unit(b)))) * 180) / Math.PI;
    // Greatest eclipse of the total lunar eclipse of 2022-11-08: the Moon sits in Earth's shadow.
    const lunar = Date.parse('2022-11-08T10:59:00Z');
    expect(180 - degreesApart(moonPosition(lunar), sunDirection(lunar))).toBeLessThan(1);
    // Greatest eclipse of the total solar eclipse of 2024-04-08, with the Moon near perigee.
    const solar = Date.parse('2024-04-08T18:17:00Z');
    expect(degreesApart(moonPosition(solar), sunDirection(solar))).toBeLessThan(1);
    expect(length(moonPosition(solar))).toBeGreaterThan(55.5);
    expect(length(moonPosition(solar))).toBeLessThan(58);
  });
});

describe('camera', () => {
  const fovShort = (aspect: number) => {
    const v = (verticalFovFor(aspect) * Math.PI) / 180;
    const h = 2 * Math.atan(Math.tan(v / 2) * aspect);
    return (Math.min(v, h) * 180) / Math.PI;
  };

  it('spans 70° across the short side of any shape', () => {
    for (const a of [ASPECT_VALUE['16:9'], 1, ASPECT_VALUE['9:16'], 21 / 9, 9 / 19.5]) expect(fovShort(a)).toBeCloseTo(70, 9);
  });

  it('looks straight down at the aircraft, north up, at every moment', () => {
    const tl = example();
    for (let f = 0; f <= tl.durationInFrames; f += 7) {
      const s = evaluate(tl, f / tl.fps);
      const dir = unit(s.camera.position);
      expect(dot(dir, s.aircraft.ground)).toBeCloseTo(1, 9);
      expect(s.camera.target).toEqual([0, 0, 0]);
      // Up is north: it has no east-west component.
      const g = s.aircraft.ground;
      const east = unit([g[2], 0, -g[0]]); // north pole × ground
      expect(Math.abs(dot(s.camera.up, east))).toBeLessThan(1e-9);
      expect(s.camera.up[1]).toBeGreaterThan(0);
    }
  });

  it('is close at the airports and pulls back mid-flight, furthest on the longest leg', () => {
    const tl = example();
    const distanceAt = (t: number) => length(evaluate(tl, t).camera.position);
    const atGate = distanceAt(0);
    // 1300 px apparent radius on a 1080 px short side through 70°: about 1,040 km up.
    expect(atGate).toBeCloseTo(Math.sqrt(1 + (540 / Math.tan((35 * Math.PI) / 180) / 1300) ** 2), 9);
    const middle = (i: number) => distanceAt((tl.legs[i]!.flightStart + tl.legs[i]!.flightEnd) / 2);
    const longest = tl.legs[0]!.circle.angle > tl.legs[1]!.circle.angle ? 0 : 1;
    expect(middle(longest)).toBeCloseTo(Math.sqrt(1 + (540 / Math.tan((35 * Math.PI) / 180) / 440) ** 2), 9);
    expect(middle(1 - longest)).toBeGreaterThan(atGate);
    expect(middle(1 - longest)).toBeLessThan(middle(longest));
    expect(distanceAt(tl.duration)).toBeCloseTo(atGate, 9);
  });

  it('frames the same moment for whichever shape it is shown at', () => {
    const tl = example();
    expect(evaluate(tl, 5, 16 / 9).camera.position).toEqual(evaluate(tl, 5, 9 / 16).camera.position);
    expect(evaluate(tl, 5, 9 / 16).camera.fovDeg).toBeGreaterThan(evaluate(tl, 5, 16 / 9).camera.fovDeg);
  });

  it('rejects a frame shape or camera in the spec: the scene has neither', () => {
    const withShape = { ...EXAMPLE_SCENE, presentation: { ...EXAMPLE_SCENE.presentation, aspectRatio: '9:16' } };
    expect(issues(withShape).map((i) => [i.path, i.code])).toEqual([['/presentation/aspectRatio', 'unknown_field']]);
    const withCamera = { ...EXAMPLE_SCENE, presentation: { ...EXAMPLE_SCENE.presentation, camera: 'follow' } };
    expect(issues(withCamera).map((i) => [i.path, i.code])).toEqual([['/presentation/camera', 'unknown_field']]);
  });
});

describe('labels', () => {
  it('gives repeated airport visits separate lifetimes', () => {
    const tl = buildTimeline(
      normalize(
        spec([
          leg('out', 'ORD', 'SFO', '2031-01-05T10:00:00-06:00', '2031-01-05T12:45:00-08:00'),
          leg('back', 'SFO', 'ORD', '2031-01-09T08:00:00-08:00', '2031-01-09T14:10:00-06:00'),
        ]),
      ),
    );
    expect(tl.occurrences.map((o) => `${o.index}:${o.code}`)).toEqual(['0:ORD', '1:SFO', '2:ORD']);
    let sawFirst = false;
    let sawSecond = false;
    for (let f = 0; f <= tl.durationInFrames; f++) {
      const labels = evaluate(tl, f / tl.fps).labels;
      const ords = labels.filter((l) => l.code === 'ORD');
      expect(ords.length).toBeLessThanOrEqual(1);
      if (ords.some((l) => l.index === 0)) sawFirst = true;
      if (ords.some((l) => l.index === 2)) sawSecond = true;
    }
    expect(sawFirst && sawSecond).toBe(true);
    // Origin label is fully visible on the first frame; the final destination at the last.
    expect(evaluate(tl, 0).labels).toEqual([expect.objectContaining({ index: 0, opacity: 1 })]);
    expect(evaluate(tl, tl.duration).labels).toEqual([expect.objectContaining({ index: 2, opacity: 1 })]);
  });

  it('reveals only the flown trail', () => {
    const tl = example();
    expect(evaluate(tl, 0).trail).toEqual([0, 0]);
    const f0 = tl.segments[1]!;
    const mid = evaluate(tl, (f0.t0 + f0.t1) / 2).trail;
    expect(mid[0]).toBeCloseTo(0.5, 6);
    expect(mid[1]).toBe(0);
    expect(evaluate(tl, tl.duration).trail).toEqual([1, 1]);
  });
});

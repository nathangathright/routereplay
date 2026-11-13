import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { vehicleModel } from '../src/app/render/vehicles';
import { GreatCircle, centralAngle } from '../src/shared/geo/greatCircle';
import { encodePolyline } from '../src/shared/geo/polyline';
import { PathTrack } from '../src/shared/geo/track';
import { type Vec3, cross, dot, latLonToVec, length, normalize as unit, sub } from '../src/shared/geo/vec';
import { SURFACE_MODES } from '../src/shared/scene/constants';
import { buildTimeline, evaluate } from '../src/shared/timeline/evaluate';
import { JourneyPath, bodyOnPath, vehiclePlace } from '../src/shared/timeline/journeyPath';
import { leg, normalize, spec, surface } from './helpers';

describe('journey path', () => {
  // A flight east along the equator, then a road that turns north at a right angle.
  const flight = GreatCircle.fromLatLon(0, 0, 0, 10);
  const road = PathTrack.fromPoints([latLonToVec(0, 10), latLonToVec(0, 11), latLonToVec(1, 11)])!;
  const path = new JourneyPath([flight, road]);

  it('joins its tracks end to end, measured in radians', () => {
    expect(path.length).toBeCloseTo(flight.angle + road.angle, 12);
    for (const p of [0, 0.3, 1]) {
      expect(dot(path.at(path.distance(0, p)), flight.at(p))).toBeCloseTo(1, 12);
      expect(dot(path.at(path.distance(1, p)), road.at(p))).toBeCloseTo(1, 12);
    }
    // Continuous where one leg hands over to the next.
    const join = path.distance(1, 0);
    expect(centralAngle(path.at(join - 1e-9), path.at(join + 1e-9))).toBeLessThan(1e-8);
  });

  it('continues straight ahead beyond either end', () => {
    const d = 0.01;
    expect(centralAngle(path.at(-d), flight.a)).toBeCloseTo(d, 9);
    expect(dot(path.at(-d), latLonToVec(0, -d * (180 / Math.PI)))).toBeCloseTo(1, 9);
    expect(centralAngle(path.at(path.length + d), road.b)).toBeCloseTo(d, 9);
    expect(dot(path.at(path.length + d), latLonToVec(1 + d * (180 / Math.PI), 11))).toBeCloseTo(1, 9);
  });

  it('stands a body on the line, pointing from its rear to its front', () => {
    const mid = path.distance(0, 0.5);
    const straight = bodyOnPath(path, mid + 0.005, 0.01);
    expect(dot(straight.ground, flight.at(0.5))).toBeCloseTo(1, 9);
    expect(dot(straight.heading, flight.tangent(0.5))).toBeCloseTo(1, 9);
    expect(dot(straight.heading, straight.ground)).toBeCloseTo(0, 12);
    // Astride the right-angle corner it points half way between east and north, cutting the corner.
    const corner = path.distance(1, road.corners[0]!);
    const astride = bodyOnPath(path, corner + 0.005, 0.01);
    const east = road.tangent(0.25);
    const north = road.tangent(0.75);
    expect(dot(astride.heading, east)).toBeCloseTo(Math.SQRT1_2, 3);
    expect(dot(astride.heading, north)).toBeCloseTo(Math.SQRT1_2, 3);
    expect(centralAngle(astride.ground, path.at(corner))).toBeGreaterThan(0.002);
    expect(length(astride.ground)).toBeCloseTo(1, 12);
  });
});

describe('vehicles stay on their own line', () => {
  const KM = 1 / 6371;
  /** How far p lies off the great circle through a and b, in radians. */
  const offLine = (p: Vec3, a: Vec3, b: Vec3) => Math.abs(Math.asin(dot(p, unit(cross(a, b)))));

  it('carries a line straight on in its general direction, not along a stray connector', () => {
    // 5 km east from the airport to the railway, then 200 km south along it.
    const rail = PathTrack.fromPoints([latLonToVec(0, 0), latLonToVec(0, 0.045), latLonToVec(-1.8, 0.045)])!;
    const behind = new JourneyPath([rail]).at(-100 * KM);
    // Back north, the way the line came, rather than west off the end of the connector.
    const fromStart = sub(behind, rail.a);
    expect(dot(fromStart, [0, 1, 0])).toBeGreaterThan(0);
    expect(Math.abs(dot(fromStart, [0, 1, 0]))).toBeGreaterThan(4 * Math.abs(dot(fromStart, [0, 0, -1])));
  });

  // A flight to Auckland, two trains, a bus, and a flight home. Each ground leg leaves its airport along a short
  // connector due east before turning toward the next, as traced routes do.
  const scene = normalize(
    spec([
      leg('syd-akl', 'SYD', 'AKL', '2031-10-17T06:00:00+11:00', '2031-10-17T11:10:00+13:00', 'A21N'),
      surface('akl-hlz', 'AKL', 'HLZ', '2031-10-17T12:30:00+13:00', '2031-10-17T14:30:00+13:00', 'train'),
      surface('hlz-pmr', 'HLZ', 'PMR', '2031-10-17T15:00:00+13:00', '2031-10-17T20:00:00+13:00', 'train'),
      surface('pmr-npe', 'PMR', 'NPE', '2031-10-18T08:00:00+13:00', '2031-10-18T11:00:00+13:00', 'bus'),
      leg('npe-wlg', 'NPE', 'WLG', '2031-10-18T12:00:00+13:00', '2031-10-18T13:00:00+13:00', 'AT76'),
    ]),
  );
  for (const l of scene.legs) {
    if (!l.mode) continue;
    const a = scene.airports[l.from]!;
    const b = scene.airports[l.to]!;
    l.path = encodePolyline([[a.lat, a.lon], [a.lat, a.lon + 0.06], [b.lat, b.lon]]);
  }
  const tl = buildTimeline(scene);
  const stopAfter = (i: number, u: number) => {
    const seg = tl.segments.find((x) => x.kind === 'stop' && x.leg === i)!;
    return evaluate(tl, seg.t0 + u * (seg.t1 - seg.t0));
  };
  /** The train: a locomotive and three cars, about 0.11 of a short side some 1,450 km across. */
  const TRAIN = 160 * KM;

  it('lines a train up behind the station along its own railway while a flight dissolves into it', () => {
    const s = stopAfter(0, 0.5);
    expect(s.aircraft.mix.map((m) => m.type)).toEqual(['A21N', 'train']);
    const { path, at } = vehiclePlace(tl, s, 'train');
    expect(dot(path.at(at), s.aircraft.ground)).toBeCloseTo(1, 12);
    const rail = tl.legs[1]!.track;
    const ahead = rail.at((30 * KM) / rail.angle);
    const flight = tl.legs[0]!.track;
    for (const x of [0.25, 0.5, 1]) {
      const p = path.at(at - x * TRAIN);
      // Straight back from the station, on the railway's own line ...
      expect(offLine(p, rail.a, ahead)).toBeLessThan(1e-9);
      expect(dot(sub(p, rail.a), sub(ahead, rail.a))).toBeLessThan(0);
      // ... not back along the flight's ground track.
      expect(offLine(p, flight.a, flight.b)).toBeGreaterThan(0.1 * x * TRAIN);
    }
  });

  it('runs on through a connection to another train, and carries straight past the last station', () => {
    const s = stopAfter(1, 0.5);
    expect(s.aircraft.mix).toEqual([{ type: 'train', weight: 1 }]);
    const { path, at } = vehiclePlace(tl, s, 'train');
    const first = tl.legs[1]!.track;
    // The cars wait on the railway they arrived on.
    expect(dot(path.at(at - 50 * KM), first.at(1 - (50 * KM) / first.angle))).toBeCloseTo(1, 12);
    // At the end of the second train, the locomotive's nose carries on in the railway's direction, not toward
    // the bus.
    const end = vehiclePlace(tl, stopAfter(2, 0.5), 'train');
    const second = tl.legs[2]!.track;
    const before = second.at(1 - (30 * KM) / second.angle);
    const p = end.path.at(end.at + 20 * KM);
    expect(offLine(p, before, second.b)).toBeLessThan(1e-9);
    expect(dot(sub(p, second.b), sub(second.b, before))).toBeGreaterThan(0);
  });

  it('keeps the bus off the railway while the train dissolves into it', () => {
    const s = stopAfter(2, 0.5);
    expect(s.aircraft.mix.map((m) => m.type)).toEqual(['train', 'bus']);
    const { path, at } = vehiclePlace(tl, s, 'bus');
    expect(at).toBe(0);
    const road = tl.legs[3]!.track;
    const ahead = road.at((30 * KM) / road.angle);
    const p = path.at(at - 20 * KM);
    expect(offLine(p, road.a, ahead)).toBeLessThan(1e-9);
    const rail = tl.legs[2]!.track;
    expect(centralAngle(p, rail.at(1 - (20 * KM) / rail.angle))).toBeGreaterThan(5 * KM);
  });
});

describe('vehicle models', () => {
  const box = (g: THREE.BufferGeometry) => {
    g.computeBoundingBox();
    return g.boundingBox!;
  };

  it.each(SURFACE_MODES)('builds the %s closed, outward, and standing on the ground', (mode) => {
    const model = vehicleModel(mode);
    for (const b of model.bodies) {
      const position = b.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < position.array.length; i++) expect(Number.isFinite(position.array[i])).toBe(true);
      const bb = box(b.geometry);
      // Built in fractions of the frame's short side, the nose toward +z, symmetric about the centre line.
      expect(bb.max.z - bb.min.z).toBeGreaterThanOrEqual(b.length * 0.999);
      expect(bb.max.z - bb.min.z).toBeLessThan(b.length + model.gap + 1e-6);
      expect(bb.max.x).toBeCloseTo(-bb.min.x, 9);
      expect(bb.max.x - bb.min.x).toBeLessThanOrEqual(model.width + 1e-6);
      // On the ground, or just above it on its (unseen) wheels.
      expect(bb.min.y).toBeGreaterThanOrEqual(0);
      expect(bb.min.y).toBeLessThan(0.15 * model.width);
      // Faces wind outward: the signed volume of the whole body is positive.
      const index = b.geometry.getIndex()!;
      const v = (k: number) => new THREE.Vector3().fromBufferAttribute(position, index.getX(k));
      let volume = 0;
      for (let k = 0; k < index.count; k += 3) volume += v(k).dot(v(k + 1).cross(v(k + 2)));
      expect(volume).toBeGreaterThan(0);
      expect(b.lamps.getAttribute('aSize').count).toBe(b.lamps.getAttribute('position').count);
    }
    expect(vehicleModel(mode)).toBe(model);
  });

  it('tells the modes apart from above by shape, not only length', () => {
    const aspect = (mode: (typeof SURFACE_MODES)[number]) => vehicleModel(mode).bodies[0]!.length / vehicleModel(mode).width;
    // A short, wide car; a long bus; a train of a locomotive and three cars; a ferry with a pointed bow.
    expect(aspect('car')).toBeLessThan(2.5);
    expect(aspect('bus')).toBeGreaterThan(3);
    expect(vehicleModel('train').bodies).toHaveLength(4);
    expect(vehicleModel('car').bodies).toHaveLength(1);
    const ferry = vehicleModel('ferry').bodies[0]!.geometry;
    const position = ferry.getAttribute('position') as THREE.BufferAttribute;
    const bb = box(ferry);
    let bowWidth = 0;
    for (let i = 0; i < position.count; i++) {
      if (position.getZ(i) > bb.max.z - 0.05 * (bb.max.z - bb.min.z)) bowWidth = Math.max(bowWidth, Math.abs(position.getX(i)));
    }
    expect(bowWidth).toBeLessThan(0.5 * bb.max.x);
  });
});

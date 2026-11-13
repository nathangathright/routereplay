import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { vehicleModel } from '../src/app/render/vehicles';
import { GreatCircle, centralAngle } from '../src/shared/geo/greatCircle';
import { PathTrack } from '../src/shared/geo/track';
import { dot, latLonToVec, length } from '../src/shared/geo/vec';
import { SURFACE_MODES } from '../src/shared/scene/constants';
import { JourneyPath, bodyOnPath } from '../src/shared/timeline/journeyPath';

describe('journey path', () => {
  // A flight east along the equator, then a road that turns north at a right angle.
  const flight = GreatCircle.fromLatLon(0, 0, 0, 10);
  const road = PathTrack.fromPoints([latLonToVec(0, 10), latLonToVec(0, 11), latLonToVec(1, 11)])!;
  const path = new JourneyPath([flight, road]);

  it('runs through every leg end to end, measured in radians', () => {
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

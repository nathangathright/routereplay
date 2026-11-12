import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { airframeModel } from '../src/app/render/airframe';
import { AIRCRAFT_DESIGNATORS, AIRCRAFT_FAMILIES, AIRCRAFT_TYPES } from '../src/shared/scene/aircraft';
import { sceneSchemaV1 } from '../src/shared/scene/schema';

describe('aircraft library', () => {
  it('publishes every designator in the schema, each with a known family', () => {
    expect(sceneSchemaV1.$defs.leg.properties.aircraft.enum).toEqual(AIRCRAFT_DESIGNATORS);
    for (const type of AIRCRAFT_DESIGNATORS) {
      expect(type).toMatch(/^[A-Z0-9]{4}$/);
      expect(AIRCRAFT_FAMILIES[AIRCRAFT_TYPES[type].family]).toBeDefined();
    }
  });

  it.each(AIRCRAFT_DESIGNATORS)('builds %s one unit long, at its published proportions', (type) => {
    const a = AIRCRAFT_TYPES[type];
    const { geometry, lampGeometry, bottom } = airframeModel(type);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < position.array.length; i++) expect(Number.isFinite(position.array[i])).toBe(true);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    // Nose to tail is the overall length; the span is the published span, wingtip devices included.
    expect(box.max.z).toBeCloseTo(0.5, 2);
    expect(box.min.z).toBeGreaterThanOrEqual(-0.5 - 1e-6);
    expect(box.min.z).toBeLessThan(-0.49);
    expect((box.max.x - box.min.x) / (a.span / a.length)).toBeCloseTo(1, 1);
    expect(box.max.x).toBeCloseTo(-box.min.x, 6);
    expect(bottom).toBeGreaterThan(0);
    expect(bottom).toBeCloseTo(-box.min.y, 6);
    // Red on the left wingtip (+x), green on the right.
    const lamps = lampGeometry.getAttribute('position') as THREE.BufferAttribute;
    expect(lamps.getX(0)).toBeGreaterThan(0.3 * (a.span / a.length) / 2);
    expect(lamps.getX(1)).toBeCloseTo(-lamps.getX(0), 6);
  });

  it('shares one geometry per type', () => {
    expect(airframeModel('B738')).toBe(airframeModel('B738'));
  });
});

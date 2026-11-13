import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { type Vec3, cross, dot, latLonToVec, normalize } from '../src/shared/geo/vec';
import { aircraftRadius } from '../src/app/render/airframe';
import { type ShadowCaster, planeShadowUniforms, setPlaneShadowUniforms, silhouette } from '../src/app/render/planeShadow';

const DEG = Math.PI / 180;

/** A caster over 0°N 0°E heading north, and a Sun `elevation` above its horizon, in the east. */
function setUp(elevation: number, caster: Partial<ShadowCaster> = {}) {
  const ground = latLonToVec(0, 0);
  const north: Vec3 = [0, 1, 0];
  const eastward = normalize(cross(north, ground));
  const sun = normalize([
    ground[0] * Math.sin(elevation) + eastward[0] * Math.cos(elevation),
    ground[1] * Math.sin(elevation) + eastward[1] * Math.cos(elevation),
    ground[2] * Math.sin(elevation) + eastward[2] * Math.cos(elevation),
  ]);
  const c: ShadowCaster = { type: 'B77W', ground, heading: north, altitude: 0.02, size: 0.1, aloft: 1, weight: 1, ...caster };
  const u = planeShadowUniforms();
  setPlaneShadowUniforms(u, [c], sun);
  const v = (k: string) => (u[k]!.value as THREE.Vector4[])[0]!;
  return { c, u, up: v('casterUp'), light: v('casterLight') };
}

describe('aircraft shadow', () => {
  it('rasterizes the same symmetric silhouette every time, clear of the mask edges', () => {
    const a = silhouette('A320');
    expect(silhouette('A320')).toEqual(a);
    const size = Math.sqrt(a.length);
    let covered = 0;
    let asymmetry = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = a[y * size + x]!;
        covered += v / 255;
        asymmetry += Math.abs(v - a[y * size + (size - 1 - x)]!) / 255;
        if (x === 0 || y === 0 || x === size - 1 || y === size - 1) expect(v).toBe(0);
      }
    }
    expect(covered).toBeGreaterThan(500);
    expect(asymmetry / covered).toBeLessThan(0.02);
  });

  it('is gone at night, fades in with the Sun, and follows the dissolve weight', () => {
    expect(setUp(-5 * DEG).light.w).toBe(0);
    expect(setUp(5 * DEG).light.w).toBeGreaterThan(0);
    expect(setUp(5 * DEG).light.w).toBeLessThan(setUp(45 * DEG).light.w);
    expect(setUp(45 * DEG, { weight: 0.25 }).light.w).toBeCloseTo(setUp(45 * DEG).light.w * 0.25, 6);
  });

  it('is cast along a Sun at least 27° high, from at most 0.3 lengths above the parked height', () => {
    for (const elevation of [12, 27, 60]) {
      const { up, light } = setUp(elevation * DEG);
      const height = Math.asin(dot([light.x, light.y, light.z], [up.x, up.y, up.z])) / DEG;
      expect(height).toBeCloseTo(Math.max(elevation, 27), 6);
    }
    const parked = aircraftRadius('B77W', 0, 0.1) - 1;
    expect(setUp(45 * DEG).up.w).toBeCloseTo(parked + 0.3 * 0.1, 9);
    // On the ground it touches the wheels: cast from the parked height.
    expect(setUp(45 * DEG, { altitude: 0, aloft: 0 }).up.w).toBeCloseTo(parked, 9);
  });
});

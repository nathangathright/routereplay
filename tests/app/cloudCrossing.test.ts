import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CLOUD_RADIUS, DECK_GLSL, veilMaterial } from '../../src/app/render/Clouds';
import { DECK_DEPTH, VEIL_MAX, submersion, veil, veilStrength } from '../../src/app/render/cloudCrossing';
import { type CloudsBelow, craftLight, luminance } from '../../src/app/render/craftLight';
import { skyLights } from '../../src/app/render/lighting';
import { type ShadowCaster, shadowOn } from '../../src/app/render/planeShadow';
import { cross, normalize, scale } from '../../src/shared/geo/vec';
import { CRUISE_DISPLAY, displayAltitude, flightProgress } from '../../src/shared/timeline/evaluate';
import { CLOUD_GRID } from '../../src/shared/weather/gfs';

const DEG = Math.PI / 180;
/** The deck's top above the ground, Earth radii (25.5 km as drawn). */
const TOP = CLOUD_RADIUS - 1;
/** The default leg: 6 s on screen at 30 frames a second. */
const LEG_SECONDS = 6;
const FPS = 30;

/** Display altitude a fraction u of the way through a leg's screen time, as evaluate() has it. */
const altitudeAt = (u: number) => displayAltitude(CRUISE_DISPLAY, flightProgress(u));

describe('a craft crossing the cloud deck', () => {
  it('is under the deck by its altitude: wholly 1 km of real cloud below the top, not at all at or above it', () => {
    expect((DECK_DEPTH * 6_371_000) / 12).toBeCloseTo(1000, 6);
    expect(submersion(0, TOP)).toBe(1);
    expect(submersion(TOP - DECK_DEPTH, TOP)).toBe(1);
    expect(submersion(TOP - DECK_DEPTH / 2, TOP)).toBeCloseTo(0.5, 9);
    expect(submersion(TOP, TOP)).toBe(0);
    expect(submersion(CRUISE_DISPLAY, TOP)).toBe(0);
  });

  it('is veiled less and less through the climb and more and more through the descent, frame by frame', () => {
    const frames = LEG_SECONDS * FPS;
    const veils = Array.from({ length: frames + 1 }, (_, i) => veil(altitudeAt(i / frames), TOP, 1));
    for (let i = 1; i <= frames / 2; i++) expect(veils[i]!).toBeLessThanOrEqual(veils[i - 1]!);
    for (let i = frames / 2 + 1; i <= frames; i++) expect(veils[i]!).toBeGreaterThanOrEqual(veils[i - 1]!);
    // Strictly so on the frames of the crossing itself, which the climb and descent mirror.
    const climb = veils.slice(0, frames / 2 + 1);
    const crossing = climb.flatMap((v, i) => (v > 0 && v < VEIL_MAX ? [i] : []));
    expect(crossing.length).toBeGreaterThanOrEqual(6);
    for (const i of crossing) expect(climb[i + 1]!).toBeLessThan(climb[i]!);
    const descent = veils.slice(frames / 2).reverse();
    for (const [i, v] of climb.entries()) expect(descent[i]).toBeCloseTo(v, 9);
  });

  it('crosses in the time the altitude profile gives, about 0.26 s of a 6 s leg', () => {
    // Bisect the leg's screen time for where the craft leaves its last full veil and where it is clear of the deck.
    const crossing = (target: (s: number) => boolean) => {
      let [lo, hi] = [0, 0.5];
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2;
        if (target(submersion(altitudeAt(mid), TOP))) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    const start = crossing((s) => s < 1);
    const end = crossing((s) => s === 0);
    expect(start).toBeCloseTo(0.16, 2);
    expect(end).toBeCloseTo(0.204, 2);
    expect((end - start) * LEG_SECONDS).toBeGreaterThan(0.2);
    expect((end - start) * LEG_SECONDS).toBeLessThan(0.3);
  });

  it('is capped at the gate, so a plane under the thickest deck still reads as a faint shape', () => {
    expect(VEIL_MAX).toBeGreaterThanOrEqual(0.6);
    expect(VEIL_MAX).toBeLessThanOrEqual(0.7);
    expect(veil(0, TOP, 1)).toBe(VEIL_MAX);
    expect(veil(0, TOP, 3)).toBe(VEIL_MAX);
    expect(veilStrength(1.5)).toBe(VEIL_MAX);
    for (let a = 0; a <= TOP + 0.001; a += TOP / 40) {
      for (const d of [0, 0.3, 0.7, 1]) expect(veil(a, TOP, d)).toBeLessThanOrEqual(VEIL_MAX);
    }
  });

  it('is veiled in proportion to the deck’s opacity, so thin or broken cloud veils less', () => {
    for (const a of [0, TOP - 0.75 * DECK_DEPTH, TOP - 0.3 * DECK_DEPTH]) {
      const full = veil(a, TOP, 1);
      expect(full).toBeGreaterThan(0);
      for (const d of [0, 0.1, 0.45, 0.9]) expect(veil(a, TOP, d)).toBeCloseTo(d * full, 12);
    }
  });

  it('is never veiled above the deck, however thick it is', () => {
    for (const a of [TOP, TOP + 1e-6, 0.006, CRUISE_DISPLAY]) {
      expect(submersion(a, TOP)).toBe(0);
      expect(veil(a, TOP, 1)).toBe(0);
    }
  });
});

describe('the light on a craft under the deck', () => {
  // 21 June 2026, noon UTC, with the Sun 50° up.
  const lights = skyLights(Date.UTC(2026, 5, 21, 12));
  const across = normalize(cross(cross(lights.sun, [0, 1, 0]), lights.sun));
  const [s, c] = [Math.sin(50 * DEG), Math.cos(50 * DEG)];
  const ground = normalize([lights.sun[0] * s + across[0] * c, lights.sun[1] * s + across[1] * c, lights.sun[2] * s + across[2] * c]);
  const at = (altitude: number, clouds: CloudsBelow | null) => craftLight({ ground, altitude, lights, eye: scale(ground, 2), screenUp: [0, 1, 0], clouds });
  const overcast = { frame: uniformClouds(1), top: CLOUD_RADIUS };

  it('keeps the direct light the ground keeps under the same cloud, and turns the sky to the deck’s grey', () => {
    const parked = at(0, overcast);
    const clear = at(0, null);
    expect(parked.submersion).toBe(1);
    expect(parked.overhead).toBeCloseTo(0.95, 2);
    expect(parked.veil).toBeCloseTo(VEIL_MAX, 2);
    for (let i = 0; i < 3; i++) expect(parked.sun[i]!).toBeCloseTo(clear.sun[i]! * 0.46, 6);
    // The deck's base is grey: far less blue over red than the clear sky.
    expect(parked.sky[2] / parked.sky[0]).toBeLessThan(0.5 * (clear.sky[2] / clear.sky[0]) + 0.5);
    expect(luminance(parked.sky)).toBeGreaterThan(luminance(clear.sky));
    // From under the deck it sees the ground, not the deck's bright top.
    expect(luminance(parked.ground)).toBeLessThan(luminance(at(CRUISE_DISPLAY, overcast).ground));
  });

  it('is lit as before above the deck', () => {
    const cruise = at(CRUISE_DISPLAY, overcast);
    const clearCruise = at(CRUISE_DISPLAY, null);
    expect(cruise.submersion).toBe(0);
    expect(cruise.veil).toBe(0);
    expect(cruise.sun).toEqual(clearCruise.sun);
    expect(cruise.sky).toEqual(clearCruise.sky);
  });

  it('is lit as before under clear sky, wherever it is', () => {
    const none = { frame: uniformClouds(0), top: CLOUD_RADIUS };
    const parked = at(0, none);
    expect(parked.submersion).toBe(1);
    expect(parked.veil).toBe(0);
    expect(parked.sun).toEqual(at(0, null).sun);
    expect(parked.sky).toEqual(at(0, null).sky);
  });
});

describe('the aircraft’s shadow and the deck', () => {
  const caster: ShadowCaster = { type: 'B77W', ground: [1, 0, 0], heading: [0, 1, 0], altitude: 0, size: 0.03, aloft: 0, weight: 1 };

  it('stays off the cloud tops while under the deck, and lands on them as it breaks out', () => {
    const under = { ...caster, submersion: 1, overhead: 0.95 };
    expect(shadowOn('deck', under)).toBe(0);
    expect(shadowOn('ground', under)).toBe(1);
    expect(shadowOn('air', under)).toBeCloseTo(0.05, 9);
    expect(shadowOn('deck', { ...caster, submersion: 0.25 })).toBeCloseTo(0.75, 9);
    for (const surface of ['ground', 'deck', 'air'] as const) {
      expect(shadowOn(surface, { ...caster, submersion: 0, overhead: 0 })).toBe(1);
      expect(shadowOn(surface, caster)).toBe(1);
    }
  });
});

describe('the veil', () => {
  it('runs the deck’s own shader over the craft, only where the craft is the front-most surface', () => {
    const scene = veilMaterial(true, false);
    const graphics = veilMaterial(true, true);
    expect(DECK_GLSL).toContain('vec4 deck(vec3 n)');
    expect(scene.fragmentShader).toContain(DECK_GLSL);
    expect(scene.fragmentShader).toMatch(/vec4 cloud = deck\(n\);/);
    // Scene light for the aircraft, graphics for the vehicles (display.tsx splits the passes on `transparent`).
    expect(scene.transparent).toBe(false);
    expect(graphics.transparent).toBe(true);
    for (const m of [scene, graphics]) {
      expect(m.depthFunc).toBe(THREE.LessEqualDepth);
      expect(m.depthWrite).toBe(false);
      expect(m.alphaHash).toBe(true);
      // The frame's alpha is left alone.
      expect(m.blendSrcAlpha).toBe(THREE.ZeroFactor);
      expect(m.blendDstAlpha).toBe(THREE.OneFactor);
    }
    expect(scene.defines).toHaveProperty('LINEAR_SCENE');
    expect(veilMaterial(false, false).defines).not.toHaveProperty('LINEAR_SCENE');
  });
});

/** A weather frame with the same cloud water everywhere (0–1 of the stored opacity) and no wind. */
function uniformClouds(water: number): CloudsBelow['frame'] {
  const n = CLOUD_GRID.nx * CLOUD_GRID.ny;
  const field = (data: Uint8Array, format: THREE.PixelFormat) => new THREE.DataTexture(data, CLOUD_GRID.nx, CLOUD_GRID.ny, format);
  const step = { cloud: field(new Uint8Array(n).fill(Math.round(255 * water)), THREE.RedFormat), wind: field(new Uint8Array(2 * n).fill(128), THREE.RGFormat) };
  return { a: step, b: step, blend: 0, presence: 1, ageA: 0, ageB: 0 };
}

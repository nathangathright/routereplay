import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BETA_M, BETA_R, H_M, H_R, SUN_ABOVE_AIR, airAboveAlbedo, clearSkyLight, lightThroughAir, verticalTransmittance } from '../src/app/render/airLight';
import { type CloudsBelow, type CraftLight, cirrusCoverAt, cloudCoverAt, craftLight, levelLight, luminance } from '../src/app/render/craftLight';
import { AIR_GLSL, HAZE_BACKSCATTER, type SkyLights, SUN_ABOVE_AIR as SUN_ABOVE_AIR_GLSL, skyLights } from '../src/app/render/lighting';
import { moonPosition } from '../src/shared/geo/solar';
import { type Vec3, cross, dot, normalize, scale } from '../src/shared/geo/vec';
import { CRUISE_DISPLAY } from '../src/shared/timeline/evaluate';
import { CLOUD_GRID } from '../src/shared/weather/gfs';

const DEG = Math.PI / 180;
/** Full Moon: 5 November 2025, 13:19 UTC. New Moon: 20 November 2025, 06:47 UTC. */
const FULL_MOON = Date.UTC(2025, 10, 5, 13, 19);
const NEW_MOON = Date.UTC(2025, 10, 20, 6, 47);

/** A ground point where the Sun stands `elevation` degrees high (on the great circle through the Sun and the poles). */
function groundAt(lights: SkyLights, elevation: number): Vec3 {
  const s = lights.sun;
  const across = normalize(cross(cross(s, [0, 1, 0]), s));
  const a = elevation * DEG;
  return normalize([s[0] * Math.sin(a) + across[0] * Math.cos(a), s[1] * Math.sin(a) + across[1] * Math.cos(a), s[2] * Math.sin(a) + across[2] * Math.cos(a)]);
}

/** The light on a craft at `altitude` with the Sun `elevation` degrees up, seen from straight above, north up. */
function lit(utcMs: number, elevation: number, altitude = CRUISE_DISPLAY, clouds: CloudsBelow | null = null): CraftLight {
  const lights = skyLights(utcMs);
  const ground = groundAt(lights, elevation);
  return craftLight({ ground, altitude, lights, eye: scale(ground, 2), screenUp: [0, 1, 0], clouds });
}

const blueOverRed = (c: readonly number[]) => c[2]! / c[0]!;

describe('the air on the CPU', () => {
  it('uses the constants the shaders use (AIR_GLSL)', () => {
    const number = (name: string) => Number(new RegExp(`const float ${name} = ([0-9.]+)`).exec(AIR_GLSL)![1]);
    expect(H_R).toBeCloseTo(number('H_R'), 6);
    expect(H_M).toBeCloseTo(number('H_M'), 6);
    const [, r, g, b, k] = /BETA_R = vec3\(([0-9.]+), ([0-9.]+), ([0-9.]+)\) \* ([0-9.]+)/.exec(AIR_GLSL)!.map(Number);
    expect(BETA_R[0]).toBeCloseTo(r! * k!, 3);
    expect(BETA_R[1]).toBeCloseTo(g! * k!, 3);
    expect(BETA_R[2]).toBeCloseTo(b! * k!, 3);
    const [, m, km] = /BETA_M = ([0-9.]+) \* ([0-9.]+)/.exec(AIR_GLSL)!.map(Number);
    expect(BETA_M).toBeCloseTo(m! * km!, 4);
  });

  it('puts sunlight above the air in the ground’s units: one vertical column of air, undone', () => {
    const column = verticalTransmittance(1, 1.072);
    for (let i = 0; i < 3; i++) {
      expect(SUN_ABOVE_AIR[i]).toBeCloseTo(SUN_ABOVE_AIR_GLSL[i]!, 9);
      // The flat column groundLight() divides by, within the Chapman function's 0.2 % at the zenith.
      expect(SUN_ABOVE_AIR[i]! * column[i]!).toBeCloseTo(1, 2);
    }
    expect(SUN_ABOVE_AIR[2]).toBeGreaterThan(SUN_ABOVE_AIR[0]);
    const [, r, g, b] = /const vec3 OVERHEAD_AIR = vec3\(([0-9.]+), ([0-9.]+), ([0-9.]+)\)/.exec(AIR_GLSL)!.map(Number);
    expect([r, g, b].map((x, i) => x! / SUN_ABOVE_AIR[i]!).every((x) => Math.abs(x - 1) < 1e-4)).toBe(true);
    // Drawn straight to the frame, the air and clouds keep the light they were tuned with.
    expect(AIR_GLSL).toMatch(/#ifdef LINEAR_SCENE\s+\S.*\s+const vec3 SUN_ABOVE_AIR = OVERHEAD_AIR;\s+#else[\s\S]*const vec3 SUN_ABOVE_AIR = vec3\(1\.0\);/);
  });

  it('turns back haze’s share of scattering into the backward hemisphere (Henyey–Greenstein, g = 0.76)', () => {
    const g = 0.76;
    const n = 20000;
    let back = 0;
    for (let i = 0; i < n; i++) {
      const mu = -(i + 0.5) / n;
      back += ((1 - g * g) / (2 * (1 + g * g - 2 * g * mu) ** 1.5)) / n;
    }
    expect(HAZE_BACKSCATTER).toBeCloseTo(back, 5);
  });

  it('sends a share of a lit deck’s light back down from the air above it, most of the blue, less higher up', () => {
    const deck = airAboveAlbedo(1.004);
    expect(deck[0]).toBeGreaterThan(0.02);
    expect(deck[0]).toBeLessThan(deck[1]);
    expect(deck[1]).toBeLessThan(deck[2]);
    expect(deck[2]).toBeLessThan(0.16);
    const high = airAboveAlbedo(1.0119);
    expect(high[2]).toBeLessThan(deck[2]);
    // Thin air sends back about τ of an even light: half of what it scatters, along paths 2× the vertical on average.
    const thin = airAboveAlbedo(1.04);
    const [air] = [verticalTransmittance(1.04, 1.072)];
    expect(thin[0]).toBeCloseTo(-Math.log(air[0]), 2);
  });

  it('gives white light from an overhead Sun and reddens and dims it toward the horizon', () => {
    const p: Vec3 = [0, 1, 0];
    expect(lightThroughAir(p, [0, 1, 0])).toEqual([1, 1, 1]);
    const low = lightThroughAir(p, normalize([1, Math.tan(3 * DEG), 0]));
    expect(low[0]).toBeGreaterThan(low[1]);
    expect(low[1]).toBeGreaterThan(low[2]);
    expect(low[0]).toBeLessThan(0.9);
    // Below the ground's horizon the planet hides it; higher up it is still there.
    const below = normalize([1, -Math.tan(3 * DEG), 0]);
    expect(lightThroughAir(p, below)).toEqual([0, 0, 0]);
    expect(lightThroughAir([0, 1.012, 0], below)[0]).toBeGreaterThan(0.5);
  });

  it('gives a blue sky by day that fades through twilight', () => {
    const noon = clearSkyLight(60 * DEG);
    expect(noon[2]).toBeGreaterThan(noon[1]);
    expect(noon[1]).toBeGreaterThan(noon[0]);
    const sunset = clearSkyLight(0);
    const civil = clearSkyLight(-6 * DEG);
    const nautical = clearSkyLight(-12 * DEG);
    expect(luminance(sunset)).toBeLessThan(luminance(noon));
    expect(luminance(civil)).toBeLessThan(luminance(sunset));
    expect(luminance(nautical)).toBeLessThan(0.05 * luminance(noon));
  });
});

describe('light on a craft', () => {
  const utc = Date.UTC(2025, 10, 10, 12);

  it('is about as bright at midday as under the old lights, with no night rig', () => {
    const l = lit(utc, 70);
    // The old lights gave a white surface facing up 2.4 / π · cos 20° + 0.5 / π ≈ 0.88.
    expect(luminance(levelLight(l))).toBeGreaterThan(0.85);
    expect(luminance(levelLight(l))).toBeLessThan(1.15);
    expect(l.key).toEqual([0, 0, 0]);
    expect(l.fill).toEqual([0, 0, 0]);
    expect(l.lamps).toBe(0);
  });

  it('turns gold near sunset at cruise, and stays lit there after the ground has lost the Sun', () => {
    const golden = lit(utc, 0);
    expect(blueOverRed(golden.sun)).toBeLessThan(0.6);
    expect(golden.sun[0]).toBeGreaterThan(0.7);
    const parked = lit(utc, -2, 0);
    expect(parked.sun).toEqual([0, 0, 0]);
    const aloft = lit(utc, -2);
    expect(aloft.sun[0]).toBeGreaterThan(0.5);
    expect(blueOverRed(aloft.sun)).toBeLessThan(blueOverRed(golden.sun));
    expect(lit(utc, -10).sun).toEqual([0, 0, 0]);
  });

  it('brings in the night rig from 2° to 12° after sunset, with the navigation lights', () => {
    expect(lit(utc, -1).key).toEqual([0, 0, 0]);
    const half = lit(utc, -7);
    expect(half.key[2]).toBeGreaterThan(0.03);
    expect(half.key[2]).toBeLessThan(0.15);
    const night = lit(utc, -15);
    expect(night.key).toEqual([0.12, 0.14, 0.18]);
    // Its shadow waits until the Sun has set for the craft, so only one light at a time needs a shadow map.
    expect(lit(utc, -5).keyShadow).toBe(0);
    expect(lit(utc, -5, 0).keyShadow).toBe(1);
    expect(night.keyShadow).toBe(1);
    expect(night.fill).toEqual([0.025, 0.03, 0.04]);
    expect(night.lamps).toBe(1);
  });

  it('takes the night key from a high, bright Moon, and from the upper left without one', () => {
    // Under the full Moon, which stands overhead; the Sun is far below the horizon.
    const lights = skyLights(FULL_MOON);
    const ground = normalize(moonPosition(FULL_MOON));
    expect(dot(ground, lights.sun)).toBeLessThan(Math.sin(-12 * DEG));
    const moonlit = craftLight({ ground, altitude: CRUISE_DISPLAY, lights, eye: scale(ground, 2), screenUp: [0, 1, 0] });
    expect(dot(moonlit.keyDir, lights.moon)).toBeGreaterThan(0.999);
    expect(luminance(moonlit.moon)).toBeGreaterThan(0.004);
    // At new Moon, at midnight: the Moon is down, so the key comes from the frame's upper left.
    const dark = skyLights(NEW_MOON);
    const midnight = scale(dark.sun, -1);
    const moonless = craftLight({ ground: midnight, altitude: CRUISE_DISPLAY, lights: dark, eye: scale(midnight, 2), screenUp: [0, 1, 0] });
    expect(moonless.moon).toEqual([0, 0, 0]);
    expect(dot(moonless.keyDir, midnight)).toBeCloseTo(0.8, 2);
    const north = normalize([-midnight[0] * midnight[1], 1 - midnight[1] * midnight[1], -midnight[2] * midnight[1]]);
    expect(dot(moonless.keyDir, north)).toBeCloseTo(-0.36, 2);
  });

  it('throws more light up from a cloud deck than from clear ground', () => {
    const clear = lit(utc, 40);
    const overcast = lit(utc, 40, CRUISE_DISPLAY, { frame: uniformClouds(1), top: 1.004 });
    expect(luminance(overcast.ground)).toBeGreaterThan(2 * luminance(clear.ground));
    expect(cloudCoverAt(uniformClouds(1), [1, 0, 0])).toBeCloseTo(0.95, 2);
    expect(cloudCoverAt(uniformClouds(0), [1, 0, 0])).toBe(0);
  });

  it('reads the deck from the first channel of a field that carries more than one', () => {
    const n = CLOUD_GRID.nx * CLOUD_GRID.ny;
    const two = new Uint8Array(2 * n);
    for (let i = 0; i < n; i++) two[2 * i + 1] = 255; // a second layer everywhere, no deck
    const wind = new THREE.DataTexture(new Uint8Array(4 * n).fill(128), CLOUD_GRID.nx, CLOUD_GRID.ny, THREE.RGBAFormat);
    const step = { cloud: new THREE.DataTexture(two, CLOUD_GRID.nx, CLOUD_GRID.ny, THREE.RGFormat), wind };
    expect(cloudCoverAt({ a: step, b: step, blend: 0, presence: 1, ageA: 0, ageB: 0 }, [0, 0, 1])).toBe(0);
  });

  it('adds the high layer to the light from below only once the craft is over it', () => {
    const n = CLOUD_GRID.nx * CLOUD_GRID.ny;
    const two = new Uint8Array(2 * n);
    for (let i = 0; i < n; i++) two[2 * i + 1] = 255; // the high layer everywhere, no deck
    const wind = new THREE.DataTexture(new Uint8Array(4 * n).fill(128), CLOUD_GRID.nx, CLOUD_GRID.ny, THREE.RGBAFormat);
    const step = { cloud: new THREE.DataTexture(two, CLOUD_GRID.nx, CLOUD_GRID.ny, THREE.RGFormat), wind };
    const frame = { a: step, b: step, blend: 0, presence: 1, ageA: 0, ageB: 0 };
    expect(cirrusCoverAt(frame, [0, 0, 1])).toBeCloseTo(1, 5);
    const cirrus = 1 + (10_500 * 12) / 6_371_000;
    const clear = lit(utc, 40);
    const over = lit(utc, 40, CRUISE_DISPLAY, { frame, top: 1.004, cirrus });
    const under = lit(utc, 40, 0.5 * (cirrus - 1), { frame, top: 1.004, cirrus });
    expect(luminance(over.ground)).toBeGreaterThan(2 * luminance(clear.ground));
    expect(under.ground).toEqual(lit(utc, 40, 0.5 * (cirrus - 1)).ground);
  });

  it('depends only on its inputs, whatever was worked out before', () => {
    const first = lit(utc, 3);
    for (const e of [80, -30, 10, -5]) lit(utc, e);
    expect(lit(utc, 3)).toEqual(first);
  });
});

/** A weather frame with the same cloud water everywhere (0–1 of the stored opacity) and no wind. */
function uniformClouds(water: number): CloudsBelow['frame'] {
  const n = CLOUD_GRID.nx * CLOUD_GRID.ny;
  const field = (data: Uint8Array, format: THREE.PixelFormat) => new THREE.DataTexture(data, CLOUD_GRID.nx, CLOUD_GRID.ny, format);
  const step = { cloud: field(new Uint8Array(n).fill(Math.round(255 * water)), THREE.RedFormat), wind: field(new Uint8Array(2 * n).fill(128), THREE.RGFormat) };
  return { a: step, b: step, blend: 0, presence: 1, ageA: 0, ageB: 0 };
}

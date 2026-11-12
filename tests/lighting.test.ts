import { describe, expect, it } from 'vitest';
import { length } from '../src/shared/geo/vec';
import { moonPhaseBrightness, skyLights } from '../src/app/render/lighting';

describe('moonlight', () => {
  it('follows the Moon’s phase curve: full at 0, a little over a tenth at a half Moon, none when new', () => {
    expect(moonPhaseBrightness(0)).toBeCloseTo(1, 6);
    expect(moonPhaseBrightness(Math.PI / 2)).toBeGreaterThan(0.08);
    expect(moonPhaseBrightness(Math.PI / 2)).toBeLessThan(0.15);
    expect(moonPhaseBrightness(Math.PI)).toBe(0);
  });

  it('is about 1 % of sunlight at full Moon and nothing at new Moon', () => {
    // Full Moon 13 January 2025 22:27 UTC; new Moon 29 January 2025 12:36 UTC.
    const full = skyLights(Date.UTC(2025, 0, 13, 22, 27)).moonlight;
    const fresh = skyLights(Date.UTC(2025, 0, 29, 12, 36)).moonlight;
    expect(full).toBeGreaterThan(0.008);
    expect(full).toBeLessThan(0.012);
    expect(fresh).toBeLessThan(1e-4);
  });

  it('gives the Sun’s motion at the Earth’s turning rate and the hour of the day', () => {
    const lights = skyLights(Date.UTC(2026, 2, 20, 18, 30));
    // Near the equinox the Sun circles the equator at about 7.27e-5 radians a second.
    expect(length(lights.sunRate)).toBeCloseTo(7.27e-5, 6);
    expect(lights.utcHours).toBeCloseTo(18.5, 6);
  });
});

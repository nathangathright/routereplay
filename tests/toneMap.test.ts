import { describe, expect, it } from 'vitest';
import { DISPLAY_LIMIT, averageDisplay, reinhard, sceneFromDisplay } from '../src/app/render/toneMap';

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const EXPOSURES = [0.8, 1, 1.5, 2.2];

describe('the display transform', () => {
  it('is per-channel Reinhard after exposure, as three.js applies it', () => {
    expect(reinhard(1, 1)).toBeCloseTo(0.5);
    expect(reinhard(0.5, 2)).toBeCloseTo(0.5);
    expect(reinhard(-1, 1)).toBe(0);
    expect(reinhard(1e4, 2.2)).toBeLessThan(1);
  });

  it('gives display-referred things (stars, the Moon, the empty sky) back their display values at every exposure', () => {
    for (const e of EXPOSURES) {
      for (const display of [0, 0.001, 0.05, 0.3, 0.72, 0.99]) {
        expect(reinhard(sceneFromDisplay(display, e), e)).toBeCloseTo(display, 6);
      }
    }
  });

  it('stops short of the unbounded light a display value of 1 would need, which still encodes to 255', () => {
    for (const e of EXPOSURES) {
      const light = sceneFromDisplay(1.6, e);
      expect(Number.isFinite(light)).toBe(true);
      expect(light).toBeLessThan(65504); // half float
      expect(Math.round(255 * toSrgb(reinhard(light, e)))).toBe(255);
    }
    expect(sceneFromDisplay(1, 1)).toBe(sceneFromDisplay(DISPLAY_LIMIT, 1));
  });

  it('averages jittered samples after tone mapping each, so one sample is the frame as it was', () => {
    for (const e of EXPOSURES) {
      for (const light of [0, 0.01, 0.3, 1, 12, 4000]) expect(averageDisplay([light], e)).toBe(reinhard(light, e));
      // Identical samples average to themselves.
      expect(averageDisplay([0.4, 0.4, 0.4, 0.4], e)).toBeCloseTo(reinhard(0.4, e), 12);
    }
  });

  it('keeps a bright edge as bright as the share of the pixel it covers, inside the display range', () => {
    // Ocean glint over a dark sea: one of eight samples hits the glint.
    const e = 1;
    const sea = 0.02;
    const glint = 5000;
    const samples = [glint, ...Array<number>(7).fill(sea)];
    const average = averageDisplay(samples, e);
    expect(average).toBeLessThanOrEqual(1);
    expect(average).toBeCloseTo((reinhard(glint, e) + 7 * reinhard(sea, e)) / 8, 12);
    expect(average).toBeLessThan(0.15);
    // Averaging the light first would turn the whole pixel nearly white.
    const lightFirst = reinhard(samples.reduce((s, x) => s + x, 0) / 8, e);
    expect(lightFirst).toBeGreaterThan(0.99);
    // And it encodes inside 0–255.
    expect(Math.round(255 * toSrgb(average))).toBeLessThanOrEqual(255);
  });

  it('keeps the empty sky #02040a at every exposure', () => {
    const sky = [0x02, 0x04, 0x0a];
    for (const e of EXPOSURES) {
      const shown = sky.map((c) => Math.round(255 * toSrgb(reinhard(sceneFromDisplay(toLinear(c / 255), e), e))));
      expect(shown).toEqual(sky);
    }
  });
});

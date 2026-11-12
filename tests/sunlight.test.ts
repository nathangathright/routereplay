import { describe, expect, it } from 'vitest';
import { earthPhase, faceLuminance, labelTone, moonPhase, sunlightAt } from '../src/app/render/sunlight';
import type { Vec3 } from '../src/shared/geo/vec';

const SUN: Vec3 = [1, 0, 0];

/** An observer at distance `r` whose ray toward SUN passes `miss` Earth radii from the Earth's centre, Sun behind the Earth. */
const grazing = (r: number, miss: number): Vec3 => [-Math.sqrt(r * r - miss * miss), miss, 0];

describe('sunlight in space', () => {
  it('is full, nearly white sunlight on the day side', () => {
    const [red, green, blue] = sunlightAt([3.5, 0, 0], SUN, 1);
    expect(red).toBeCloseTo(1, 2);
    expect(green).toBeGreaterThan(0.95);
    expect(blue).toBeGreaterThan(0.9);
  });

  it('is unaffected by the atmosphere when the Earth is not between the observer and the Sun', () => {
    expect(sunlightAt([0, 3.5, 0], SUN, 1)).toEqual(sunlightAt([3.5, 0, 0], SUN, 1));
  });

  it('turns orange and dims as the ray grazes the atmosphere, red surviving longest', () => {
    const high = sunlightAt(grazing(3.5, 1.04), SUN, 1);
    const low = sunlightAt(grazing(3.5, 1.01), SUN, 1);
    expect(low[0]).toBeLessThan(high[0]);
    expect(low[0] / low[2]).toBeGreaterThan(high[0] / high[2]);
    expect(low[0]).toBeGreaterThan(low[1]);
    expect(low[1]).toBeGreaterThan(low[2]);
  });

  it('is gone while the Earth hides the Sun', () => {
    expect(sunlightAt(grazing(3.5, 0.5), SUN, 0)).toEqual([0, 0, 0]);
  });
});

describe('phases', () => {
  it('sees a full Earth from the Sun side and a new Earth from behind it', () => {
    expect(earthPhase([3, 0, 0], SUN)).toBeCloseTo(1);
    expect(earthPhase([-3, 0, 0], SUN)).toBeCloseTo(0);
  });

  it('sees a full Moon opposite the Sun', () => {
    expect(moonPhase([0, 0, 0], [-60, 0, 0], SUN)).toBeCloseTo(1);
    expect(moonPhase([0, 0, 0], [60, 0, 0], SUN)).toBeCloseTo(0);
  });
});

describe('label tone', () => {
  const dark: Vec3 = [0, 0, 0];
  const face = (sunZ: number) => faceLuminance({ sun: [1, 0.98, 0.95], sunZ, moon: dark, moonZ: 0, earth: dark, earthZ: -0.9 });

  it('uses a dark label on a sunlit face and a light one on a face in shadow', () => {
    expect(labelTone(face(1), null)).toBe('dark');
    expect(labelTone(face(-1), null)).toBe('light');
  });

  it('waits slightly past the crossover before switching', () => {
    expect(labelTone(0.18, 'dark')).toBe('dark');
    expect(labelTone(0.18, 'light')).toBe('light');
    expect(labelTone(0.16, 'dark')).toBe('light');
    expect(labelTone(0.2, 'light')).toBe('dark');
  });
});

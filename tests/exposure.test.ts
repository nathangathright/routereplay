import { describe, expect, it } from 'vitest';
import { EXPOSURE, adaptExposure, exposureProfile, meterGlobe, targetExposure } from '../src/shared/timeline/exposure';
import { buildTimeline, exposureAt } from '../src/shared/timeline/evaluate';
import { leg, normalize, spec } from './helpers';

describe('exposure meter', () => {
  const camera = [0, 0, 3] as const;
  const down = [0, 0, -1] as const;
  const up = [0, 1, 0] as const;

  it('reads sunlit ground under an overhead Sun near its brightest, and night near nothing', () => {
    const day = meterGlobe(camera, down, up, Math.tan(Math.PI / 8), [0, 0, 1]);
    const night = meterGlobe(camera, down, up, Math.tan(Math.PI / 8), [0, 0, -1]);
    expect(day).toBeGreaterThan(0.2);
    expect(day).toBeLessThanOrEqual(0.246);
    expect(night).toBeCloseTo(0.006, 5);
  });

  it('meters only the globe, not the sky around it', () => {
    const tight = meterGlobe(camera, down, up, Math.tan(Math.PI / 16), [0, 0, 1]);
    const wide = meterGlobe(camera, down, up, Math.tan(Math.PI / 3), [0, 0, 1]);
    expect(wide).toBeGreaterThan(0.1);
    expect(Math.abs(tight - wide)).toBeLessThan(0.1);
  });

  it('puts the metered globe at middle grey within bounds', () => {
    expect(targetExposure(0.09)).toBeCloseTo(2);
    expect(targetExposure(0.006)).toBe(EXPOSURE.max);
    expect(targetExposure(0.5)).toBe(EXPOSURE.min);
  });

  it('adapts smoothly in log exposure, covering 63 % in one adaptation time', () => {
    const e = adaptExposure(1, Math.E, EXPOSURE.adaptationSeconds);
    expect(Math.log(e)).toBeCloseTo(1 - Math.exp(-1), 6);
    const profile = exposureProfile([0.18, 0.18, 0.006, 0.006, 0.006], 0.25);
    expect(profile[0]).toBeCloseTo(1);
    expect(profile[2]).toBeGreaterThan(1);
    expect(profile[2]).toBeLessThan(profile[4]!);
    expect(profile[4]).toBeLessThan(EXPOSURE.max);
  });
});

describe('journey exposure', () => {
  // Chicago in the morning to Honolulu after dark.
  const scene = () =>
    normalize(
      spec([
        leg('ord-sfo', 'ORD', 'SFO', '2026-10-05T10:00:00-05:00', '2026-10-05T12:45:00-07:00'),
        leg('sfo-hnl', 'SFO', 'HNL', '2026-10-05T16:30:00-07:00', '2026-10-05T19:05:00-10:00'),
      ]),
    );

  it('is the same however playback seeks', () => {
    const a = buildTimeline(scene());
    const b = buildTimeline(scene());
    const times = [0, 1.3, 2.71, a.duration / 2, a.duration];
    const forward = times.map((t) => exposureAt(a, t));
    const backward = [...times].reverse().map((t) => exposureAt(b, t)).reverse();
    expect(backward).toEqual(forward);
    for (const e of forward) {
      expect(e).toBeGreaterThanOrEqual(EXPOSURE.min);
      expect(e).toBeLessThanOrEqual(EXPOSURE.max);
    }
  });

  it('opens up for night: the arrival after dark is exposed longer than the morning departure', () => {
    const tl = buildTimeline(scene());
    expect(exposureAt(tl, tl.duration)).toBeGreaterThan(2);
    expect(exposureAt(tl, 0)).toBeLessThan(1.8);
  });
});

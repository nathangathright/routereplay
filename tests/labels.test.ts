import { describe, expect, it } from 'vitest';
import { ASPECT_VALUE, type Timeline, buildTimeline, evaluate } from '../src/shared/timeline/evaluate';
import { FLAP_DURATION, FLAP_STAGGER, PANEL_H, PANEL_W } from '../src/shared/timeline/labels';
import { leg, normalize, spec } from './helpers';

/**
 * The offline renderer's README demo (routereplay `.local/readme-demo-current/trip.json`, 18 s at 30 fps, rendered
 * 1080×1920). Its `labels.json` reports each visit's slot (top-left corner), first visible frame, ground lock, and
 * retirement.
 */
const README = spec(
  [
    leg('ord-sfo', 'ORD', 'SFO', '2026-10-17T18:25:00-05:00', '2026-10-17T21:15:00-07:00', 'A21N'),
    leg('sfo-akl', 'SFO', 'AKL', '2026-10-17T23:15:00-07:00', '2026-10-19T08:10:00+13:00', 'B772'),
  ],
  { presentation: { durationSeconds: 18 } },
);
const OFFLINE_REPORT = [
  { code: 'ORD', slot: [640, 1130], first: 0, retired: 3.9 },
  { code: 'SFO', slot: [220, 610], first: 3.566667, retired: 10.933333 },
  { code: 'AKL', slot: [170, 950], first: 10.8, retired: null },
];

/** The same report, read off evaluate() frame by frame, with slots in the offline renderer's 1080×1920 frame. */
function report(tl: Timeline, aspect: number) {
  const out = tl.occurrences.map((o) => ({ code: o.code, slot: null as number[] | null, first: null as number | null, retired: null as number | null }));
  for (let f = 0; f < tl.durationInFrames; f++) {
    const t = f / tl.fps;
    const shown = new Map(evaluate(tl, t, aspect).labels.map((l) => [l.index, l]));
    out.forEach((r, i) => {
      const l = shown.get(i);
      if (l && r.first === null) {
        r.first = t;
        r.slot = [Math.round((l.panel.x + 540) * 1e6) / 1e6, Math.round((l.panel.y + 960) * 1e6) / 1e6];
      }
      if (!l && r.first !== null && r.retired === null) r.retired = t;
    });
  }
  return out;
}

describe('airport labels', () => {
  it("match the offline renderer's slots, appearances, and retirements for its README demo", () => {
    const tl = buildTimeline(normalize(README));
    const got = report(tl, ASPECT_VALUE['9:16']);
    expect(got.map((r) => r.code)).toEqual(OFFLINE_REPORT.map((r) => r.code));
    got.forEach((r, i) => {
      const want = OFFLINE_REPORT[i]!;
      expect(r.slot).toEqual(want.slot);
      expect(r.first).toBeCloseTo(want.first, 5);
      if (want.retired === null) expect(r.retired).toBeNull();
      else expect(r.retired).toBeCloseTo(want.retired, 5);
    });
  });

  it('flip in from blank cards, then hold their slot until arrival and lock to the ground', () => {
    const tl = buildTimeline(normalize(README));
    const aspect = ASPECT_VALUE['9:16'];
    const at = (t: number) => evaluate(tl, t, aspect).labels.find((l) => l.code === 'SFO')!;
    const first = at(3.6);
    expect(first.age).toBeCloseTo(3.6 - 3.566667, 5);
    expect(first.panel).toEqual({ x: 220 - 540, y: 610 - 960, w: PANEL_W, h: PANEL_H });
    expect(at(5.5).panel).toEqual(first.panel);
    // At arrival the anchor locks under the slot; during the stop the camera is still, so nothing moves.
    const lock = tl.legs[0]!.flightEnd;
    const locked = at(lock + 0.5).panel;
    expect(locked.x).toBeCloseTo(first.panel.x, 6);
    expect(locked.w).toBeCloseTo(PANEL_W, 6);
    // After departure it recedes with the ground: smaller, then fading once under 30 % of its size.
    const smaller = at(tl.legs[1]!.flightStart + 1.5);
    expect(smaller.panel.w).toBeLessThan(PANEL_W * 0.85);
    expect(smaller.opacity).toBe(1);
    const fading = at(tl.legs[1]!.flightStart + 3);
    expect(fading.panel.w).toBeLessThan(PANEL_W * 0.3);
    expect(fading.opacity).toBeGreaterThan(0);
    expect(fading.opacity).toBeLessThan(1);
    expect(FLAP_DURATION + 2 * FLAP_STAGGER).toBeCloseTo(0.74, 9);
  });

  it('pulse at each arrival for 1.7 s', () => {
    const tl = buildTimeline(normalize(README));
    const arrival = tl.legs[0]!.flightEnd;
    expect(evaluate(tl, arrival - 0.01).pulses).toEqual([]);
    const pulse = evaluate(tl, arrival + 0.5).pulses;
    expect(pulse).toHaveLength(1);
    expect(pulse[0]!.age).toBeCloseTo(0.5, 9);
    expect(Math.hypot(pulse[0]!.x, pulse[0]!.y)).toBeLessThan(1);
    expect(evaluate(tl, arrival + 1.71).pulses).toEqual([]);
  });
});

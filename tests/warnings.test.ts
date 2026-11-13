import { describe, expect, it } from 'vitest';
import { sceneWarnings } from '../src/shared/scene/warnings';
import { buildTimeline, evaluate } from '../src/shared/timeline/evaluate';
import type { SceneSpecV1 } from '../src/shared/scene/types';
import { leg, normalize, spec } from './helpers';

const NOW = Date.parse('2026-11-11T00:00:00Z');
const codes = (s: SceneSpecV1) => sceneWarnings(normalize(s), NOW).map((w) => `${w.code} ${w.path}`);

/**
 * Plausible real-world itineraries (times modelled on published schedules) that must stay
 * quiet with default presentation. Thresholds that warn here would nag creators.
 */
const CORPUS: Record<string, SceneSpecV1> = {
  'ultra long haul (SIN–JFK, about 19 h)': spec([leg('sin-jfk', 'SIN', 'JFK', '2027-03-10T23:35:00+08:00', '2027-03-11T05:30:00-05:00')]),
  'date line eastbound (SYD–LAX arrives the same morning)': spec([
    leg('syd-lax', 'SYD', 'LAX', '2027-02-01T11:50:00+11:00', '2027-02-01T06:45:00-08:00'),
  ]),
  'date line westbound (LAX–AKL skips a day)': spec([
    leg('lax-akl', 'LAX', 'AKL', '2027-02-03T21:30:00-08:00', '2027-02-05T07:15:00+13:00'),
  ]),
  'polar long haul (HKG–JFK)': spec([leg('hkg-jfk', 'HKG', 'JFK', '2027-06-10T09:45:00+08:00', '2027-06-10T13:45:00-04:00')]),
  'longest scheduled route class (PER–LHR)': spec([
    leg('per-lhr', 'PER', 'LHR', '2027-01-20T18:45:00+08:00', '2027-01-21T05:10:00+00:00'),
  ]),
  'short inter-island hop (OGG–HNL, 40 min)': spec([leg('ogg-hnl', 'OGG', 'HNL', '2027-05-01T07:00:00-10:00', '2027-05-01T07:40:00-10:00')]),
  'congested short shuttle (LGA–BOS, 1 h 25 min)': spec([
    leg('lga-bos', 'LGA', 'BOS', '2027-04-12T08:00:00-04:00', '2027-04-12T09:25:00-04:00'),
  ]),
  'multi-day stay given room on screen (LHR–JFK–LHR)': spec(
    [
      leg('lhr-jfk', 'LHR', 'JFK', '2027-05-03T11:00:00+01:00', '2027-05-03T13:55:00-04:00'),
      leg('jfk-lhr', 'JFK', 'LHR', '2027-05-08T18:30:00-04:00', '2027-05-09T06:40:00+01:00'),
    ],
    { presentation: { stopHolds: { 'lhr-jfk': 6 } } },
  ),
  'repeated airports, same-day return (MEL–SYD–MEL)': spec([
    leg('mel-syd', 'MEL', 'SYD', '2027-03-02T07:00:00+11:00', '2027-03-02T08:25:00+11:00'),
    leg('syd-mel', 'SYD', 'MEL', '2027-03-02T18:00:00+11:00', '2027-03-02T19:35:00+11:00'),
  ]),
  'connection across the Pacific (BNE–LAX–DFW)': spec([
    leg('bne-lax', 'BNE', 'LAX', '2027-02-10T10:00:00+10:00', '2027-02-10T05:50:00-08:00'),
    leg('lax-dfw', 'LAX', 'DFW', '2027-02-10T09:15:00-08:00', '2027-02-10T14:25:00-06:00'),
  ]),
  'island hopping, twelve legs (HNL and outer islands)': spec([
    leg('hnl-ogg-1', 'HNL', 'OGG', '2027-07-01T07:00:00-10:00', '2027-07-01T07:40:00-10:00'),
    leg('ogg-koa', 'OGG', 'KOA', '2027-07-02T09:00:00-10:00', '2027-07-02T09:40:00-10:00'),
    leg('koa-hnl', 'KOA', 'HNL', '2027-07-03T10:00:00-10:00', '2027-07-03T10:50:00-10:00'),
    leg('hnl-lih', 'HNL', 'LIH', '2027-07-04T08:00:00-10:00', '2027-07-04T08:40:00-10:00'),
    leg('lih-hnl', 'LIH', 'HNL', '2027-07-05T08:00:00-10:00', '2027-07-05T08:40:00-10:00'),
    leg('hnl-ito', 'HNL', 'ITO', '2027-07-06T08:00:00-10:00', '2027-07-06T08:55:00-10:00'),
    leg('ito-hnl', 'ITO', 'HNL', '2027-07-07T08:00:00-10:00', '2027-07-07T08:55:00-10:00'),
    leg('hnl-ogg-2', 'HNL', 'OGG', '2027-07-08T07:00:00-10:00', '2027-07-08T07:40:00-10:00'),
    leg('ogg-hnl', 'OGG', 'HNL', '2027-07-09T07:00:00-10:00', '2027-07-09T07:40:00-10:00'),
    leg('hnl-lax', 'HNL', 'LAX', '2027-07-10T13:00:00-10:00', '2027-07-10T21:20:00-07:00'),
    leg('lax-jfk', 'LAX', 'JFK', '2027-07-11T08:00:00-07:00', '2027-07-11T16:30:00-04:00'),
    leg('jfk-lhr', 'JFK', 'LHR', '2027-07-12T18:30:00-04:00', '2027-07-13T06:40:00+01:00'),
  ]),
  'a long stay given room on screen': spec(
    [
      leg('dxb-lhr', 'DXB', 'LHR', '2027-09-01T07:45:00+04:00', '2027-09-01T12:30:00+01:00'),
      leg('lhr-sea', 'LHR', 'SEA', '2027-09-04T13:00:00+01:00', '2027-09-04T15:05:00-07:00'),
    ],
    { presentation: { stopHolds: { 'dxb-lhr': 4 } } },
  ),
  'recent past trip (within two years)': spec([leg('cdg-nrt', 'CDG', 'NRT', '2025-04-02T21:00:00+02:00', '2025-04-03T16:50:00+09:00')]),
};

describe('advisory warnings: real-world corpus stays quiet', () => {
  for (const [name, s] of Object.entries(CORPUS)) {
    it(name, () => expect(codes(s)).toEqual([]));
  }
});

describe('advisory warnings: likely mistakes', () => {
  it('flags an arrival a day late as implausibly slow', () => {
    const s = spec([leg('ord-sfo', 'ORD', 'SFO', '2027-01-05T10:00:00-06:00', '2027-01-06T12:45:00-08:00')]);
    const [w] = sceneWarnings(normalize(s), NOW);
    expect(w).toMatchObject({ code: 'implausible_speed', path: '/legs/0' });
    expect(w!.message).toContain('ORD → SFO');
    expect(w!.hint).toMatch(/arrival date/);
  });

  it('flags an a.m./p.m. slip on a short flight', () => {
    expect(codes(spec([leg('lga-bos', 'LGA', 'BOS', '2027-04-12T08:00:00-04:00', '2027-04-12T21:25:00-04:00')]))).toEqual([
      'implausible_speed /legs/0',
    ]);
  });

  it('flags a flight that would be impossibly fast (wrong airport or time)', () => {
    const [w] = sceneWarnings(normalize(spec([leg('lhr-jfk', 'LHR', 'JFK', '2027-05-03T11:00:00+01:00', '2027-05-03T07:20:00-04:00')])), NOW);
    expect(w).toMatchObject({ code: 'implausible_speed' });
    expect(w!.hint).toMatch(/500–950 km\/h/);
  });

  it('flags block times beyond any scheduled nonstop', () => {
    expect(codes(spec([leg('syd-lhr', 'SYD', 'LHR', '2027-11-01T17:00:00+11:00', '2027-11-02T07:00:00+00:00')]))).toEqual([
      'long_block_time /legs/0/arrival',
    ]);
  });

  it('flags legs too brief to follow on screen', () => {
    const legs = CORPUS['island hopping, twelve legs (HNL and outer islands)']!.legs;
    const legWeights = Object.fromEntries(legs.map((l) => [l.id, 1]));
    const out = codes(spec(legs, { presentation: { durationSeconds: 40, legWeights } }));
    expect(out.filter((c) => c.startsWith('short_screen_time')).length).toBe(12);
  });

  it('flags a stop that races through more than a day per second, but not a deliberate cut', () => {
    const s = clone(CORPUS['multi-day stay given room on screen (LHR–JFK–LHR)']!);
    s.presentation = {}; // the default 1.3 s stop
    const ws = sceneWarnings(normalize(s), NOW);
    expect(ws.map((w) => `${w.code} ${w.path}`)).toEqual(['compressed_connection /presentation/stopHolds/lhr-jfk']);
    expect(ws[0]!.message).toBe('The 5-day stay in JFK passes in 1.3 s, about 96 hours a second, so day and night flash past.');
    expect(ws[0]!.hint).toContain('at least 5.2 s, or to 0');
    s.presentation = { stopHolds: { 'lhr-jfk': 0 } };
    expect(codes(s)).toEqual([]);
  });

  it('flags dates far from today in either direction', () => {
    expect(codes(spec([leg('ord-sfo', 'ORD', 'SFO', '2031-01-05T10:00:00-06:00', '2031-01-05T12:45:00-08:00')]))).toEqual([
      'far_future_or_past /legs/0/departure',
    ]);
    const past = sceneWarnings(normalize(spec([leg('ord-sfo', 'ORD', 'SFO', '2019-01-05T10:00:00-06:00', '2019-01-05T12:45:00-08:00')])), NOW);
    expect(past[0]!.message).toBe('The journey starts on 2019-01-05, more than 2 years ago.');
  });
});

describe('airport labels', () => {
  // Plan 2 proposed a label_crowding warning. Labels follow the offline renderer's layout: only the current leg's
  // two endpoints show, in fixed slots on alternating lanes, and a departed label retires before the leg after next.
  // Two can show at once (a departing label recedes while the next is introduced), but never more, and never a
  // label from another leg. This pins that; if it fails, reconsider the warning.
  it('shows only the current leg’s endpoints, even with legs squeezed to the minimum', () => {
    const squeezed = spec(
      [
        leg('lax-hnl', 'LAX', 'HNL', '2027-07-10T08:00:00-07:00', '2027-07-10T10:50:00-10:00'),
        leg('hnl-ogg', 'HNL', 'OGG', '2027-07-10T12:00:00-10:00', '2027-07-10T12:40:00-10:00'),
        leg('ogg-koa', 'OGG', 'KOA', '2027-07-10T14:00:00-10:00', '2027-07-10T14:40:00-10:00'),
      ],
      { presentation: { durationSeconds: 7.5, stopHolds: { 'lax-hnl': 0, 'hnl-ogg': 0 }, legWeights: { 'lax-hnl': 1, 'hnl-ogg': 1, 'ogg-koa': 1 } } },
    );
    for (const s of [...Object.values(CORPUS), squeezed]) {
      const tl = buildTimeline(normalize(s));
      const seen = new Set<number>();
      for (let f = 0; f <= tl.durationInFrames; f++) {
        const state = evaluate(tl, f / tl.fps);
        for (const l of state.labels) {
          expect([state.legIndex, state.legIndex + 1]).toContain(l.index);
          seen.add(l.index);
        }
      }
      // Every visit is introduced, repeated airports included.
      expect([...seen].sort((a, b) => a - b)).toEqual(tl.occurrences.map((o) => o.index));
    }
  });
});

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

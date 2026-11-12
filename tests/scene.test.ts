import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_SCENE } from '../src/shared/scene/examples';
import { sceneSchemaV1 } from '../src/shared/scene/schema';
import { validateScene } from '../src/shared/scene/validate';
import { clone, issues, leg, normalize, opts, spec, synthetic, syntheticLookup } from './helpers';

const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemaValidate = ajv.compile(sceneSchemaV1);

describe('normalization', () => {
  it('normalizes the synthetic example', () => {
    const n = normalize(EXAMPLE_SCENE);
    expect(n.legs.map((l) => [l.departureUtc, l.arrivalUtc])).toEqual([
      ['2031-01-05T16:00:00Z', '2031-01-05T20:45:00Z'],
      ['2031-01-06T05:30:00Z', '2031-01-06T18:15:00Z'],
    ]);
    expect(Object.keys(n.airports)).toEqual(['AKL', 'ORD', 'SFO']);
    expect(n.airports.ORD!.timeZone).toBe('America/Chicago');
    expect(n.presentation.durationSeconds).toBeCloseTo(20, 5);
    const sum =
      n.presentation.startHoldSeconds +
      n.presentation.endHoldSeconds +
      n.legs.reduce((s, l) => s + l.flightSeconds + l.holdAfterSeconds, 0);
    expect(sum).toBeCloseTo(n.presentation.durationSeconds, 5);
    expect(n.legs[0]!.holdAfterSeconds).toBe(2);
    expect(n.legs[1]!.holdAfterSeconds).toBe(0);
    // Longer leg gets more time by default (sqrt-distance weighting).
    expect(n.legs[1]!.flightSeconds).toBeGreaterThan(n.legs[0]!.flightSeconds);
    expect(n.compatibility.rendererVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(n.seed).toBe(1);
    expect(n.title).toBe('Chicago to Auckland (synthetic example)');
  });

  it('is deterministic and independent of key order', () => {
    const a = normalize(EXAMPLE_SCENE);
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverseKeys)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]))
          : v;
    const reordered = reverseKeys(EXAMPLE_SCENE);
    expect(Object.keys(reordered as object)[0]).toBe('presentation');
    expect(normalize(reordered)).toEqual(a);
  });

  it('applies explicit leg weights and defaults', () => {
    const s = clone(EXAMPLE_SCENE);
    s.presentation = { durationSeconds: 30, legWeights: { 'ord-sfo': 3, 'sfo-akl': 1 }, stopHolds: { 'ord-sfo': 0 } };
    const n = normalize(s);
    expect(n.legs[0]!.flightSeconds / n.legs[1]!.flightSeconds).toBeCloseTo(3, 5);
    expect(n.legs[0]!.holdAfterSeconds).toBe(0);
  });

  it('computes a default duration when omitted', () => {
    const n = normalize(spec([leg('a', 'ORD', 'SFO', '2031-01-05T10:00:00-06:00', '2031-01-05T12:45:00-08:00')]));
    // The offline renderer's defaults: 1.6 s start hold, 2.7 s end hold, 6 s per flight.
    expect(n.presentation.durationSeconds).toBe(1.6 + 2.7 + 6);
  });

  it('caps the default duration at the maximum', () => {
    const legs = [];
    const codes = ['LHR', 'CDG', 'LHR', 'CDG', 'LHR', 'CDG', 'LHR', 'CDG', 'LHR', 'CDG', 'LHR', 'CDG', 'LHR'];
    for (let i = 0; i < 12; i++) {
      const day = String(i + 1).padStart(2, '0');
      const off = codes[i] === 'LHR' ? '+00:00' : '+01:00';
      const offTo = codes[i + 1] === 'LHR' ? '+00:00' : '+01:00';
      const depH = codes[i] === 'LHR' ? '08' : '09';
      const arrH = codes[i + 1] === 'LHR' ? '09' : '10';
      legs.push(leg(`l${i}`, codes[i]!, codes[i + 1]!, `2031-01-${day}T${depH}:00:00${off}`, `2031-01-${day}T${arrH}:15:00${offTo}`));
    }
    const n = normalize(spec(legs, { presentation: { stopHolds: Object.fromEntries(legs.slice(0, 11).map((l) => [l.id, 6])) } }));
    expect(n.presentation.durationSeconds).toBeLessThanOrEqual(120);
  });
});

describe('time zones', () => {
  const ordSfo = (dep: string, arr: string) => spec([leg('a', 'ORD', 'SFO', dep, arr)]);

  it('requires an explicit offset', () => {
    const [i] = issues(ordSfo('2031-01-05T10:00:00', '2031-01-05T12:45:00-08:00'));
    expect(i).toMatchObject({ path: '/legs/0/departure', code: 'timestamp_format' });
  });

  it('rejects impossible calendar dates', () => {
    const [i] = issues(ordSfo('2031-02-30T10:00:00-06:00', '2031-02-30T12:45:00-08:00'));
    expect(i).toMatchObject({ code: 'invalid_date' });
  });

  it('rejects a standard-time offset during daylight saving and suggests the right one', () => {
    const list = issues(ordSfo('2031-07-05T10:00:00-06:00', '2031-07-05T12:45:00-07:00'));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ path: '/legs/0/departure', code: 'offset_mismatch' });
    expect(list[0]!.hint).toContain('2031-07-05T10:00:00-05:00');
  });

  it('accepts correct daylight-saving offsets', () => {
    const n = normalize(ordSfo('2031-07-05T10:00:00-05:00', '2031-07-05T12:45:00-07:00'));
    expect(n.legs[0]!.departureUtc).toBe('2031-07-05T15:00:00Z');
    expect(n.legs[0]!.arrivalUtc).toBe('2031-07-05T19:45:00Z');
  });

  it('explains a nonexistent spring-forward local time', () => {
    // US DST begins 2031-03-09 at 02:00 local; 02:30 does not exist in Chicago.
    const list = issues(ordSfo('2031-03-09T02:30:00-06:00', '2031-03-09T06:00:00-07:00'));
    expect(list[0]).toMatchObject({ code: 'offset_mismatch' });
    expect(list[0]!.hint).toMatch(/does not exist/);
  });

  it('accepts either offset for a repeated fall-back hour and keeps them distinct', () => {
    // US DST ends 2031-11-02 at 02:00 local; 01:30 occurs twice in Chicago.
    const early = normalize(ordSfo('2031-11-02T01:30:00-05:00', '2031-11-02T05:00:00-08:00'));
    const late = normalize(ordSfo('2031-11-02T01:30:00-06:00', '2031-11-02T05:00:00-08:00'));
    expect(early.legs[0]!.departureUtc).toBe('2031-11-02T06:30:00Z');
    expect(late.legs[0]!.departureUtc).toBe('2031-11-02T07:30:00Z');
    const list = issues(ordSfo('2031-11-02T01:30:00-04:00', '2031-11-02T05:00:00-08:00'));
    expect(list[0]!.hint).toMatch(/occurs twice/);
  });

  it('accepts Z only where the local offset is zero', () => {
    normalize(spec([leg('a', 'LHR', 'CDG', '2031-01-05T08:00:00Z', '2031-01-05T10:15:00+01:00')]));
    const list = issues(ordSfo('2031-01-05T16:00:00Z', '2031-01-05T12:45:00-08:00'));
    expect(list[0]).toMatchObject({ code: 'offset_mismatch', path: '/legs/0/departure' });
  });

  it('handles the date line: SFO to AKL arrives two calendar days later', () => {
    const n = normalize(spec([leg('a', 'SFO', 'AKL', '2031-01-05T21:30:00-08:00', '2031-01-07T07:15:00+13:00')]));
    expect(n.legs[0]!.arrivalUtc).toBe('2031-01-06T18:15:00Z');
    // A same-calendar-day arrival is before departure in UTC; the hint mentions the date line.
    const list = issues(spec([leg('a', 'SFO', 'AKL', '2031-01-05T21:30:00-08:00', '2031-01-05T07:15:00+13:00')]));
    expect(list[0]).toMatchObject({ code: 'arrival_not_after_departure' });
    expect(list[0]!.hint).toMatch(/date line/);
  });

  it('handles westbound date-line crossing: AKL to SFO arrives the previous calendar day', () => {
    const n = normalize(spec([leg('a', 'AKL', 'SFO', '2031-01-07T19:00:00+13:00', '2031-01-07T10:30:00-08:00')]));
    expect(n.legs[0]!.departureUtc).toBe('2031-01-07T06:00:00Z');
    expect(n.legs[0]!.arrivalUtc).toBe('2031-01-07T18:30:00Z');
  });
});

describe('structure and bounds', () => {
  it('rejects unknown fields with allowed names', () => {
    const s = { ...clone(EXAMPLE_SCENE), cameraPath: [] };
    const [i] = issues(s);
    expect(i).toMatchObject({ path: '/cameraPath', code: 'unknown_field' });
    expect(i!.hint).toContain('legs');
  });

  it('rejects unsupported schema versions', () => {
    expect(issues({ ...clone(EXAMPLE_SCENE), schemaVersion: 2 })[0]).toMatchObject({ code: 'unsupported_version' });
    expect(issues({ legs: [] })[0]).toMatchObject({ code: 'required', path: '/schemaVersion' });
  });

  it('enforces leg count and text limits', () => {
    expect(issues(spec([]))[0]).toMatchObject({ code: 'too_few' });
    const many = Array.from({ length: 13 }, (_, i) => leg(`l${i}`, 'ORD', 'SFO', '2031-01-05T10:00:00-06:00', '2031-01-05T12:45:00-08:00'));
    expect(issues(spec(many))[0]).toMatchObject({ code: 'too_many', path: '/legs' });
    expect(issues({ ...clone(EXAMPLE_SCENE), title: 'x'.repeat(81) })[0]).toMatchObject({ code: 'too_long' });
    expect(issues({ ...clone(EXAMPLE_SCENE), title: 'a\nb' })[0]).toMatchObject({ code: 'pattern' });
  });

  it('rejects non-finite and out-of-range numbers', () => {
    const s = clone(EXAMPLE_SCENE) as any;
    s.presentation.durationSeconds = Infinity;
    expect(issues(s)[0]).toMatchObject({ code: 'not_finite', path: '/presentation/durationSeconds' });
    s.presentation.durationSeconds = 500;
    expect(issues(s)[0]).toMatchObject({ code: 'out_of_range' });
    s.presentation.durationSeconds = 20;
    s.seed = 1.5;
    expect(issues(s)[0]).toMatchObject({ code: 'not_integer', path: '/seed' });
  });

  it('rejects unsupported presets', () => {
    const s = clone(EXAMPLE_SCENE) as any;
    s.presentation.camera = 'drone';
    s.assets = { aircraft: 'B744' };
    s.environment = { weather: 'historical' };
    const codes = issues(s).map((i) => [i.path, i.code]);
    expect(codes).toEqual([
      // There is one camera, and aircraft are chosen per leg: these fields no longer exist.
      ['/presentation/camera', 'unknown_field'],
      ['/environment/weather', 'unsupported_preset'],
      ['/assets/aircraft', 'unknown_field'],
    ]);
  });

  it('requires a supported ICAO aircraft type on every leg, with a hint toward the fix', () => {
    const s = clone(EXAMPLE_SCENE) as any;
    delete s.legs[0].aircraft;
    s.legs[1].aircraft = 'MD11';
    const found = issues(s);
    expect(found.map((i) => [i.path, i.code])).toEqual([
      ['/legs/0/aircraft', 'required'],
      ['/legs/1/aircraft', 'unsupported_aircraft'],
    ]);
    expect(found[1]!.hint).toMatch(/closest listed type/);
    s.legs[0].aircraft = 'b38m';
    s.legs[1].aircraft = '789';
    const hints = issues(s).map((i) => i.hint);
    expect(hints[0]).toMatch(/"B38M" \(Boeing 737 MAX 8\)/);
    expect(hints[1]).toMatch(/IATA aircraft code/);
  });

  it('carries each leg\'s aircraft into the normalized record', () => {
    const n = normalize(EXAMPLE_SCENE);
    expect(n.legs.map((l) => l.aircraft)).toEqual(['B739', 'B789']);
  });

  it('gives an ICAO-specific hint', () => {
    const [i] = issues(spec([leg('a', 'KORD', 'SFO', '2031-01-05T10:00:00-06:00', '2031-01-05T12:45:00-08:00')]));
    expect(i).toMatchObject({ code: 'pattern', path: '/legs/0/from' });
    expect(i!.hint).toMatch(/IATA/);
  });

  it('reports unknown airports and city codes', () => {
    const [i] = issues(spec([leg('a', 'CHI', 'SFO', '2031-01-05T10:00:00-06:00', '2031-01-05T12:45:00-08:00')]));
    expect(i).toMatchObject({ code: 'unknown_airport', path: '/legs/0/from' });
  });
});

describe('journey consistency', () => {
  it('rejects duplicate leg ids', () => {
    const s = clone(EXAMPLE_SCENE);
    s.legs[1]!.id = 'ord-sfo';
    s.presentation = {};
    expect(issues(s).map((i) => i.code)).toContain('duplicate_leg_id');
  });

  it('rejects disconnected legs', () => {
    const s = clone(EXAMPLE_SCENE);
    s.legs[1]!.from = 'LAX';
    s.legs[1]!.departure = '2031-01-05T21:30:00-08:00';
    const list = issues(s);
    expect(list[0]).toMatchObject({ code: 'disconnected_legs', path: '/legs/1/from' });
  });

  it('rejects overlapping legs', () => {
    const s = clone(EXAMPLE_SCENE);
    s.legs[1]!.departure = '2031-01-05T12:00:00-08:00';
    expect(issues(s)[0]).toMatchObject({ code: 'overlapping_legs', path: '/legs/1/departure' });
  });

  it('allows a zero-minute connection', () => {
    const s = clone(EXAMPLE_SCENE);
    s.legs[1]!.departure = '2031-01-05T12:45:00-08:00';
    s.legs[1]!.arrival = '2031-01-06T22:30:00+13:00';
    normalize(s);
  });

  it('rejects implausible flight durations', () => {
    const list = issues(spec([leg('a', 'ORD', 'SFO', '2031-01-05T10:00:00-06:00', '2031-01-07T12:45:00-08:00')]));
    expect(list[0]).toMatchObject({ code: 'flight_duration' });
  });

  it('rejects same-airport legs', () => {
    expect(issues(spec([leg('a', 'ORD', 'ORD', '2031-01-05T10:00:00-06:00', '2031-01-05T12:45:00-06:00')]))[0]).toMatchObject({
      code: 'same_airport',
    });
  });

  it('rejects antipodal endpoints', () => {
    const lookup = syntheticLookup([synthetic('AAA', 10, 20), synthetic('BBB', -10, -160)]);
    const list = issues(spec([leg('a', 'AAA', 'BBB', '2031-01-05T10:00:00Z', '2031-01-05T22:00:00Z')]), lookup);
    expect(list[0]).toMatchObject({ code: 'antipodal_route' });
  });

  it('checks leg references in presentation maps', () => {
    const s = clone(EXAMPLE_SCENE);
    s.presentation = { legWeights: { nope: 2 }, stopHolds: { 'sfo-akl': 1 } };
    const list = issues(s);
    expect(list.map((i) => i.code)).toEqual(['unknown_leg_reference', 'hold_on_final_leg']);
  });

  it('enforces the duration budget with a concrete repair hint', () => {
    const s = clone(EXAMPLE_SCENE);
    s.presentation = { durationSeconds: 6, startHoldSeconds: 2, endHoldSeconds: 2, stopHolds: { 'ord-sfo': 1.5 } };
    const [i] = issues(s);
    expect(i).toMatchObject({ code: 'duration_budget', path: '/presentation/durationSeconds' });
    expect(i!.hint).toMatch(/at least \d+/);
    const needed = Number(/at least (\d+)/.exec(i!.hint!)![1]);
    s.presentation.durationSeconds = needed;
    normalize(s);
  });

  it('allows repeated airports', () => {
    const n = normalize(
      spec([
        leg('out', 'ORD', 'SFO', '2031-01-05T10:00:00-06:00', '2031-01-05T12:45:00-08:00'),
        leg('back', 'SFO', 'ORD', '2031-01-09T08:00:00-08:00', '2031-01-09T14:10:00-06:00'),
      ]),
    );
    expect(n.legs).toHaveLength(2);
    expect(Object.keys(n.airports)).toEqual(['ORD', 'SFO']);
  });
});

describe('published JSON Schema agrees with the validator on structure', () => {
  const valid = [EXAMPLE_SCENE, { schemaVersion: 1, legs: [leg('a', 'ORD', 'SFO', '2031-01-05T10:00:00-06:00', '2031-01-05T12:45:00-08:00')] }];
  const structurallyInvalid: unknown[] = [
    { ...clone(EXAMPLE_SCENE), extra: true },
    { ...clone(EXAMPLE_SCENE), schemaVersion: 2 },
    { schemaVersion: 1, legs: [] },
    { schemaVersion: 1, legs: [{ id: 'A', from: 'ORD', to: 'SFO', departure: '2031-01-05T10:00:00-06:00', arrival: '2031-01-05T12:45:00-08:00' }] },
    { schemaVersion: 1, legs: [leg('a', 'ord', 'SFO', '2031-01-05T10:00:00-06:00', '2031-01-05T12:45:00-08:00')] },
    { schemaVersion: 1, legs: [leg('a', 'ORD', 'SFO', '2031-01-05 10:00', '2031-01-05T12:45:00-08:00')] },
    { schemaVersion: 1, legs: [leg('a', 'ORD', 'SFO', '2031-01-05T10:00:00-06:00', '2031-01-05T12:45:00-08:00', 'b738')] },
    { ...clone(EXAMPLE_SCENE), presentation: { camera: 'drone' } },
    { ...clone(EXAMPLE_SCENE), presentation: { durationSeconds: 1 } },
    { ...clone(EXAMPLE_SCENE), presentation: { legWeights: { 'ord-sfo': 0 } } },
    { ...clone(EXAMPLE_SCENE), seed: -1 },
    { ...clone(EXAMPLE_SCENE), title: '' },
  ];

  it('accepts valid specs', () => {
    for (const s of valid) {
      expect(schemaValidate(s)).toBe(true);
      expect(validateScene(s, opts).ok).toBe(true);
    }
  });

  it('rejects structurally invalid specs in both', () => {
    for (const s of structurallyInvalid) {
      expect(schemaValidate(s), JSON.stringify(s)).toBe(false);
      expect(validateScene(s, opts).ok, JSON.stringify(s)).toBe(false);
    }
  });
});

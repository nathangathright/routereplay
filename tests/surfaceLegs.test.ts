import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { storyboardSvg } from '../src/server/storyboardSvg';
import { compatibility } from '../src/shared/scene/compat';
import { DEFAULTS } from '../src/shared/scene/constants';
import { sceneSchemaV1 } from '../src/shared/scene/schema';
import { validateScene } from '../src/shared/scene/validate';
import { sceneWarnings } from '../src/shared/scene/warnings';
import { buildTimeline, evaluate } from '../src/shared/timeline/evaluate';
import { buildStoryboard, keyframeAt } from '../src/shared/timeline/storyboard';
import { clone, issues, leg, normalize, opts, spec, surface } from './helpers';

const schemaValidate = new Ajv2020({ allErrors: true, strict: false }).compile(sceneSchemaV1);

/**
 * Synthetic round trip to New Zealand with a week on the ground between the flights: a train, a ferry across
 * Cook Strait, and a two-day bus split at its overnight stop. Stations and terminals are stood for by their
 * nearest airports. Times are modelled on published schedules, not a real booking.
 */
const NZ = spec(
  [
    leg('ord-sfo', 'ORD', 'SFO', '2031-10-17T08:00:00-05:00', '2031-10-17T10:35:00-07:00', 'B39M'),
    leg('sfo-akl', 'SFO', 'AKL', '2031-10-17T23:00:00-07:00', '2031-10-19T07:15:00+13:00', 'B789'),
    surface('akl-wlg', 'AKL', 'WLG', '2031-10-20T07:45:00+13:00', '2031-10-20T18:25:00+13:00', 'train'),
    surface('wlg-pcn', 'WLG', 'PCN', '2031-10-22T08:45:00+13:00', '2031-10-22T12:15:00+13:00', 'ferry'),
    surface('pcn-chc', 'PCN', 'CHC', '2031-10-22T13:30:00+13:00', '2031-10-22T19:30:00+13:00', 'bus'),
    surface('chc-zqn', 'CHC', 'ZQN', '2031-10-23T07:30:00+13:00', '2031-10-23T16:30:00+13:00', 'bus'),
    leg('zqn-mel', 'ZQN', 'MEL', '2031-10-30T10:00:00+13:00', '2031-10-30T11:40:00+11:00', 'A320'),
    leg('mel-sfo', 'MEL', 'SFO', '2031-11-06T10:00:00+11:00', '2031-11-06T06:30:00-08:00', 'B789'),
    leg('sfo-ord', 'SFO', 'ORD', '2031-11-06T09:30:00-08:00', '2031-11-06T15:45:00-06:00', 'B39M'),
  ],
  // Week-long stays cut straight to the next departure.
  { title: 'Chicago to New Zealand (synthetic)', presentation: { stopHolds: { 'chc-zqn': 0, 'zqn-mel': 0 } } },
);
const SURFACE_IDS = ['akl-wlg', 'wlg-pcn', 'pcn-chc', 'chc-zqn'];
const NOW = Date.parse('2031-09-01T00:00:00Z');

describe('surface legs: validation', () => {
  it('joins flights and ground travel into one journey', () => {
    expect(schemaValidate(NZ), JSON.stringify(schemaValidate.errors)).toBe(true);
    const n = normalize(NZ);
    expect(n.legs.filter((l) => l.mode).map((l) => [l.id, l.mode])).toEqual([
      ['akl-wlg', 'train'],
      ['wlg-pcn', 'ferry'],
      ['pcn-chc', 'bus'],
      ['chc-zqn', 'bus'],
    ]);
    for (const l of n.legs) expect('aircraft' in l).toBe(!SURFACE_IDS.includes(l.id));
    expect(n.airports.PCN!.timeZone).toBe('Pacific/Auckland');
  });

  it('keeps the ferry on screen: surface legs get at least the minimum default weight', () => {
    const n = normalize(NZ);
    const ferry = n.legs.find((l) => l.id === 'wlg-pcn')!;
    expect(ferry.distanceKm).toBeLessThan(100);
    expect(ferry.weight).toBe(DEFAULTS.minSurfaceWeight);
    expect(ferry.flightSeconds).toBeGreaterThan(2);
    // Flights keep the distance-based default, and an explicit weight still wins on a surface leg.
    expect(n.legs.find((l) => l.id === 'mel-sfo')!.weight).toBeGreaterThan(2);
    const s = clone(NZ);
    s.presentation!.legWeights = { 'wlg-pcn': 0.2 };
    expect(normalize(s).legs.find((l) => l.id === 'wlg-pcn')!.weight).toBe(0.2);
  });

  it('raises no speed or duration warnings for ordinary ground travel', () => {
    const codes = sceneWarnings(normalize(NZ), NOW).map((w) => `${w.code} ${w.path}`);
    // Only the 38 hours in Wellington, at the default stop hold, flash past.
    expect(codes).toEqual(['compressed_connection /presentation/stopHolds/akl-wlg']);
  });

  it('allows multi-day surface legs, up to a week', () => {
    const twoDays = spec([surface('bus', 'PCN', 'ZQN', '2031-10-22T13:30:00+13:00', '2031-10-24T16:30:00+13:00', 'bus')]);
    expect(validateScene(twoDays, opts).ok).toBe(true);
    const tooLong = spec([surface('bus', 'PCN', 'ZQN', '2031-10-22T13:30:00+13:00', '2031-10-30T16:30:00+13:00', 'bus')]);
    const [i] = issues(tooLong);
    expect(i).toMatchObject({ code: 'flight_duration', path: '/legs/0/arrival' });
    expect(i!.message).toMatch(/a bus leg may take 10 minutes to 7 days/);
    // The same two days as a flight is still rejected.
    const flown = spec([leg('f', 'PCN', 'ZQN', '2031-10-22T13:30:00+13:00', '2031-10-24T16:30:00+13:00')]);
    expect(issues(flown)[0]).toMatchObject({ code: 'flight_duration' });
  });

  it('requires exactly one of aircraft and mode', () => {
    const both = clone(NZ) as any;
    both.legs[2].aircraft = 'A320';
    expect(schemaValidate(both)).toBe(false);
    expect(issues(both).map((i) => [i.path, i.code])).toEqual([['/legs/2/mode', 'conflicting_fields']]);

    const neither = clone(NZ) as any;
    delete neither.legs[2].mode;
    expect(schemaValidate(neither)).toBe(false);
    const [missing] = issues(neither);
    expect(missing).toMatchObject({ path: '/legs/2/aircraft', code: 'required' });
    expect(missing!.hint).toMatch(/mode instead/);
  });

  it('accepts only the listed modes, with a hint toward the fix', () => {
    const hintFor = (mode: string) => {
      const s = clone(NZ) as any;
      s.legs[2].mode = mode;
      expect(schemaValidate(s)).toBe(false);
      const [i] = issues(s);
      expect(i).toMatchObject({ path: '/legs/2/mode', code: 'unsupported_mode' });
      return i!.hint;
    };
    expect(hintFor('Train')).toBe('Use lowercase: "train".');
    expect(hintFor('flight')).toMatch(/Flights take aircraft/);
    expect(hintFor('boat')).toMatch(/a boat is "ferry"/);
  });

  it('points a gap between flights toward a surface leg', () => {
    const gap = spec([
      leg('sfo-akl', 'SFO', 'AKL', '2031-10-17T23:00:00-07:00', '2031-10-19T07:15:00+13:00', 'B789'),
      leg('zqn-mel', 'ZQN', 'MEL', '2031-10-30T10:00:00+13:00', '2031-10-30T11:40:00+11:00'),
    ]);
    const [i] = issues(gap);
    expect(i).toMatchObject({ code: 'disconnected_legs', path: '/legs/1/from' });
    expect(i!.hint).toMatch(/train, bus, car, or ferry leg .* between AKL and ZQN/);
  });

  it('flags speeds no train, bus, car, or ferry averages', () => {
    const fast = spec([surface('t', 'AKL', 'WLG', '2031-10-20T07:45:00+13:00', '2031-10-20T08:30:00+13:00', 'train')]);
    const [w] = sceneWarnings(normalize(fast), NOW);
    expect(w).toMatchObject({ code: 'implausible_speed', path: '/legs/0' });
    expect(w!.message).toMatch(/^The train from AKL → WLG covers/);
    expect(w!.hint).toMatch(/whether this leg was a flight/);
    // A three-hour ferry entered a day late averages under walking pace.
    const late = spec([surface('f', 'WLG', 'PCN', '2031-10-22T08:45:00+13:00', '2031-10-23T12:15:00+13:00', 'ferry')]);
    expect(sceneWarnings(normalize(late), NOW).map((x) => x.code)).toEqual(['implausible_speed']);
  });

  it('still plays on this renderer major', () => {
    expect(compatibility(normalize(NZ))).toEqual({ ok: true });
  });
});

describe('surface legs: timeline', () => {
  const tl = buildTimeline(normalize(NZ));
  const legIndex = (id: string) => tl.legs.findIndex((l) => l.id === id);
  const motion = (id: string) => tl.segments.find((s) => s.leg === legIndex(id) && (s.kind === 'flight' || s.kind === 'surface'))!;
  const stopAfter = (id: string) => tl.segments.find((s) => s.leg === legIndex(id) && s.kind === 'stop')!;
  const at = (seg: { t0: number; t1: number }, u: number) => evaluate(tl, seg.t0 + u * (seg.t1 - seg.t0));

  it('travels surface legs in their own phase, along the ground', () => {
    expect(SURFACE_IDS.map((id) => motion(id).kind)).toEqual(['surface', 'surface', 'surface', 'surface']);
    expect(motion('sfo-akl').kind).toBe('flight');
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const s = at(motion('akl-wlg'), u);
      expect(s.aircraft.altitude).toBe(0);
    }
    expect(at(motion('sfo-akl'), 0.5).aircraft.altitude).toBeGreaterThan(0);
    // The trail reveals as the train moves, as a flight's does.
    const mid = at(motion('akl-wlg'), 0.5);
    expect(mid.phase).toBe('surface');
    expect(mid.trail[legIndex('akl-wlg')]).toBeCloseTo(0.5, 6);
    expect(mid.trail[legIndex('sfo-akl')]).toBe(1);
    expect(mid.trail[legIndex('wlg-pcn')]).toBe(0);
  });

  it('draws each mode as its own vehicle, dissolving only where the craft changes', () => {
    const mix = (seg: { t0: number; t1: number }, u: number) => at(seg, u).aircraft.mix;
    expect(SURFACE_IDS.map((id) => mix(motion(id), 0.5))).toEqual([
      [{ type: 'train', weight: 1 }],
      [{ type: 'ferry', weight: 1 }],
      [{ type: 'bus', weight: 1 }],
      [{ type: 'bus', weight: 1 }],
    ]);
    // Landing in Auckland: the 787 gives way to the train through the middle of the stop.
    const landing = mix(stopAfter('sfo-akl'), 0.5);
    expect(landing.map((m) => m.type)).toEqual(['B789', 'train']);
    expect(landing[0]!.weight + landing[1]!.weight).toBe(1);
    // Train to ferry in Wellington dissolves the same way.
    expect(mix(stopAfter('akl-wlg'), 0.5).map((m) => m.type)).toEqual(['train', 'ferry']);
    expect(mix(stopAfter('akl-wlg'), 0.2)).toEqual([{ type: 'train', weight: 1 }]);
    expect(mix(stopAfter('akl-wlg'), 0.8)).toEqual([{ type: 'ferry', weight: 1 }]);
    // The overnight stop in Christchurch is the same bus waiting: nothing dissolves.
    expect(mix(stopAfter('pcn-chc'), 0.5)).toEqual([{ type: 'bus', weight: 1 }]);
  });

  it('keeps the camera close over short ground legs', () => {
    const height = (id: string) => tl.legs[legIndex(id)]!.height;
    expect(height('wlg-pcn')).toBeLessThan(0.01);
    expect(height('mel-sfo')).toBe(1);
  });
});

describe('surface legs: storyboards', () => {
  const scene = normalize(NZ);
  const tl = buildTimeline(scene);

  it('names the mode in keyframes and screen time', () => {
    const i = scene.legs.findIndex((l) => l.id === 'wlg-pcn');
    const seg = tl.segments.find((s) => s.leg === i && s.kind === 'surface')!;
    const k = keyframeAt(tl, (seg.t0 + seg.t1) / 2);
    expect(k).toMatchObject({ phase: 'surface', legId: 'wlg-pcn', summary: 'By ferry WLG → PCN, 50% of the way' });
    expect(Object.keys(k.local)).toEqual(['WLG', 'PCN']);
    const legs = buildStoryboard(scene).onScreenSeconds.legs;
    expect(legs).toHaveLength(9);
    expect(legs.filter((l) => l.mode).map((l) => `${l.id}:${l.mode}`)).toEqual([
      'akl-wlg:train',
      'wlg-pcn:ferry',
      'pcn-chc:bus',
      'chc-zqn:bus',
    ]);
    expect(legs.find((l) => l.id === 'sfo-akl')).not.toHaveProperty('mode');
  });

  it('sketches surface legs dotted', () => {
    const svg = storyboardSvg(scene, buildStoryboard(scene), 0);
    expect(svg.match(/<polyline [^>]*stroke-dasharray/g)).toHaveLength(4);
    // Each leg is a line over its glow.
    expect(svg.match(/<polyline /g)).toHaveLength(18);
    expect(svg).toContain('· dotted: train, bus, car, or ferry · ringed dots: stations</text>');
  });
});

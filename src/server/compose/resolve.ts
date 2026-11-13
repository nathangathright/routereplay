/**
 * Turns the model's intent into a scene spec without the model: airports from the airport table, UTC offsets from
 * each airport's zone, arrival dates from the only date that fits, aircraft designators from the supported list.
 * What the text doesn't settle becomes one question per leg; no time, date or airport is invented. A flight whose
 * aircraft the text doesn't name gets a typical one for its distance, marked as assumed.
 */
import { distanceKm } from '../../shared/geo/greatCircle';
import { type AircraftType, isAircraftType } from '../../shared/scene/aircraft';
import { LIMITS } from '../../shared/scene/constants';
import { formatOffset, resolveWallTime, type WallTime } from '../../shared/scene/time';
import type { Airport, AirportLookup, LegSpec, SceneSpecV1, ValidationIssue } from '../../shared/scene/types';
import { validateScene } from '../../shared/scene/validate';
import { type SceneWarning, sceneWarnings } from '../../shared/scene/warnings';
import { matchAircraft, writtenIn } from './aircraft';
import type { Intent, IntentLeg, LegMode } from './intent';
import { dayLabel, showsCode } from '../../shared/scene/summary';

/** What one leg (or the whole trip) still needs. */
export interface Question {
  /** Index of the leg in `spec.legs`; absent for the whole trip. */
  leg?: number;
  /** The leg as the person wrote it: "AA 100, JFK → LHR, Sat 12 Jun 2027". */
  about?: string;
  /** What's missing, in a few words each: "date", "local departure and arrival times", "which London airport". */
  needs: string[];
  /** Needs answered by picking one option, such as an airport: `need` is the index in `needs`. */
  choices?: { need: number; options: string[] }[];
  /** One line for the person, which the conversation sends back: `about`, a colon, and the needs with their options. */
  question: string;
  /** What an answer fills: "<leg>.from", "<leg>.to", "<leg>.departure" (its date or time), "<leg>.arrival", "year" or "legs". */
  fields: string[];
  /** Part of the answer can be looked up (schedules, timetables, where a place is); dates only the traveller knows. */
  lookup: boolean;
}

export interface ComposeResult {
  /** The spec is complete and valid: POST it to /api/v1/scenes as it is. */
  complete: boolean;
  /** Complete, or the fields that are known so far. */
  spec: { schemaVersion: 1; title?: string; legs: Partial<LegSpec>[] };
  questions: Question[];
  /** Validation issues of a spec that had no open questions but still failed (usually a misread time or date). */
  issues: ValidationIssue[];
  warnings: SceneWarning[];
  /** Names of the airports used, so a person can check them. */
  airports: Record<string, string>;
  /** Each spec leg's places as the person wrote them. */
  places: { from: string; to: string }[];
  /** Values the text didn't give: "<leg>.aircraft" for a typical aircraft. */
  assumed: string[];
}

export interface ResolveOptions {
  lookupAirport: AirportLookup;
  searchAirports: (word: string) => Airport[];
  airportDataVersion: string;
  now: number;
}

/**
 * Cities with several major airports, busiest first. A flight from one, unnamed, is a question with these as options;
 * a train, bus, car or ferry leg uses `centre`, the airport closest to the city centre, to mark the city.
 */
const METROS: { code: string; names: string[]; airports: string[]; centre: string }[] = [
  { code: 'LON', names: ['london'], airports: ['LHR', 'LGW', 'STN', 'LTN', 'LCY', 'SEN'], centre: 'LCY' },
  { code: 'NYC', names: ['new york', 'nyc'], airports: ['JFK', 'EWR', 'LGA'], centre: 'LGA' },
  { code: 'PAR', names: ['paris'], airports: ['CDG', 'ORY', 'BVA'], centre: 'ORY' },
  { code: 'TYO', names: ['tokyo'], airports: ['HND', 'NRT'], centre: 'HND' },
  { code: 'CHI', names: ['chicago'], airports: ['ORD', 'MDW'], centre: 'MDW' },
  { code: 'WAS', names: ['washington'], airports: ['IAD', 'DCA', 'BWI'], centre: 'DCA' },
  { code: 'MIL', names: ['milan', 'milano'], airports: ['MXP', 'LIN', 'BGY'], centre: 'LIN' },
  { code: 'ROM', names: ['rome', 'roma'], airports: ['FCO', 'CIA'], centre: 'CIA' },
  { code: 'OSA', names: ['osaka'], airports: ['KIX', 'ITM', 'UKB'], centre: 'ITM' },
  { code: 'SEL', names: ['seoul'], airports: ['ICN', 'GMP'], centre: 'GMP' },
  { code: 'BJS', names: ['beijing'], airports: ['PEK', 'PKX'], centre: 'PEK' },
  { code: 'MOW', names: ['moscow'], airports: ['SVO', 'DME', 'VKO'], centre: 'VKO' },
  { code: 'STO', names: ['stockholm'], airports: ['ARN', 'BMA'], centre: 'BMA' },
  { code: 'BUE', names: ['buenos aires'], airports: ['EZE', 'AEP'], centre: 'AEP' },
  { code: 'SAO', names: ['sao paulo'], airports: ['GRU', 'CGH', 'VCP'], centre: 'CGH' },
  { code: 'RIO', names: ['rio de janeiro', 'rio'], airports: ['GIG', 'SDU'], centre: 'SDU' },
  { code: 'YTO', names: ['toronto'], airports: ['YYZ', 'YTZ'], centre: 'YTZ' },
  { code: 'JKT', names: ['jakarta'], airports: ['CGK', 'HLP'], centre: 'HLP' },
];
/** Words that don't single out an airport: "London, UK", "Tokyo city", "Paris airport". */
const GENERIC = new Set(['the', 'city', 'centre', 'center', 'downtown', 'area', 'airport', 'airports', 'intl', 'international', 'uk', 'england', 'usa', 'us', 'ny', 'japan', 'france', 'italy', 'korea', 'china', 'russia', 'sweden', 'argentina', 'brazil', 'canada', 'indonesia', 'dc', 'il', 'on']);
/**
 * Words that begin many place names but never name one alone: "South Coast" must not become whichever airport has
 * "South" in its name, nor "New Forest" any airport called New-something.
 */
const WEAK = new Set(['north', 'south', 'east', 'west', 'northern', 'southern', 'eastern', 'western', 'central', 'new', 'old', 'great', 'little', 'upper', 'lower', 'san', 'santa', 'santo', 'saint', 'st', 'port', 'puerto', 'porto', 'mount', 'mt', 'lake', 'fort', 'cape', 'el', 'la', 'le', 'los', 'las', 'de', 'del']);
/** A train, bus, car or ferry leg's endpoints stand for stations; within this distance they join the adjacent leg's airport. */
const STAND_IN_KM = 100;
/** Airports this close together are one city's, so any of them can stand for its station. */
const SAME_CITY_KM = 80;
/**
 * Longer than this (great-circle, between the stand-in airports), a leg on the ground or water has a misplaced end.
 * Moscow to Vladivostok by train is about 6,400 km; long ferry routes stay well under 2,500.
 */
const GROUND_MAX_KM: Record<Exclude<LegMode, 'flight'>, number> = { train: 7500, bus: 5000, car: 5000, ferry: 2500 };
/** Up to this distance a flight's typical aircraft is a single-aisle jet; beyond it, a widebody. */
const NARROWBODY_MAX_KM = 4000;
/** When a family name ("787", "A350", "737") fits several types, the one most often flying. */
const COMMON: AircraftType[] = (['B789', 'B77W', 'A359', 'A333', 'A339', 'B763', 'B744', 'A388', 'B38M', 'B738', 'A20N', 'A21N', 'A320', 'BCS3', 'E190', 'CRJ9', 'DH8D', 'AT76'] as string[]).filter(isAircraftType);
const MODE_NAMES: Record<Exclude<LegMode, 'flight'>, string> = { train: 'Train', bus: 'Bus', car: 'Drive', ferry: 'Ferry' };

interface Place {
  text: string;
  airport?: Airport;
  /** How sure the airport is: a code in the text, a name match, or the model's or the nearest-candidate guess. */
  how?: 'written' | 'named' | 'guessed';
  /** The model's airport, when a name match outranked it. */
  alt?: Airport;
  /** Several airports fit the name; a flight asks, a train, bus, car or ferry leg picks the nearest. */
  options?: Airport[];
  /** A code the model gave that isn't in the airport table. */
  unknownCode?: string;
}

interface Need {
  fields: ('from' | 'to' | 'departure' | 'arrival')[];
  text: string;
  lookup: boolean;
  /** Answered by picking one of these. */
  options?: string[];
}

const km = (a: Airport, b: Airport) => distanceKm(a.lat, a.lon, b.lat, b.lon);
const RANK = { written: 3, named: 2, guessed: 1 } as const;

export function resolveIntent(intent: Intent, text: string, opts: ResolveOptions): ComposeResult {
  const trip: Question[] = [];
  const askTrip = (question: string, field: string, options?: string[]) => {
    if (trip.some((q) => q.question === question)) return;
    trip.push({ needs: [question], ...(options ? { choices: [{ need: 0, options }] } : {}), question, fields: [field], lookup: false });
  };

  const ground = (l: IntentLeg): l is IntentLeg & { mode: Exclude<LegMode, 'flight'> } => l.mode !== 'flight';
  let legs = intent.legs;
  let ends = legs.map((l) => [placeOf(l.from, l.fromCode, ground(l), text, opts), placeOf(l.to, l.toCode, ground(l), text, opts)] as [Place, Place]);

  // A train, bus, car or ferry leg with several candidate airports takes the one nearest the leg's other end, if
  // it's near enough to travel to that way.
  ends.forEach((pair, i) => {
    const leg = legs[i]!;
    if (!ground(leg)) return;
    for (const [mine, other] of [[0, 1], [1, 0]] as const) {
      const p = pair[mine];
      const anchor = pair[other].airport;
      if (p.options && anchor) {
        const best = nearest(p.options, anchor);
        if (best && km(best, anchor) <= GROUND_MAX_KM[leg.mode]) pair[mine] = { text: p.text, airport: best, how: 'guessed' };
      }
    }
  });

  // A train, bus, car or ferry leg that starts and ends at one airport (a car rental's pickup and return) can't be drawn.
  const keep = legs.map((l, i) => !(ground(l) && ends[i]![0].airport && ends[i]![0].airport?.code === ends[i]![1].airport?.code));
  legs = legs.filter((_, i) => keep[i]);
  ends = ends.filter((_, i) => keep[i]);

  if (legs.length === 0) {
    askTrip("I couldn't find any travel in that text. Which flights, trains, buses, drives or ferries did you take, between which places, and when?", 'legs');
    return { complete: false, spec: { schemaVersion: 1, legs: [] }, questions: trip, issues: [], warnings: [], airports: {}, places: [], assumed: [] };
  }
  if (legs.length > LIMITS.maxLegs) {
    askTrip(`That's ${legs.length} legs; a journey can have at most ${LIMITS.maxLegs}. Which part should this journey show?`, 'legs');
  }

  // Consecutive legs meet at one place. A train, bus, car or ferry leg's airport only stands for its station, so it
  // joins the adjacent leg's airport; a flight's must name the same place.
  for (let i = 1; i < legs.length; i++) {
    const a = ends[i - 1]![1];
    const b = ends[i]![0];
    const groundA = ground(legs[i - 1]!);
    const groundB = ground(legs[i]!);
    if (!a.airport && b.airport && (groundA || samePlace(a.text, b.airport))) ends[i - 1]![1] = b;
    else if (a.airport && !b.airport && (groundB || samePlace(b.text, a.airport))) ends[i]![0] = a;
    else if (a.airport && b.airport && a.airport.code !== b.airport.code && (groundA || groundB) && km(a.airport, b.airport) <= STAND_IN_KM) {
      if (groundB) ends[i]![0] = a;
      else ends[i - 1]![1] = b;
    }
  }

  // A train, bus, car or ferry leg too long for its mode has a misplaced end: the less certain one, or on a tie the
  // destination (a vague "ferry to the island"). The model's own airport replaces it if that fits; otherwise it's
  // asked about, along with the same place on a neighbouring leg.
  const misplaced = new Set<string>();
  legs.forEach((leg, i) => {
    const pair = ends[i]!;
    if (!ground(leg) || !pair[0].airport || !pair[1].airport) return;
    const max = GROUND_MAX_KM[leg.mode];
    if (km(pair[0].airport, pair[1].airport) <= max) return;
    // An end already found misplaced on an earlier leg is the culprit here too.
    const known = pair.findIndex((p) => misplaced.has(p.airport!.code));
    if (known >= 0) return;
    const side = RANK[pair[0].how ?? 'guessed'] < RANK[pair[1].how ?? 'guessed'] ? 0 : 1;
    const bad = pair[side];
    const anchor = pair[1 - side]!.airport!;
    if (bad.alt && km(bad.alt, anchor) <= max) pair[side] = { text: bad.text, airport: bad.alt, how: 'guessed' };
    else misplaced.add(bad.airport!.code);
  });
  if (misplaced.size) {
    ends.forEach((pair, i) => {
      if (!ground(legs[i]!)) return;
      pair.forEach((p, side) => {
        if (p.airport && p.how !== 'written' && misplaced.has(p.airport.code)) pair[side] = { text: p.text };
      });
    });
  }

  const yearKnown = (date: string) => !date.startsWith('0000') && yearStated(text, date.slice(0, 4));
  const label = (i: number) => {
    const leg = legs[i]!;
    // The leg's own words, not those of an adjacent leg whose airport it joined.
    const name = (written: string, p: Place) => {
      const w = written.trim();
      if (ground(leg) || !p.airport) return w || p.airport?.city || '?';
      return !w || w.toUpperCase() === p.airport.code ? p.airport.code : showsCode(w, p.airport.code) ? w : `${w} (${p.airport.code})`;
    };
    const what = ground(leg) ? MODE_NAMES[leg.mode] : (leg.flight ?? 'Flight');
    const when = leg.departDate ? `, ${dayLabel(leg.departDate, yearKnown(leg.departDate))}` : '';
    return `${what}, ${name(leg.from, ends[i]![0])} → ${name(leg.to, ends[i]![1])}${when}`;
  };

  const needs: Need[][] = legs.map(() => []);
  const need = (i: number, n: Need) => {
    if (!needs[i]!.some((x) => x.text === n.text)) needs[i]!.push(n);
  };
  /** A place asked about once, on the first leg that has it. */
  const placesAsked = new Set<string>();
  const assumed: string[] = [];
  const specLegs: Partial<LegSpec>[] = [];
  const ids = new Set<string>();
  legs.forEach((leg, i) => {
    const out: Partial<LegSpec> = {};
    const [from, to] = ends[i]!;
    for (const [side, end] of [['from', from], ['to', to]] as const) {
      if (end.airport) {
        out[side] = end.airport.code;
        continue;
      }
      const place = end.text.trim();
      if (place && placesAsked.has(fold(place))) continue;
      placesAsked.add(fold(place));
      const kind = leg.mode === 'ferry' ? 'town or port' : leg.mode === 'train' ? 'town or station' : 'town';
      const options = !ground(leg) && !end.unknownCode && end.options ? end.options.slice(0, 6).map((a) => optionName(a, place)) : undefined;
      const what = !place
        ? `where it ${side === 'from' ? 'left from' : 'arrived'}`
        : end.unknownCode
          ? `which airport “${end.unknownCode}” is`
          : ground(leg)
            ? `which ${kind} you mean by “${place}”`
            : options
              ? `which ${place} airport`
              : `which airport you mean by “${place}”`;
      // A flight's airport in a city with several is on its schedule, if the flight number is known.
      need(i, { fields: [side], text: what, lookup: !options || ground(leg) || !!leg.flight, ...(options ? { options } : {}) });
    }
    if (out.from && out.to) {
      let id = `${out.from}-${out.to}`.toLowerCase();
      for (let n = 2; ids.has(id); n++) id = `${out.from}-${out.to}-${n}`.toLowerCase();
      ids.add(id);
      out.id = id;
    }

    // Dates only the traveller knows; times are on schedules and timetables. Local wall time gets the offset the
    // airport's zone has at that moment.
    if (!leg.departDate) need(i, { fields: ['departure'], text: 'date', lookup: false });
    else if (!yearKnown(leg.departDate)) {
      const y = new Date(opts.now).getUTCFullYear();
      askTrip('Which year was this trip?', 'year', [y - 1, y, y + 1].map(String));
    }
    const missingTimes = (['departure', 'arrival'] as const).filter((f) => !(f === 'departure' ? leg.departTime : leg.arriveTime));
    if (missingTimes.length) {
      need(i, {
        fields: [...missingTimes],
        text: missingTimes.length === 2 ? 'local departure and arrival times' : `local ${missingTimes[0]} time`,
        lookup: true,
      });
    }
    let depUtc: number | undefined;
    if (leg.departDate && yearKnown(leg.departDate) && leg.departTime && from.airport) {
      const r = zoned(from.airport, leg.departDate, leg.departTime);
      if (typeof r === 'string') need(i, { fields: ['departure'], text: r, lookup: false });
      else {
        out.departure = r.timestamp;
        depUtc = r.utcMs;
      }
    }
    if (leg.arriveTime && to.airport && depUtc !== undefined) {
      // A stated arrival date counts only for train, bus, car and ferry legs, which can take days. A flight lands on
      // the only date that fits its times (the shortest positive flight time), which is also how date-line
      // crossings come out right.
      const stated = ground(leg) && leg.arriveDate && yearKnown(leg.arriveDate) ? zoned(to.airport, leg.arriveDate, leg.arriveTime) : null;
      if (stated && typeof stated !== 'string' && stated.utcMs > depUtc) out.arrival = stated.timestamp;
      for (let k = -1; k <= 2 && !out.arrival; k++) {
        const r = zoned(to.airport, addDays(leg.departDate!, k), leg.arriveTime);
        if (typeof r !== 'string' && r.utcMs > depUtc) out.arrival = r.timestamp;
      }
    }

    // The aircraft only changes the model drawn, so it's never a question. A type the text names (and the model didn't
    // make up) is used; a family name takes its most common member; otherwise a typical type for the distance.
    if (ground(leg)) out.mode = leg.mode;
    else {
      const m = leg.aircraft && writtenIn(leg.aircraft, text) ? matchAircraft(leg.aircraft) : null;
      if (m && 'type' in m) out.aircraft = m.type;
      else if (m) {
        out.aircraft = COMMON.find((c) => m.options.includes(c)) ?? m.options[0]!;
        assumed.push(`${i}.aircraft`);
      } else if (from.airport && to.airport) {
        out.aircraft = km(from.airport, to.airport) <= NARROWBODY_MAX_KM ? 'A20N' : 'B789';
        assumed.push(`${i}.aircraft`);
      }
    }
    specLegs.push(out);
  });

  const questions = [...trip, ...needs.flatMap((list, i) => (list.length ? [legQuestion(i, label(i), list)] : []))];
  const places = legs.map((l) => ({ from: l.from.trim(), to: l.to.trim() }));
  const airports: Record<string, string> = {};
  for (const [f, t] of ends) for (const e of [f, t]) if (e.airport) airports[e.airport.code] = e.airport.name;
  const title = titleOf(legs);
  const spec = { schemaVersion: 1 as const, ...(title ? { title } : {}), legs: specLegs };
  const partial = { spec, issues: [], warnings: [], airports, places, assumed };
  if (questions.length) return { complete: false, questions, ...partial };

  // No open questions but still invalid: usually a misread time or date, which the person is asked to check.
  const result = validateScene(spec, { lookupAirport: opts.lookupAirport, airportDataVersion: opts.airportDataVersion, now: opts.now });
  if (!result.ok) {
    const checks = result.issues.map((issue) => {
      const i = Number(/^\/legs\/(\d+)/.exec(issue.path)?.[1] ?? NaN);
      const sentence = `${issue.message} Can you check the dates and times?`;
      return Number.isInteger(i) && legs[i]
        ? legQuestion(i, label(i), [{ fields: ['departure', 'arrival'], text: sentence, lookup: false }])
        : { needs: [sentence], question: sentence, fields: ['legs'], lookup: false };
    });
    return { complete: false, questions: checks, ...partial, issues: result.issues };
  }
  return { complete: true, spec: spec as SceneSpecV1, questions: [], issues: [], warnings: sceneWarnings(result.normalized, opts.now), airports, places, assumed };
}

function legQuestion(i: number, about: string, list: Need[]): Question {
  const needs = list.map((n) => n.text);
  const choices = list.flatMap((n, need) => (n.options ? [{ need, options: n.options }] : []));
  return {
    leg: i,
    about,
    needs,
    ...(choices.length ? { choices } : {}),
    question: `${about}: ${list.map((n) => (n.options ? `${n.text}: ${n.options.join(', ')}` : n.text)).join('; ')}`,
    fields: [...new Set(list.flatMap((n) => n.fields.map((f) => `${i}.${f}`)))],
    lookup: list.some((n) => n.lookup),
  };
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (s: string) => fold(s).match(/[a-z0-9']+/g)?.map((w) => w.replace(/'/g, '')) ?? [];

/**
 * Find the airport a place names: a code the person wrote, a city with several airports, the model's code, or the
 * airport table. `itinerary` is the whole text the person sent.
 */
function placeOf(text: string, code: string | null, ground: boolean, itinerary: string, opts: ResolveOptions): Place {
  const written = text.trim().toUpperCase();
  const writtenAirport = /^[A-Z]{3}$/.test(written) ? opts.lookupAirport(written) : undefined;
  if (writtenAirport) return { text, airport: writtenAirport, how: 'written' };
  // The model's code counts as written when the itinerary itself has it ("New York (JFK)").
  const codeWritten = code && /^[A-Z]{3}$/.test(code) && new RegExp(`\\b${code}\\b`).test(itinerary) ? opts.lookupAirport(code) : undefined;
  if (codeWritten) return { text, airport: codeWritten, how: 'written' };

  // A station in such a city ("Paris Gare du Nord") stands in with the city; a flight needs the city alone.
  const named = metroOf(text, ground);
  const metro = named ?? METROS.find((m) => m.code === code);
  if (metro && (named || !code || !opts.lookupAirport(code))) {
    if (ground) return { text, airport: opts.lookupAirport(metro.centre), how: 'named' };
    return { text, options: metro.airports.map((c) => opts.lookupAirport(c)).filter((a): a is Airport => !!a) };
  }

  const modelAirport = code && /^[A-Z]{3}$/.test(code) ? opts.lookupAirport(code) : undefined;
  if (modelAirport && samePlace(text, modelAirport)) return { text, airport: modelAirport, how: 'named' };
  const found = searchPlace(text, opts);
  // The table outranks a model code that doesn't match the name, but only when exactly one airport fits it.
  if (found.length === 1) return { text, airport: found[0], how: 'named', ...(modelAirport && modelAirport !== found[0] ? { alt: modelAirport } : {}) };
  if (modelAirport) return { text, airport: modelAirport, how: 'guessed' };
  if (found.length > 1) {
    if (ground && found.every((a) => km(a, found[0]!) <= SAME_CITY_KM)) return { text, airport: found[0], how: 'named' };
    return { text, options: found };
  }
  return code && /^[A-Z]{3}$/.test(code) ? { text, unknownCode: code } : { text };
}

/** A city with several airports, written without saying which ("London", "Tokyo, Japan", "NYC"), or any place in it. */
function metroOf(text: string, prefix: boolean) {
  const w = words(text);
  for (const m of METROS) {
    for (const name of m.names) {
      const n = name.split(' ');
      if (n.every((x, i) => w[i] === x) && (prefix || w.slice(n.length).every((x) => GENERIC.has(x)))) return m;
    }
  }
  return undefined;
}

/**
 * Airports named by the longest leading part of the place ("Paris Gare du Nord" → "Paris"), but never by one weak
 * word alone ("South Coast" isn't "South").
 */
function searchPlace(text: string, opts: ResolveOptions): Airport[] {
  const w = words(text).filter((x) => !GENERIC.has(x));
  if (!w.length || w[0]!.length < 3) return [];
  const candidates = opts.searchAirports(w[0]!);
  for (let n = w.length; n >= (WEAK.has(w[0]!) ? 2 : 1); n--) {
    const phrase = w.slice(0, n).join(' ');
    const hits = candidates.filter((a) => words(`${a.name} ${a.city}`).join(' ').includes(phrase));
    if (hits.length) return hits;
  }
  return [];
}

/**
 * Whether a place as written names this airport: one of its words (not a weak one like "South") starts a word of the
 * airport's code, name or city, comparing the first four letters so typos still match ("Singpore", "Londn Heathrw").
 */
function samePlace(text: string, airport: Airport): boolean {
  const hay = ` ${words(`${airport.code} ${airport.name} ${airport.city}`).join(' ')}`;
  return words(text).some((w) => w.length >= 3 && !GENERIC.has(w) && !WEAK.has(w) && hay.includes(` ${w.slice(0, 4)}`));
}

/** An airport as one of several in a city: "Heathrow (LHR)" for London Heathrow Airport. */
function optionName(a: Airport, place: string): string {
  const city = new Set(words(place));
  const short = a.name.split(/\s+/).filter((w) => !/^(international|intl\.?|airport|aerodrome|airfield)$/i.test(w));
  const rest = short.filter((w) => !city.has(fold(w)));
  const name = rest.length && !(rest.length === 1 && GENERIC.has(fold(rest[0]!))) ? rest : short;
  return `${name.join(' ') || a.name} (${a.code})`;
}

function nearest(options: Airport[], anchor: Airport): Airport | undefined {
  let best: Airport | undefined;
  let bestKm = Infinity;
  for (const a of options) {
    const d = distanceKm(a.lat, a.lon, anchor.lat, anchor.lon);
    if (d < bestKm) [best, bestKm] = [a, d];
  }
  return best;
}

/** The year appears in the text, as 2027 or as the 27 in "05MAR27", "5/3/27" or "'27". */
function yearStated(text: string, year: string): boolean {
  return text.includes(year) || new RegExp(`(?:[A-Za-z]{3}|['’/.-])${year.slice(2)}\\b`).test(text);
}

function zoned(airport: Airport, date: string, time: string): { timestamp: string; utcMs: number } | string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const wall: WallTime = { year: y, month: mo, day: d, hour: h, minute: mi, second: 0 };
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return `${date} isn't a real date. Which date did you mean?`;
  const options = resolveWallTime(airport.timeZone, wall);
  const local = `${date} ${time} at ${airport.code}`;
  if (options.length === 0) return `${local} doesn't exist: the clocks skip that hour. What was the scheduled time?`;
  if (options.length === 2) return `${local} happens twice because the clocks go back. Was it before or after the change?`;
  return { timestamp: `${date}T${time}:00${formatOffset(options[0]!.offsetMinutes)}`, utcMs: options[0]!.utcMs };
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function titleOf(legs: IntentLeg[]): string | undefined {
  const first = legs[0]!.from.trim();
  const last = legs[legs.length - 1]!.to.trim();
  if (!first || !last || fold(first) === fold(last)) return undefined;
  const t = `${first} to ${last}`;
  return t.length <= LIMITS.maxTitleLength && !/[\u0000-\u001f]/.test(t) ? t : undefined;
}

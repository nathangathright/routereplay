/**
 * Turns the model's intent into a scene spec without the model: airports from the airport table, UTC offsets from
 * each airport's zone, arrival dates from the only date that fits, aircraft designators from the supported list.
 * What the text doesn't settle becomes a question; nothing is invented.
 */
import { distanceKm } from '../../shared/geo/greatCircle';
import { AIRCRAFT_TYPES } from '../../shared/scene/aircraft';
import { LIMITS } from '../../shared/scene/constants';
import { formatOffset, resolveWallTime, type WallTime } from '../../shared/scene/time';
import type { Airport, AirportLookup, LegSpec, SceneSpecV1, ValidationIssue } from '../../shared/scene/types';
import { validateScene } from '../../shared/scene/validate';
import { type SceneWarning, sceneWarnings } from '../../shared/scene/warnings';
import { matchAircraft, writtenIn } from './aircraft';
import type { Intent, IntentLeg } from './intent';

export interface Question {
  /** JSON Pointer to the field the answer fills, or /legs for the whole trip. */
  path: string;
  field: 'from' | 'to' | 'departure' | 'arrival' | 'year' | 'aircraft' | 'legs';
  question: string;
  options?: string[];
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
}

export interface ResolveOptions {
  lookupAirport: AirportLookup;
  searchAirports: (word: string) => Airport[];
  airportDataVersion: string;
  now: number;
}

/**
 * Cities with several major airports. A flight from one, unnamed, is a question; a train, bus, car or ferry leg
 * uses the first airport (the closest to the centre) to mark the city.
 */
const METROS: { code: string; names: string[]; airports: string[] }[] = [
  { code: 'LON', names: ['london'], airports: ['LCY', 'LHR', 'LGW', 'STN', 'LTN', 'SEN'] },
  { code: 'NYC', names: ['new york', 'nyc'], airports: ['LGA', 'JFK', 'EWR'] },
  { code: 'PAR', names: ['paris'], airports: ['ORY', 'CDG', 'BVA'] },
  { code: 'TYO', names: ['tokyo'], airports: ['HND', 'NRT'] },
  { code: 'CHI', names: ['chicago'], airports: ['MDW', 'ORD'] },
  { code: 'WAS', names: ['washington'], airports: ['DCA', 'IAD', 'BWI'] },
  { code: 'MIL', names: ['milan', 'milano'], airports: ['LIN', 'MXP', 'BGY'] },
  { code: 'ROM', names: ['rome', 'roma'], airports: ['CIA', 'FCO'] },
  { code: 'OSA', names: ['osaka'], airports: ['ITM', 'KIX', 'UKB'] },
  { code: 'SEL', names: ['seoul'], airports: ['GMP', 'ICN'] },
  { code: 'BJS', names: ['beijing'], airports: ['PEK', 'PKX'] },
  { code: 'MOW', names: ['moscow'], airports: ['VKO', 'SVO', 'DME'] },
  { code: 'STO', names: ['stockholm'], airports: ['BMA', 'ARN'] },
  { code: 'BUE', names: ['buenos aires'], airports: ['AEP', 'EZE'] },
  { code: 'SAO', names: ['sao paulo'], airports: ['CGH', 'GRU', 'VCP'] },
  { code: 'RIO', names: ['rio de janeiro', 'rio'], airports: ['SDU', 'GIG'] },
  { code: 'YTO', names: ['toronto'], airports: ['YTZ', 'YYZ'] },
  { code: 'JKT', names: ['jakarta'], airports: ['HLP', 'CGK'] },
];
/** Words that don't single out an airport: "London, UK", "Tokyo city", "Paris airport". */
const GENERIC = new Set(['the', 'city', 'centre', 'center', 'downtown', 'area', 'airport', 'airports', 'intl', 'international', 'uk', 'england', 'usa', 'us', 'ny', 'japan', 'france', 'italy', 'korea', 'china', 'russia', 'sweden', 'argentina', 'brazil', 'canada', 'indonesia', 'dc', 'il', 'on']);
/** A train, bus, car or ferry leg's endpoints stand for stations; within this distance they join the adjacent leg's airport. */
const STAND_IN_KM = 100;
/** Airports this close together are one city's, so any of them can stand for its station. */
const SAME_CITY_KM = 80;

interface Place {
  text: string;
  airport?: Airport;
  /** Several airports fit the name; a flight asks, a train, bus, car or ferry leg picks the nearest. */
  options?: Airport[];
  /** A code the model gave that isn't in the airport table. */
  unknownCode?: string;
}

export function resolveIntent(intent: Intent, text: string, opts: ResolveOptions): ComposeResult {
  const questions: Question[] = [];
  const ask = (q: Question) => {
    if (!questions.some((x) => x.question === q.question)) questions.push(q);
  };

  const ground = (l: IntentLeg) => l.mode !== 'flight';
  let legs = intent.legs;
  let ends = legs.map((l) => [placeOf(l.from, l.fromCode, ground(l), text, opts), placeOf(l.to, l.toCode, ground(l), text, opts)] as [Place, Place]);

  // A train, bus, car or ferry leg with several candidate airports takes the one nearest the leg's other end.
  ends.forEach((pair, i) => {
    if (!ground(legs[i]!)) return;
    for (const [mine, other] of [[0, 1], [1, 0]] as const) {
      const p = pair[mine];
      const anchor = pair[other].airport;
      if (p.options && anchor) {
        const best = nearest(p.options, anchor);
        if (best) pair[mine] = { text: p.text, airport: best };
      }
    }
  });

  // A train, bus, car or ferry leg that starts and ends at one airport (a car rental's pickup and return) can't be drawn.
  const keep = legs.map((l, i) => !(ground(l) && ends[i]![0].airport && ends[i]![0].airport?.code === ends[i]![1].airport?.code));
  legs = legs.filter((_, i) => keep[i]);
  ends = ends.filter((_, i) => keep[i]);

  if (legs.length === 0) {
    ask({ path: '/legs', field: 'legs', question: "I couldn't find any travel in that text. Which flights, trains, buses, drives or ferries did you take, between which places, and when?" });
    return { complete: false, spec: { schemaVersion: 1, legs: [] }, questions, issues: [], warnings: [], airports: {} };
  }
  if (legs.length > LIMITS.maxLegs) {
    ask({ path: '/legs', field: 'legs', question: `That's ${legs.length} legs; a journey can have at most ${LIMITS.maxLegs}. Which part should this journey show?` });
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
    else if (
      a.airport && b.airport && a.airport.code !== b.airport.code && (groundA || groundB) &&
      distanceKm(a.airport.lat, a.airport.lon, b.airport.lat, b.airport.lon) <= STAND_IN_KM
    ) {
      if (groundB) ends[i]![0] = a;
      else ends[i - 1]![1] = b;
    }
  }

  const routeName = (i: number) => {
    const l = legs[i]!;
    const [f, t] = ends[i]!;
    const what = l.mode === 'flight' ? (l.flight ? `flight ${l.flight}` : 'flight') : `${l.mode} leg`;
    return `the ${what} from ${f.airport?.code ?? f.text} to ${t.airport?.code ?? t.text}`;
  };
  const yearKnown = (date: string) => !date.startsWith('0000') && yearStated(text, date.slice(0, 4));

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
      const place = end.text || (side === 'from' ? 'the start' : 'the end');
      const question = end.unknownCode
        ? `"${end.unknownCode}" isn't an airport I know. Which airport is ${place}?`
        : ground(leg)
          ? `Which airport is nearest to ${place}? It marks the ${leg.mode === 'ferry' ? 'port' : 'station or town'} on the map.`
          : `Which airport in ${place}? (${routeName(i)})`;
      ask({
        path: `/legs/${i}/${side}`,
        field: side,
        question,
        ...(end.options ? { options: end.options.slice(0, 6).map((a) => `${a.code} (${a.name})`) } : {}),
      });
    }
    if (out.from && out.to) {
      let id = `${out.from}-${out.to}`.toLowerCase();
      for (let n = 2; ids.has(id); n++) id = `${out.from}-${out.to}-${n}`.toLowerCase();
      ids.add(id);
      out.id = id;
    }

    // Times: local wall time plus the offset the airport's zone has at that moment.
    let depUtc: number | undefined;
    if (!leg.departDate) ask({ path: `/legs/${i}/departure`, field: 'departure', question: `What date did ${routeName(i)} leave?` });
    else if (!yearKnown(leg.departDate)) ask({ path: '/legs', field: 'year', question: 'Which year was this trip?' });
    if (!leg.departTime) ask({ path: `/legs/${i}/departure`, field: 'departure', question: `What time did ${routeName(i)} leave (local time)?` });
    if (leg.departDate && yearKnown(leg.departDate) && leg.departTime && from.airport) {
      const r = zoned(from.airport, leg.departDate, leg.departTime);
      if (typeof r === 'string') ask({ path: `/legs/${i}/departure`, field: 'departure', question: r });
      else {
        out.departure = r.timestamp;
        depUtc = r.utcMs;
      }
    }
    if (!leg.arriveTime) ask({ path: `/legs/${i}/arrival`, field: 'arrival', question: `What time did ${routeName(i)} arrive (local time)?` });
    else if (to.airport && depUtc !== undefined) {
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

    if (ground(leg)) out.mode = leg.mode;
    else if (!leg.aircraft || !writtenIn(leg.aircraft, text)) {
      ask({
        path: `/legs/${i}/aircraft`,
        field: 'aircraft',
        question: `Which aircraft type flew ${routeName(i)}? Booking confirmations and flight-history sites list it (for example Boeing 787-9 or Airbus A321neo).`,
      });
    } else {
      const m = matchAircraft(leg.aircraft);
      if (m && 'type' in m) out.aircraft = m.type;
      else
        ask({
          path: `/legs/${i}/aircraft`,
          field: 'aircraft',
          question: m
            ? `Which ${leg.aircraft} was ${routeName(i)}?`
            : `Which aircraft is "${leg.aircraft}" on ${routeName(i)}? It isn't one of the types Route Replay draws; the closest one will do.`,
          ...(m ? { options: m.options.map((c) => `${c} (${AIRCRAFT_TYPES[c].name})`) } : {}),
        });
    }
    specLegs.push(out);
  });

  const airports: Record<string, string> = {};
  for (const [f, t] of ends) for (const e of [f, t]) if (e.airport) airports[e.airport.code] = e.airport.name;
  const title = titleOf(legs);
  const spec = { schemaVersion: 1 as const, ...(title ? { title } : {}), legs: specLegs };
  if (questions.length) return { complete: false, spec, questions, issues: [], warnings: [], airports };

  const result = validateScene(spec, { lookupAirport: opts.lookupAirport, airportDataVersion: opts.airportDataVersion, now: opts.now });
  if (!result.ok) return { complete: false, spec, questions, issues: result.issues, warnings: [], airports };
  return { complete: true, spec: spec as SceneSpecV1, questions, issues: [], warnings: sceneWarnings(result.normalized, opts.now), airports };
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
  if (writtenAirport) return { text, airport: writtenAirport };
  // The model's code counts as written when the itinerary itself has it ("New York (JFK)").
  const codeWritten = code && /^[A-Z]{3}$/.test(code) && new RegExp(`\\b${code}\\b`).test(itinerary) ? opts.lookupAirport(code) : undefined;
  if (codeWritten) return { text, airport: codeWritten };

  // A station in such a city ("Paris Gare du Nord") stands in with the city; a flight needs the city alone.
  const named = metroOf(text, ground);
  const metro = named ?? METROS.find((m) => m.code === code);
  if (metro && (named || !code || !opts.lookupAirport(code))) {
    const airports = metro.airports.map((c) => opts.lookupAirport(c)).filter((a): a is Airport => !!a);
    return ground ? { text, airport: airports[0] } : { text, options: airports };
  }

  const modelAirport = code && /^[A-Z]{3}$/.test(code) ? opts.lookupAirport(code) : undefined;
  if (modelAirport && samePlace(text, modelAirport)) return { text, airport: modelAirport };
  const found = searchPlace(text, opts);
  // The table outranks a model code that doesn't match the name, but only when exactly one airport fits it.
  if (found.length === 1) return { text, airport: found[0] };
  if (modelAirport) return { text, airport: modelAirport };
  if (found.length > 1) {
    if (ground && found.every((a) => distanceKm(a.lat, a.lon, found[0]!.lat, found[0]!.lon) <= SAME_CITY_KM)) return { text, airport: found[0] };
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

/** Airports named by the longest leading part of the place ("Paris Gare du Nord" → "Paris"). */
function searchPlace(text: string, opts: ResolveOptions): Airport[] {
  const w = words(text).filter((x) => !GENERIC.has(x));
  if (!w.length || w[0]!.length < 3) return [];
  const candidates = opts.searchAirports(w[0]!);
  for (let n = w.length; n >= 1; n--) {
    const phrase = w.slice(0, n).join(' ');
    const hits = candidates.filter((a) => words(`${a.name} ${a.city}`).join(' ').includes(phrase));
    if (hits.length) return hits;
  }
  return [];
}

/**
 * Whether a place as written names this airport: one of its words starts a word of the airport's code, name or city,
 * comparing the first four letters so typos still match ("Singpore", "Londn Heathrw").
 */
function samePlace(text: string, airport: Airport): boolean {
  const hay = ` ${words(`${airport.code} ${airport.name} ${airport.city}`).join(' ')}`;
  return words(text).some((w) => w.length >= 3 && !GENERIC.has(w) && hay.includes(` ${w.slice(0, 4)}`));
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

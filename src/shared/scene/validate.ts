import { ANTIPODAL_MARGIN, COINCIDENT_ANGLE, EARTH_RADIUS_KM, centralAngle } from '../geo/greatCircle';
import { latLonToVec } from '../geo/vec';
import { pinnedCloudRun } from '../weather/gfs';
import { AIRCRAFT_DESIGNATORS, AIRCRAFT_TYPES, type AircraftType, isAircraftType } from './aircraft';
import {
  ASSET_MANIFEST_VERSION,
  DEFAULTS,
  FPS,
  LIMITS,
  RENDERER_VERSION,
  STYLE_PRESETS,
  SUPPORTED_SCHEMA_VERSIONS,
  WEATHER_TREATMENTS,
  type WeatherTreatment,
} from './constants';
import {
  formatLocalTimestamp,
  formatOffset,
  formatUtc,
  parseOffsetTimestamp,
  resolveWallTime,
  wallToString,
  zoneOffsetMinutes,
  type ParsedTimestamp,
} from './time';
import type {
  Airport,
  AirportLookup,
  IssueCode,
  LegSpec,
  NormalizedLeg,
  NormalizedSceneV1,
  SceneSpecV1,
  ValidationIssue,
  ValidationResult,
} from './types';

const MAX_ISSUES = 50;
const LEG_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const AIRPORT_RE = /^[A-Z]{3}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');

const TOP_FIELDS = ['schemaVersion', 'title', 'legs', 'presentation', 'environment', 'assets', 'seed'];
const LEG_FIELDS = ['id', 'from', 'to', 'departure', 'arrival', 'aircraft'];
const PRESENTATION_FIELDS = [
  'durationSeconds',
  'legWeights',
  'stopHolds',
  'startHoldSeconds',
  'endHoldSeconds',
];

export interface ValidateOptions {
  lookupAirport: AirportLookup;
  airportDataVersion: string;
  /** Save time: with clouds on, the newest complete weather-model run at this moment is pinned. */
  now?: number;
}

const escapePointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
const ptr = (...parts: (string | number)[]) => parts.map((p) => '/' + escapePointer(String(p))).join('');

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const describe = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

class Collector {
  readonly issues: ValidationIssue[] = [];
  add(path: string, code: IssueCode, message: string, hint?: string) {
    if (this.issues.length < MAX_ISSUES) this.issues.push(hint ? { path, code, message, hint } : { path, code, message });
  }
  get count() {
    return this.issues.length;
  }
}

function checkUnknown(c: Collector, obj: Record<string, unknown>, allowed: string[], base: string) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      c.add(ptr(...splitPointer(base), key), 'unknown_field', `Unknown field "${key}".`, `Allowed fields here: ${allowed.join(', ')}.`);
    }
  }
}

const splitPointer = (p: string): string[] =>
  p === '' ? [] : p.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));

function checkNumber(
  c: Collector,
  value: unknown,
  path: string,
  min: number,
  max: number,
  opts: { integer?: boolean } = {},
): value is number {
  if (typeof value !== 'number') {
    c.add(path, 'type', `Expected a number, got ${describe(value)}.`);
    return false;
  }
  if (!Number.isFinite(value)) {
    c.add(path, 'not_finite', 'Number must be finite.');
    return false;
  }
  if (opts.integer && !Number.isInteger(value)) {
    c.add(path, 'not_integer', 'Expected an integer.');
    return false;
  }
  if (value < min || value > max) {
    c.add(path, 'out_of_range', `Value ${value} is outside ${min}–${max}.`);
    return false;
  }
  return true;
}

function checkEnum(c: Collector, value: unknown, path: string, allowed: readonly string[]): boolean {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    c.add(
      path,
      'unsupported_preset',
      `Unsupported value ${JSON.stringify(value)}.`,
      `Supported values: ${allowed.map((a) => JSON.stringify(a)).join(', ')}.`,
    );
    return false;
  }
  return true;
}

/** Structural validation equivalent to the published JSON Schema. */
function checkStructure(c: Collector, input: unknown): input is SceneSpecV1 {
  if (!isPlainObject(input)) {
    c.add('', 'type', `The scene spec must be a JSON object, got ${describe(input)}.`);
    return false;
  }
  if (!('schemaVersion' in input)) {
    c.add('/schemaVersion', 'required', 'Missing schemaVersion.', 'Add "schemaVersion": 1.');
    return false;
  }
  if (!(SUPPORTED_SCHEMA_VERSIONS as readonly unknown[]).includes(input.schemaVersion)) {
    c.add(
      '/schemaVersion',
      'unsupported_version',
      `Unsupported schemaVersion ${JSON.stringify(input.schemaVersion)}.`,
      `Supported versions: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}. Read /schemas/scene-v1.json for the current contract.`,
    );
    return false;
  }
  checkUnknown(c, input, TOP_FIELDS, '');

  if ('title' in input) {
    const t = input.title;
    if (typeof t !== 'string') c.add('/title', 'type', `Expected a string, got ${describe(t)}.`);
    else if (t.trim().length === 0) c.add('/title', 'too_few', 'Title must not be empty. Omit it instead.');
    else if (t.length > LIMITS.maxTitleLength)
      c.add('/title', 'too_long', `Title is ${t.length} characters; the limit is ${LIMITS.maxTitleLength}.`);
    else if (CONTROL_RE.test(t)) c.add('/title', 'pattern', 'Title must not contain control characters or line breaks.');
  }

  if (!('legs' in input)) {
    c.add('/legs', 'required', 'Missing legs.', 'Provide at least one leg.');
  } else if (!Array.isArray(input.legs)) {
    c.add('/legs', 'type', `Expected an array of legs, got ${describe(input.legs)}.`);
  } else if (input.legs.length === 0) {
    c.add('/legs', 'too_few', 'At least one leg is required.');
  } else if (input.legs.length > LIMITS.maxLegs) {
    c.add('/legs', 'too_many', `${input.legs.length} legs exceeds the limit of ${LIMITS.maxLegs}.`, 'Split the journey into separate scenes.');
  } else {
    input.legs.forEach((leg, i) => checkLegStructure(c, leg, i));
  }

  if ('presentation' in input) {
    const p = input.presentation;
    if (!isPlainObject(p)) {
      c.add('/presentation', 'type', `Expected an object, got ${describe(p)}.`);
    } else {
      checkUnknown(c, p, PRESENTATION_FIELDS, '/presentation');
      if ('durationSeconds' in p)
        checkNumber(c, p.durationSeconds, '/presentation/durationSeconds', LIMITS.minDurationSeconds, LIMITS.maxDurationSeconds);
      for (const key of ['startHoldSeconds', 'endHoldSeconds'] as const) {
        if (key in p) checkNumber(c, p[key], `/presentation/${key}`, 0, LIMITS.maxStartEndHoldSeconds);
      }
      checkLegMap(c, p, 'legWeights', LIMITS.minLegWeight, LIMITS.maxLegWeight);
      checkLegMap(c, p, 'stopHolds', 0, LIMITS.maxStopHoldSeconds);
    }
  }

  if ('environment' in input) {
    const e = input.environment;
    if (!isPlainObject(e)) c.add('/environment', 'type', `Expected an object, got ${describe(e)}.`);
    else {
      checkUnknown(c, e, ['weather'], '/environment');
      if ('weather' in e) checkEnum(c, e.weather, '/environment/weather', WEATHER_TREATMENTS);
    }
  }

  if ('assets' in input) {
    const a = input.assets;
    if (!isPlainObject(a)) c.add('/assets', 'type', `Expected an object, got ${describe(a)}.`);
    else {
      checkUnknown(c, a, ['style'], '/assets');
      if ('style' in a) checkEnum(c, a.style, '/assets/style', STYLE_PRESETS);
    }
  }

  if ('seed' in input) checkNumber(c, input.seed, '/seed', 0, LIMITS.maxSeed, { integer: true });

  return c.count === 0;
}

function checkLegStructure(c: Collector, leg: unknown, i: number) {
  const base = ptr('legs', i);
  if (!isPlainObject(leg)) {
    c.add(base, 'type', `Expected a leg object, got ${describe(leg)}.`);
    return;
  }
  checkUnknown(c, leg, LEG_FIELDS, base);
  for (const field of LEG_FIELDS) {
    if (!(field in leg)) {
      c.add(`${base}/${field}`, 'required', `Missing ${field}.`);
      continue;
    }
    const v = leg[field];
    if (typeof v !== 'string') {
      c.add(`${base}/${field}`, 'type', `Expected a string, got ${describe(v)}.`);
      continue;
    }
    if (field === 'id') {
      if (v.length > LIMITS.maxLegIdLength)
        c.add(`${base}/id`, 'too_long', `Leg id is longer than ${LIMITS.maxLegIdLength} characters.`);
      else if (!LEG_ID_RE.test(v))
        c.add(`${base}/id`, 'pattern', `Invalid leg id ${JSON.stringify(v)}.`, 'Use lowercase letters, digits, and inner hyphens, e.g. "ord-sfo".');
    } else if (field === 'aircraft') {
      if (!isAircraftType(v)) c.add(`${base}/aircraft`, 'unsupported_aircraft', `Unsupported aircraft type ${JSON.stringify(v)}.`, aircraftHint(v));
    } else if (field === 'from' || field === 'to') {
      if (!AIRPORT_RE.test(v)) {
        c.add(
          `${base}/${field}`,
          'pattern',
          `Invalid airport code ${JSON.stringify(v)}.`,
          /^[A-Za-z]{4}$/.test(v)
            ? 'Use the 3-letter IATA code, not the 4-letter ICAO code.'
            : 'Use an uppercase 3-letter IATA code such as "ORD".',
        );
      }
    } else {
      const parsed = parseOffsetTimestamp(v);
      if (parsed === 'timestamp_format') {
        c.add(
          `${base}/${field}`,
          'timestamp_format',
          `Timestamp ${JSON.stringify(v)} must be ISO 8601 with an explicit UTC offset.`,
          'Example: "2031-01-05T10:00:00-06:00". Use the airport\'s local offset at that moment.',
        );
      } else if (parsed === 'invalid_date') {
        c.add(`${base}/${field}`, 'invalid_date', `Timestamp ${JSON.stringify(v)} is not a real calendar date and time.`);
      } else if (parsed.wall.year < LIMITS.earliestYear || parsed.wall.year > LIMITS.latestYear) {
        c.add(`${base}/${field}`, 'out_of_range', `Year ${parsed.wall.year} is outside ${LIMITS.earliestYear}–${LIMITS.latestYear}.`);
      }
    }
  }
}

/** Points at the likely fix: case, an IATA aircraft code, or the list of supported ICAO designators. */
function aircraftHint(v: string): string {
  const supported = `Supported ICAO type designators: ${AIRCRAFT_DESIGNATORS.join(', ')}.`;
  const upper = v.toUpperCase();
  if (isAircraftType(upper)) return `Use uppercase: "${upper}" (${AIRCRAFT_TYPES[upper].name}).`;
  if (/^[0-9A-Z]{3}$/i.test(v) && /[0-9]/.test(v))
    return `That looks like a 3-character IATA aircraft code; use the 4-character ICAO type designator instead, such as "B738" for a Boeing 737-800. ${supported}`;
  return `${supported} If the aircraft is not listed, choose the closest listed type and tell the creator.`;
}

function checkLegMap(c: Collector, p: Record<string, unknown>, key: 'legWeights' | 'stopHolds', min: number, max: number) {
  if (!(key in p)) return;
  const m = p[key];
  const base = `/presentation/${key}`;
  if (!isPlainObject(m)) {
    c.add(base, 'type', `Expected an object keyed by leg id, got ${describe(m)}.`);
    return;
  }
  for (const [legId, value] of Object.entries(m)) {
    const path = ptr('presentation', key, legId);
    if (!LEG_ID_RE.test(legId)) c.add(path, 'pattern', `Invalid leg id key ${JSON.stringify(legId)}.`);
    checkNumber(c, value, path, min, max);
  }
}

interface LegTimes {
  dep: ParsedTimestamp;
  arr: ParsedTimestamp;
}

function offsetHint(airport: Airport, ts: ParsedTimestamp): string {
  const options = resolveWallTime(airport.timeZone, ts.wall);
  const wall = wallToString(ts.wall);
  if (options.length === 0) {
    return `${wall} does not exist in ${airport.timeZone} (the clocks skip that hour). Confirm the scheduled time.`;
  }
  if (options.length === 1) {
    return `If ${wall} is local time at ${airport.code}, write ${wall}${formatOffset(options[0]!.offsetMinutes)}.`;
  }
  const both = options.map((o) => `${wall}${formatOffset(o.offsetMinutes)}`).join(' or ');
  return `${wall} occurs twice in ${airport.timeZone} (clocks fall back). Use ${both} to choose the intended one.`;
}

/**
 * Validate an authoring spec and derive the normalized record.
 * Pure and deterministic apart from the injected airport lookup.
 */
export function validateScene(input: unknown, options: ValidateOptions): ValidationResult {
  const c = new Collector();
  if (!checkStructure(c, input)) return { ok: false, issues: c.issues };
  const spec = input;
  const legs = spec.legs;

  // Unique leg ids.
  const seen = new Map<string, number>();
  legs.forEach((leg, i) => {
    const prev = seen.get(leg.id);
    if (prev !== undefined)
      c.add(ptr('legs', i, 'id'), 'duplicate_leg_id', `Leg id "${leg.id}" is also used by leg ${prev}.`, 'Give each leg a unique id.');
    else seen.set(leg.id, i);
  });

  // Airports.
  const airports: Record<string, Airport> = {};
  legs.forEach((leg, i) => {
    for (const field of ['from', 'to'] as const) {
      const code = leg[field];
      const airport = options.lookupAirport(code);
      if (!airport)
        c.add(
          ptr('legs', i, field),
          'unknown_airport',
          `Unknown airport code "${code}".`,
          'Use the IATA code of an airport with scheduled passenger service. Check for typos or a city code (e.g. use ORD or MDW, not CHI).',
        );
      else airports[code] = airport;
    }
  });

  // Times and per-leg geometry.
  const times: (LegTimes | null)[] = legs.map((leg, i) => {
    const from = airports[leg.from];
    const to = airports[leg.to];
    const dep = parseOffsetTimestamp(leg.departure) as ParsedTimestamp;
    const arr = parseOffsetTimestamp(leg.arrival) as ParsedTimestamp;
    let ok = true;
    if (from) {
      const expected = zoneOffsetMinutes(from.timeZone, dep.utcMs);
      if (expected !== dep.offsetMinutes) {
        ok = false;
        c.add(
          ptr('legs', i, 'departure'),
          'offset_mismatch',
          `${leg.from} (${from.timeZone}) is at UTC${formatOffset(expected)} at that instant, but the timestamp says ${formatOffset(dep.offsetMinutes)}.`,
          offsetHint(from, dep),
        );
      }
    }
    if (to) {
      const expected = zoneOffsetMinutes(to.timeZone, arr.utcMs);
      if (expected !== arr.offsetMinutes) {
        ok = false;
        c.add(
          ptr('legs', i, 'arrival'),
          'offset_mismatch',
          `${leg.to} (${to.timeZone}) is at UTC${formatOffset(expected)} at that instant, but the timestamp says ${formatOffset(arr.offsetMinutes)}.`,
          offsetHint(to, arr),
        );
      }
    }
    if (leg.from === leg.to) {
      c.add(ptr('legs', i, 'to'), 'same_airport', `Leg departs and arrives at ${leg.from}.`, 'A leg must connect two different airports.');
      ok = false;
    } else if (from && to) {
      const angle = centralAngle(latLonToVec(from.lat, from.lon), latLonToVec(to.lat, to.lon));
      if (angle < COINCIDENT_ANGLE) {
        c.add(ptr('legs', i, 'to'), 'same_airport', `${leg.from} and ${leg.to} share a location.`);
        ok = false;
      } else if (Math.PI - angle < ANTIPODAL_MARGIN) {
        c.add(ptr('legs', i, 'to'), 'antipodal_route', `${leg.from} and ${leg.to} are antipodal, so the route direction is undefined.`, 'Add an intermediate stop.');
        ok = false;
      }
    }
    const minutes = (arr.utcMs - dep.utcMs) / 60_000;
    if (minutes <= 0) {
      c.add(
        ptr('legs', i, 'arrival'),
        'arrival_not_after_departure',
        `Arrival ${formatUtc(arr.utcMs)} is not after departure ${formatUtc(dep.utcMs)} (UTC).`,
        'Check the date: flights that cross the date line often arrive on a different calendar day.',
      );
      ok = false;
    } else if (minutes < LIMITS.minFlightMinutes || minutes > LIMITS.maxFlightMinutes) {
      c.add(
        ptr('legs', i, 'arrival'),
        'flight_duration',
        `Flight time is ${Math.round(minutes)} minutes; supported range is ${LIMITS.minFlightMinutes}–${LIMITS.maxFlightMinutes} minutes.`,
        'Check the dates and UTC offsets of departure and arrival.',
      );
      ok = false;
    }
    return ok ? { dep, arr } : null;
  });

  // Connections.
  for (let i = 1; i < legs.length; i++) {
    const prev = legs[i - 1]!;
    const leg = legs[i]!;
    if (leg.from !== prev.to) {
      c.add(
        ptr('legs', i, 'from'),
        'disconnected_legs',
        `Leg ${i} departs from ${leg.from} but leg ${i - 1} arrives at ${prev.to}.`,
        'Legs must be connected. Add the missing flight or create a separate scene.',
      );
    }
    const a = times[i - 1];
    const b = times[i];
    if (a && b && b.dep.utcMs < a.arr.utcMs) {
      c.add(
        ptr('legs', i, 'departure'),
        'overlapping_legs',
        `Leg ${i} departs (${formatUtc(b.dep.utcMs)} UTC) before leg ${i - 1} arrives (${formatUtc(a.arr.utcMs)} UTC).`,
        'Order legs chronologically and check dates and offsets.',
      );
    }
  }
  const first = times[0];
  const last = times[times.length - 1];
  if (first && last && (last.arr.utcMs - first.dep.utcMs) / 86_400_000 > LIMITS.maxJourneyDays) {
    c.add('/legs', 'journey_too_long', `The journey spans more than ${LIMITS.maxJourneyDays} days.`, 'Split it into separate scenes.');
  }

  // Presentation references.
  const p = spec.presentation ?? {};
  const legIds = new Set(legs.map((l) => l.id));
  for (const key of ['legWeights', 'stopHolds'] as const) {
    for (const legId of Object.keys(p[key] ?? {})) {
      if (!legIds.has(legId)) {
        c.add(ptr('presentation', key, legId), 'unknown_leg_reference', `No leg has id "${legId}".`, `Leg ids: ${[...legIds].join(', ')}.`);
      }
    }
  }
  const finalId = legs[legs.length - 1]!.id;
  if (p.stopHolds && finalId in p.stopHolds) {
    c.add(ptr('presentation', 'stopHolds', finalId), 'hold_on_final_leg', `"${finalId}" is the final leg; it has no connection.`, 'Use presentation.endHoldSeconds for the final hold.');
  }

  if (c.count > 0) return { ok: false, issues: c.issues };

  // Duration budget and per-leg allocation.
  const startHold = p.startHoldSeconds ?? DEFAULTS.startHoldSeconds;
  const endHold = p.endHoldSeconds ?? DEFAULTS.endHoldSeconds;
  const stopHolds = legs.map((leg, i) => (i === legs.length - 1 ? 0 : (p.stopHolds?.[leg.id] ?? DEFAULTS.stopHoldSeconds)));
  const holdsTotal = startHold + endHold + stopHolds.reduce((s, x) => s + x, 0);
  let duration: number;
  if (p.durationSeconds !== undefined) duration = p.durationSeconds;
  else {
    const flight = Math.max(DEFAULTS.minFlightSeconds, DEFAULTS.secondsPerLeg * legs.length);
    duration = Math.min(LIMITS.maxDurationSeconds, Math.max(LIMITS.minDurationSeconds, holdsTotal + flight));
  }
  const flightTotal = duration - holdsTotal;
  const required = holdsTotal + LIMITS.minLegSeconds * legs.length;

  const angles = legs.map((leg) => {
    const a = airports[leg.from]!;
    const b = airports[leg.to]!;
    return centralAngle(latLonToVec(a.lat, a.lon), latLonToVec(b.lat, b.lon));
  });
  const sqrtAngles = angles.map((a) => Math.sqrt(a));
  const meanSqrt = sqrtAngles.reduce((s, x) => s + x, 0) / legs.length;
  const weights = legs.map((leg, i) => p.legWeights?.[leg.id] ?? sqrtAngles[i]! / meanSqrt);
  const weightSum = weights.reduce((s, x) => s + x, 0);
  const flightSeconds = weights.map((w) => (flightTotal * w) / weightSum);
  const shortest = Math.min(...flightSeconds);
  if (flightTotal <= 0 || shortest < LIMITS.minLegSeconds - 1e-9) {
    const path = p.durationSeconds !== undefined ? '/presentation/durationSeconds' : '/presentation';
    const needed = Math.ceil(holdsTotal + (LIMITS.minLegSeconds * weightSum) / Math.min(...weights));
    const fix =
      needed <= LIMITS.maxDurationSeconds
        ? `Set durationSeconds to at least ${needed}, reduce holds, or raise the weight of the shortest leg.`
        : required <= LIMITS.maxDurationSeconds
          ? 'Reduce holds or make legWeights more even.'
          : 'Reduce holds or the number of legs.';
    c.add(
      path,
      'duration_budget',
      `After ${round(holdsTotal)} s of holds, ${round(Math.max(0, flightTotal))} s remain for ${legs.length} flight(s); every flight needs at least ${LIMITS.minLegSeconds} s.`,
      fix,
    );
    return { ok: false, issues: c.issues };
  }

  // Rounded shares, with the last flight taking up the rounding so the parts add up to the duration exactly.
  const roundedSeconds = flightSeconds.map((x) => round(x, 6));
  roundedSeconds[roundedSeconds.length - 1] = round(
    flightTotal - roundedSeconds.slice(0, -1).reduce((sum, x) => sum + x, 0),
    6,
  );

  const normalizedLegs: NormalizedLeg[] = legs.map((leg: LegSpec, i) => {
    const t = times[i]!;
    return {
      id: leg.id,
      from: leg.from,
      to: leg.to,
      departureUtc: formatUtc(t.dep.utcMs),
      arrivalUtc: formatUtc(t.arr.utcMs),
      departureLocal: formatLocalTimestamp(t.dep.utcMs, t.dep.offsetMinutes),
      arrivalLocal: formatLocalTimestamp(t.arr.utcMs, t.arr.offsetMinutes),
      aircraft: leg.aircraft as AircraftType,
      distanceKm: round(angles[i]! * EARTH_RADIUS_KM, 1),
      weight: round(weights[i]!, 6),
      flightSeconds: roundedSeconds[i]!,
      holdAfterSeconds: stopHolds[i]!,
    };
  });

  // Re-derive the duration from rounded parts so the normalized record is self-consistent.
  const normalizedDuration = round(
    startHold + endHold + normalizedLegs.reduce((s, l) => s + l.flightSeconds + l.holdAfterSeconds, 0),
    6,
  );

  const normalized: NormalizedSceneV1 = {
    schemaVersion: 1,
    title: spec.title?.trim() ?? null,
    airports: Object.fromEntries(Object.keys(airports).sort().map((code) => [code, airports[code]!])),
    legs: normalizedLegs,
    presentation: {
      durationSeconds: normalizedDuration,
      startHoldSeconds: startHold,
      endHoldSeconds: endHold,
      fps: FPS,
    },
    environment: environment(spec.environment?.weather ?? DEFAULTS.weather, options.now),
    assets: {
      style: spec.assets?.style ?? DEFAULTS.style,
    },
    seed: spec.seed ?? DEFAULTS.seed,
    compatibility: {
      schemaVersion: 1,
      rendererVersion: RENDERER_VERSION,
      assetManifestVersion: ASSET_MANIFEST_VERSION,
      airportDataVersion: options.airportDataVersion,
    },
  };
  return { ok: true, spec, normalized };
}

function environment(weather: WeatherTreatment, now: number | undefined): NormalizedSceneV1['environment'] {
  return weather === 'clouds' && now !== undefined ? { weather, cloudRun: pinnedCloudRun(now) } : { weather };
}

function round(x: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

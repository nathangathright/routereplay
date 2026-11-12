import { AIRPORT_DATA_VERSION, lookupAirport } from '../src/server/airports';
import { validateScene } from '../src/shared/scene/validate';
import type { Airport, NormalizedSceneV1, SceneSpecV1, ValidationIssue } from '../src/shared/scene/types';

export const opts = { lookupAirport, airportDataVersion: AIRPORT_DATA_VERSION };

export function normalize(spec: unknown): NormalizedSceneV1 {
  const r = validateScene(spec, opts);
  if (!r.ok) throw new Error('Expected valid spec: ' + JSON.stringify(r.issues, null, 2));
  return r.normalized;
}

export function issues(spec: unknown, lookup = opts): ValidationIssue[] {
  const r = validateScene(spec, lookup);
  if (r.ok) throw new Error('Expected invalid spec');
  return r.issues;
}

export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export function leg(id: string, from: string, to: string, departure: string, arrival: string, aircraft = 'A320') {
  return { id, from, to, departure, arrival, aircraft };
}

export function spec(legs: ReturnType<typeof leg>[], extra: Partial<SceneSpecV1> = {}): SceneSpecV1 {
  return { schemaVersion: 1, legs, ...extra } as SceneSpecV1;
}

/** Synthetic airports for geometry edge cases (UTC zones so offsets are trivial). */
export function syntheticLookup(extra: Airport[]) {
  const map = new Map(extra.map((a) => [a.code, a]));
  return {
    lookupAirport: (code: string) => map.get(code) ?? lookupAirport(code),
    airportDataVersion: 'test',
  };
}

export const synthetic = (code: string, lat: number, lon: number): Airport => ({
  code,
  name: `Synthetic ${code}`,
  city: 'Nowhere',
  country: 'ZZ',
  lat,
  lon,
  timeZone: 'UTC',
});

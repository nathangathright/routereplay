/**
 * Traces train, bus, car, and ferry legs along real railways, roads, and ferry lines when a journey is saved, so
 * the scene doesn't draw a train across the sea. Routes come from OpenStreetMap through public routing services:
 *
 * - train: BRouter's `rail` profile (brouter.de), which follows railway tracks;
 * - bus and car: OSRM's car profile (routing.openstreetmap.de, run by FOSSGIS);
 * - ferry: the same car profile, kept only when most of the route is a mapped ferry line; then the foot
 *   profile, which also knows passenger-only ferries.
 *
 * The route is simplified, stored in the normalized record as an encoded polyline, and pinned: later saves keep
 * it while the leg's mode and airports are unchanged. A lookup never blocks saving. When no route is found, or
 * the service doesn't answer, the leg is drawn as a great circle and the save returns a warning.
 */
import { distanceKm } from '../shared/geo/greatCircle';
import { type LatLon, decodePolyline, encodePolyline, pathLengthKm, simplifyPath } from '../shared/geo/polyline';
import type { SurfaceMode } from '../shared/scene/constants';
import type { Airport, NormalizedLeg, NormalizedSceneV1 } from '../shared/scene/types';
import type { SceneWarning } from '../shared/scene/warnings';

/** Simplification tolerance: a tenth of a pixel at the scene's closest zoom (about 5 km a pixel at 1080p). */
export const ROUTE_TOLERANCE_KM = 0.5;
/** Most points stored for one route; the tolerance doubles until a route fits. */
export const MAX_ROUTE_POINTS = 1500;
/** A route that starts or ends farther than this from its airport was found on some other network. */
export const MAX_SNAP_KM = 50;
/** A route longer than this many times the straight distance (plus 50 km) is a wrong turn, not the trip. */
export const MAX_DETOUR_RATIO = 4;
/** Share of a ferry leg's route that must be on a ferry line. */
export const MIN_FERRY_SHARE = 0.5;

const BROUTER = 'https://brouter.de/brouter';
const OSRM = 'https://routing.openstreetmap.de';
const USER_AGENT = 'RouteReplay/1.0 (+https://routereplay.video/acknowledgments)';
const TIMEOUT_MS = 10_000;
const FOUND_TTL_S = 30 * 86_400;
const NOT_FOUND_TTL_S = 86_400;

type Lookup =
  | { kind: 'found'; path: string }
  | { kind: 'not_found'; reason: string }
  | { kind: 'unavailable'; reason: string };

type Raw = { kind: 'found'; points: LatLon[]; ferryKm?: number; km: number } | Exclude<Lookup, { kind: 'found' }>;

export interface RoutingDeps {
  fetch: typeof fetch;
  /** Edge cache for lookups, shared by every draft. Null where there is none (tests, workers.dev). */
  cache?: Cache | null;
  /** Spends one request from the shared daily budget; false when it is used up. */
  allow?: () => Promise<boolean>;
  airportDataVersion: string;
}

const NOUN: Record<SurfaceMode, string> = { train: 'railway', bus: 'road', car: 'road', ferry: 'ferry' };

async function get(url: string, deps: RoutingDeps): Promise<Response | { kind: 'unavailable'; reason: string }> {
  if (deps.allow && !(await deps.allow())) return { kind: 'unavailable', reason: 'daily routing budget used up' };
  try {
    return await deps.fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return { kind: 'unavailable', reason: e instanceof Error ? e.message : 'request failed' };
  }
}

/** Both services answer 400 when there is no route; anything else that isn't 200 is the service failing. */
async function failure(res: Response): Promise<Raw> {
  const text = (await res.text()).slice(0, 200);
  return res.status === 400 ? { kind: 'not_found', reason: text } : { kind: 'unavailable', reason: `HTTP ${res.status}` };
}

/**
 * BRouter returns every track node (about 13 per km, with elevations and a per-segment log): some 1 KB per km.
 * Reading and simplifying costs about 0.4 ms per 100 km in a warm isolate, almost all of it JSON.parse, and
 * several times that in a fresh one (docs/budgets.md). A free-plan Worker has 10 ms of CPU per request, so
 * longer rail routes are drawn straight rather than risk failing the save.
 */
export const MAX_RAIL_RESPONSE_CHARS = 1_500_000;
/** Nodes this close to the last one kept (in degrees, squared) are dropped while reading: well under the tolerance. */
const THIN_DEG2 = 0.001 ** 2;

async function brouterRail(from: Airport, to: Airport, deps: RoutingDeps): Promise<Raw> {
  const lonlats = `${from.lon},${from.lat}|${to.lon},${to.lat}`;
  const res = await get(`${BROUTER}?lonlats=${encodeURIComponent(lonlats)}&profile=rail&alternativeidx=0&format=geojson`, deps);
  if (!(res instanceof Response)) return res;
  if (!res.ok) return failure(res);
  try {
    const text = await res.text();
    if (text.length > MAX_RAIL_RESPONSE_CHARS) return { kind: 'not_found', reason: 'route too long to trace' };
    const body = JSON.parse(text) as {
      features?: { properties?: { 'track-length'?: string }; geometry?: { coordinates?: number[][] } }[];
    };
    const feature = body.features?.[0];
    const coords = feature?.geometry?.coordinates ?? [];
    const points: LatLon[] = [];
    for (let i = 0; i < coords.length; i++) {
      const c = coords[i]!;
      const lon = c[0]!;
      const lat = c[1]!;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const prev = points[points.length - 1];
      if (prev && i < coords.length - 1 && (lat - prev[0]) ** 2 + (lon - prev[1]) ** 2 < THIN_DEG2) continue;
      points.push([lat, lon]);
    }
    if (points.length < 2) return { kind: 'not_found', reason: 'empty route' };
    const km = Number(feature?.properties?.['track-length']) / 1000;
    return { kind: 'found', points, km: Number.isFinite(km) && km > 0 ? km : pathLengthKm(points) };
  } catch {
    return { kind: 'unavailable', reason: 'unreadable response' };
  }
}

async function osrm(profile: 'car' | 'foot', from: Airport, to: Airport, deps: RoutingDeps, steps: boolean): Promise<Raw> {
  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const res = await get(
    `${OSRM}/routed-${profile}/route/v1/driving/${coords}?overview=full&geometries=polyline${steps ? '&steps=true' : ''}`,
    deps,
  );
  if (!(res instanceof Response)) return res;
  if (!res.ok) return failure(res);
  try {
    const body = (await res.json()) as {
      code?: string;
      routes?: { geometry?: string; distance?: number; legs?: { steps?: { mode?: string; distance?: number }[] }[] }[];
    };
    const route = body.routes?.[0];
    if (body.code !== 'Ok' || !route?.geometry) return { kind: 'not_found', reason: body.code ?? 'no route' };
    const points = decodePolyline(route.geometry);
    if (points.length < 2) return { kind: 'not_found', reason: 'empty route' };
    const ferryKm = steps
      ? (route.legs ?? []).flatMap((l) => l.steps ?? []).reduce((s, x) => s + (x.mode === 'ferry' ? (x.distance ?? 0) : 0), 0) / 1000
      : undefined;
    return { kind: 'found', points, km: (route.distance ?? 0) / 1000 || pathLengthKm(points), ferryKm };
  } catch {
    return { kind: 'unavailable', reason: 'unreadable response' };
  }
}

/** A ferry leg keeps a route only if it mostly crosses water on a ferry line. */
async function ferry(from: Airport, to: Airport, deps: RoutingDeps): Promise<Raw> {
  let last: Raw = { kind: 'not_found', reason: 'no ferry line' };
  for (const profile of ['car', 'foot'] as const) {
    const r = await osrm(profile, from, to, deps, true);
    if (r.kind === 'found' && (r.ferryKm ?? 0) >= MIN_FERRY_SHARE * r.km) return r;
    if (r.kind === 'unavailable') return r;
    last = r.kind === 'found' ? { kind: 'not_found', reason: 'route is not mostly on a ferry line' } : r;
  }
  return last;
}

function lookupRaw(mode: SurfaceMode, from: Airport, to: Airport, deps: RoutingDeps): Promise<Raw> {
  if (mode === 'train') return brouterRail(from, to, deps);
  if (mode === 'ferry') return ferry(from, to, deps);
  return osrm('car', from, to, deps, false);
}

/** Checks a found route against the airports it joins, then simplifies and encodes it from airport to airport. */
export function finishRoute(points: LatLon[], km: number, from: Airport, to: Airport): Lookup {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const startKm = distanceKm(from.lat, from.lon, first[0], first[1]);
  const endKm = distanceKm(to.lat, to.lon, last[0], last[1]);
  if (startKm > MAX_SNAP_KM || endKm > MAX_SNAP_KM) {
    return { kind: 'not_found', reason: `route ends ${Math.round(Math.max(startKm, endKm))} km from the airport` };
  }
  const straightKm = distanceKm(from.lat, from.lon, to.lat, to.lon);
  if (km > MAX_DETOUR_RATIO * straightKm + 50) {
    return { kind: 'not_found', reason: `route is ${Math.round(km)} km for ${Math.round(straightKm)} km straight` };
  }
  let tolerance = ROUTE_TOLERANCE_KM;
  let simple = simplifyPath(points, tolerance);
  while (simple.length > MAX_ROUTE_POINTS) simple = simplifyPath(points, (tolerance *= 2));
  return { kind: 'found', path: encodePolyline([[from.lat, from.lon], ...simple, [to.lat, to.lon]]) };
}

async function lookup(mode: SurfaceMode, from: Airport, to: Airport, deps: RoutingDeps): Promise<Lookup> {
  const key = `https://routes.routereplay.invalid/v1/${mode}/${from.code}-${to.code}?airports=${encodeURIComponent(deps.airportDataVersion)}`;
  const hit = await deps.cache?.match(key).catch(() => undefined);
  if (hit) {
    try {
      return (await hit.json()) as Lookup;
    } catch {
      // Fall through and look it up again.
    }
  }
  const raw = await lookupRaw(mode, from, to, deps);
  const result: Lookup = raw.kind === 'found' ? finishRoute(raw.points, raw.km, from, to) : raw;
  if (deps.cache && result.kind !== 'unavailable') {
    const ttl = result.kind === 'found' ? FOUND_TTL_S : NOT_FOUND_TTL_S;
    const response = new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` },
    });
    await deps.cache.put(key, response).catch(() => undefined);
  }
  return result;
}

function routeWarning(i: number, leg: NormalizedLeg, result: Exclude<Lookup, { kind: 'found' }>): SceneWarning {
  const mode = leg.mode!;
  const route = `${leg.from} → ${leg.to}`;
  if (result.kind === 'unavailable') {
    return {
      path: `/legs/${i}/mode`,
      code: 'route_unavailable',
      message: `The route lookup for the ${mode} ${route} didn't answer, so the ${mode} is drawn as a straight line for now.`,
      hint: 'Save the journey again later to retry. Nothing in the spec needs to change.',
    };
  }
  return {
    path: `/legs/${i}/mode`,
    code: 'route_not_found',
    message: `No ${NOUN[mode]} route ${route} was found in OpenStreetMap, so the ${mode} is drawn as a straight line.`,
    hint: `Check the mode and that both airports are the nearest ones to the ${mode === 'ferry' ? 'terminals' : 'stations'}. If they are right, nothing needs fixing.`,
  };
}

/**
 * Gives each surface leg its route. A leg whose mode and airports match a routed leg in `previous` (the draft's
 * current record) keeps that route without a new lookup.
 */
export async function routeSurfaceLegs(
  scene: NormalizedSceneV1,
  previous: NormalizedSceneV1 | null,
  deps: RoutingDeps,
): Promise<{ scene: NormalizedSceneV1; warnings: SceneWarning[] }> {
  const warnings: SceneWarning[] = [];
  const legs: NormalizedLeg[] = [];
  // One at a time: the services ask for no more than about a request a second.
  for (const [i, leg] of scene.legs.entries()) {
    if (leg.mode === undefined) {
      legs.push(leg);
      continue;
    }
    const kept = previous?.legs.find((p) => p.path && p.mode === leg.mode && p.from === leg.from && p.to === leg.to);
    if (kept) {
      legs.push({ ...leg, path: kept.path });
      continue;
    }
    const result = await lookup(leg.mode, scene.airports[leg.from]!, scene.airports[leg.to]!, deps);
    if (result.kind === 'found') legs.push({ ...leg, path: result.path });
    else {
      legs.push(leg);
      warnings.push(routeWarning(i, leg, result));
    }
  }
  return { scene: { ...scene, legs }, warnings };
}

import { describe, expect, it } from 'vitest';
import { AIRPORT_DATA_VERSION, lookupAirport } from '../src/server/airports';
import { MAX_RAIL_RESPONSE_CHARS, type RoutingDeps, routeSurfaceLegs } from '../src/server/surfaceRoutes';
import { centralAngle } from '../src/shared/geo/greatCircle';
import { type LatLon, decodePolyline, encodePolyline, simplifyPath } from '../src/shared/geo/polyline';
import { PathTrack } from '../src/shared/geo/track';
import { dot, latLonToVec, vecToLatLon } from '../src/shared/geo/vec';
import type { NormalizedSceneV1 } from '../src/shared/scene/types';
import { buildTimeline, evaluate } from '../src/shared/timeline/evaluate';
import { leg, normalize, spec, surface } from './helpers';

const akl = lookupAirport('AKL')!;
const wlg = lookupAirport('WLG')!;
const pcn = lookupAirport('PCN')!;

describe('encoded polylines', () => {
  it("round-trips Google's reference example", () => {
    const points: LatLon[] = [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ];
    expect(encodePolyline(points)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual(points);
  });

  it('rejects malformed input instead of returning stray points', () => {
    expect(() => decodePolyline('_p~iF~ps|U_')).toThrow();
    expect(() => decodePolyline('_p~iF \u0000')).toThrow();
  });

  it('simplifies to the tolerance, keeping both ends and real bends', () => {
    // Straight north for 100 km in 1 km steps, then a 20 km jog east: only the ends and the corner matter.
    const line: LatLon[] = Array.from({ length: 101 }, (_, i) => [-40 + i * 0.009, 175] as LatLon);
    line.push([-39.1, 175.2]);
    const simple = simplifyPath(line, 0.5);
    expect(simple).toEqual([line[0], line[100], line[101]]);
  });
});

describe('PathTrack', () => {
  // Two equal legs east along the equator, then north: a right-angle corner halfway along.
  const track = PathTrack.fromPolyline(
    encodePolyline([
      [0, 0],
      [0, 1],
      [1, 1],
    ]),
  )!;

  it('runs from end to end at constant speed along its length', () => {
    expect(dot(track.a, latLonToVec(0, 0))).toBeCloseTo(1, 12);
    expect(dot(track.b, latLonToVec(1, 1))).toBeCloseTo(1, 12);
    expect(track.angle).toBeCloseTo(2 * (Math.PI / 180), 6);
    expect(track.corners).toHaveLength(1);
    expect(track.corners[0]).toBeCloseTo(0.5, 4);
    const corner = vecToLatLon(track.at(track.corners[0]!));
    expect(corner.lat).toBeCloseTo(0, 6);
    expect(corner.lon).toBeCloseTo(1, 6);
    const quarter = vecToLatLon(track.at(0.25));
    expect(quarter.lon).toBeCloseTo(0.5, 3);
  });

  it('points along each segment, and between them at the corner', () => {
    const east = track.tangent(0.2);
    const north = track.tangent(0.8);
    // East at (0°, 0.4°) and north at (0.6°, 1°): within a degree of -z and +y in this frame.
    expect(dot(east, [0, 0, -1])).toBeGreaterThan(Math.cos(Math.PI / 180));
    expect(dot(north, [0, 1, 0])).toBeGreaterThan(Math.cos(Math.PI / 180));
    const bisector = track.tangent(track.corners[0]!);
    expect(dot(bisector, east)).toBeCloseTo(Math.SQRT1_2, 3);
    expect(dot(bisector, north)).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('merges repeated points, and refuses a route with nowhere to go', () => {
    expect(PathTrack.fromPolyline(encodePolyline([[0, 0], [0, 0], [0, 1]]))!.corners).toEqual([]);
    expect(PathTrack.fromPolyline(encodePolyline([[0, 0], [0, 0]]))).toBeNull();
    expect(PathTrack.fromPolyline('not a polyline')).toBeNull();
  });
});

/** A railway from AKL that swings 60 km west of the straight line before reaching WLG. */
const RAIL: LatLon[] = [
  [-37.0, 174.82],
  [-38.0, 175.0],
  [-39.0, 174.6],
  [-40.3, 175.6],
  [-41.28, 174.78],
];
const brouter = (points: LatLon[] = RAIL) =>
  JSON.stringify({
    type: 'FeatureCollection',
    features: [{ properties: { 'track-length': '640000' }, geometry: { type: 'LineString', coordinates: points.map(([la, lo]) => [lo, la, 10]) } }],
  });
/** The Wellington–Picton ferry: a short drive, 99 km on the ferry line, and another short drive. */
const FERRY: LatLon[] = [
  [-41.327, 174.805],
  [-41.28, 174.78],
  [-41.2, 174.4],
  [-41.27, 174.0],
  [-41.346, 173.956],
];
const osrm = (points: LatLon[], km: number, ferryKm = 0) =>
  JSON.stringify({
    code: 'Ok',
    routes: [
      {
        geometry: encodePolyline(points),
        distance: km * 1000,
        legs: [{ steps: [{ mode: 'driving', distance: (km - ferryKm) * 1000 }, { mode: 'ferry', distance: ferryKm * 1000 }] }],
      },
    ],
  });

function fakeDeps(respond: (url: string) => Response | Promise<Response>, extra: Partial<RoutingDeps> = {}) {
  const urls: string[] = [];
  const deps: RoutingDeps = {
    fetch: (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return respond(String(input));
    }) as typeof fetch,
    airportDataVersion: AIRPORT_DATA_VERSION,
    ...extra,
  };
  return { deps, urls };
}

const nz = () =>
  normalize(
    spec([
      leg('sfo-akl', 'SFO', 'AKL', '2031-10-17T23:00:00-07:00', '2031-10-19T07:15:00+13:00', 'B789'),
      surface('akl-wlg', 'AKL', 'WLG', '2031-10-20T07:45:00+13:00', '2031-10-20T18:25:00+13:00', 'train'),
      surface('wlg-pcn', 'WLG', 'PCN', '2031-10-22T08:45:00+13:00', '2031-10-22T12:15:00+13:00', 'ferry'),
    ]),
  );

const pathOf = (scene: NormalizedSceneV1, id: string) => scene.legs.find((l) => l.id === id)!.path;

describe('route lookups', () => {
  it('traces trains along the railway and ferries along the ferry line, airport to airport', async () => {
    const { deps, urls } = fakeDeps((url) => new Response(url.includes('brouter') ? brouter() : osrm(FERRY, 117, 99)));
    const { scene, warnings } = await routeSurfaceLegs(nz(), null, deps);
    expect(warnings).toEqual([]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(
      'https://brouter.de/brouter?lonlats=174.78633%2C-37.01199%7C174.80686%2C-41.32684&profile=rail&alternativeidx=0&format=geojson',
    );
    expect(urls[1]).toMatch(/^https:\/\/routing\.openstreetmap\.de\/routed-car\/route\/v1\/driving\/174\.80.*steps=true/);
    const rail = decodePolyline(pathOf(scene, 'akl-wlg')!);
    // From the airport, along every bend of the line, to the airport.
    expect(rail[0]).toEqual([Math.round(akl.lat * 1e5) / 1e5, Math.round(akl.lon * 1e5) / 1e5]);
    expect(rail.slice(1, -1)).toEqual(RAIL);
    expect(rail[rail.length - 1]).toEqual([Math.round(wlg.lat * 1e5) / 1e5, Math.round(wlg.lon * 1e5) / 1e5]);
    expect(decodePolyline(pathOf(scene, 'wlg-pcn')!)).toHaveLength(FERRY.length + 2);
    // Flights are never looked up.
    expect(pathOf(scene, 'sfo-akl')).toBeUndefined();
  });

  it('routes buses and cars by road', async () => {
    const road: LatLon[] = [
      [-41.35, 173.96],
      [-42.4, 173.68],
      [-43.49, 172.53],
    ];
    const s = normalize(spec([surface('pcn-chc', 'PCN', 'CHC', '2031-10-22T13:30:00+13:00', '2031-10-22T19:30:00+13:00', 'bus')]));
    const { deps, urls } = fakeDeps(() => new Response(osrm(road, 331)));
    const { scene } = await routeSurfaceLegs(s, null, deps);
    expect(urls).toEqual([expect.stringMatching(/routed-car\/route\/v1\/driving\/173\.95.*overview=full&geometries=polyline$/)]);
    expect(decodePolyline(scene.legs[0]!.path!).slice(1, -1)).toEqual(road);
  });

  it('keeps a ferry route only when it mostly follows a ferry line, trying the foot network second', async () => {
    const drive: LatLon[] = [
      [-41.327, 174.805],
      [-40.0, 175.5],
      [-41.346, 173.956],
    ];
    const { deps, urls } = fakeDeps((url) => new Response(url.includes('routed-car') ? osrm(drive, 300, 20) : osrm(FERRY, 120, 99)));
    const s = nz();
    s.legs = s.legs.filter((l) => l.id === 'wlg-pcn');
    const { scene } = await routeSurfaceLegs(s, null, deps);
    expect(urls.map((u) => u.match(/routed-(\w+)/)![1])).toEqual(['car', 'foot']);
    expect(decodePolyline(scene.legs[0]!.path!).slice(1, -1)).toEqual(FERRY);
  });

  it('draws a straight line, with a warning, when there is no route', async () => {
    const { deps } = fakeDeps((url) =>
      url.includes('brouter') ? new Response('target island detected for section 0', { status: 400 }) : new Response(osrm(FERRY, 300, 20)),
    );
    const { scene, warnings } = await routeSurfaceLegs(nz(), null, deps);
    expect(scene.legs.map((l) => l.path)).toEqual([undefined, undefined, undefined]);
    expect(warnings.map((w) => [w.code, w.path])).toEqual([
      ['route_not_found', '/legs/1/mode'],
      ['route_not_found', '/legs/2/mode'],
    ]);
    expect(warnings[0]!.message).toBe('No railway route AKL → WLG was found in OpenStreetMap, so the train is drawn as a straight line.');
  });

  it('rejects routes found on some other network or by a long detour', async () => {
    const elsewhere: LatLon[] = [
      [-36.0, 174.0],
      [-41.28, 174.78],
    ];
    const roundabout: LatLon[] = [
      [-37.0, 174.82],
      [-30.0, 170.0],
      [-41.28, 174.78],
    ];
    for (const [points, km] of [
      [elsewhere, 600],
      [roundabout, 3000],
    ] as const) {
      const { deps } = fakeDeps(() =>
        new Response(
          JSON.stringify({ features: [{ properties: { 'track-length': String(km * 1000) }, geometry: { coordinates: points.map(([a, b]) => [b, a]) } }] }),
        ),
      );
      const s = nz();
      s.legs = s.legs.filter((l) => l.id === 'akl-wlg');
      const { scene, warnings } = await routeSurfaceLegs(s, null, deps);
      expect(scene.legs[0]!.path).toBeUndefined();
      expect(warnings.map((w) => w.code)).toEqual(['route_not_found']);
    }
  });

  it('treats an unreachable service, an error, or a spent budget as unavailable, to retry on the next save', async () => {
    const cases: [string, Partial<RoutingDeps>, (url: string) => Response | Promise<Response>][] = [
      ['network error', {}, () => Promise.reject(new TypeError('fetch failed'))],
      ['server error', {}, () => new Response('busy', { status: 503 })],
      ['budget', { allow: async () => false }, () => new Response(brouter())],
    ];
    for (const [, extra, respond] of cases) {
      const { deps } = fakeDeps(respond, extra);
      const { scene, warnings } = await routeSurfaceLegs(nz(), null, deps);
      expect(scene.legs.every((l) => l.path === undefined)).toBe(true);
      expect(warnings.map((w) => w.code)).toEqual(['route_unavailable', 'route_unavailable']);
    }
  });

  it('draws rail routes too long to trace within the CPU budget as straight lines', async () => {
    const { deps } = fakeDeps(() => new Response(' '.repeat(MAX_RAIL_RESPONSE_CHARS + 1)));
    const s = nz();
    s.legs = s.legs.filter((l) => l.id === 'akl-wlg');
    const { warnings } = await routeSurfaceLegs(s, null, deps);
    expect(warnings.map((w) => w.code)).toEqual(['route_not_found']);
  });

  it('keeps a saved route while the leg keeps its mode and airports, without asking again', async () => {
    const first = fakeDeps((url) => new Response(url.includes('brouter') ? brouter() : osrm(FERRY, 117, 99)));
    const saved = (await routeSurfaceLegs(nz(), null, first.deps)).scene;
    const again = fakeDeps(() => {
      throw new Error('should not be called');
    });
    const revised = nz();
    revised.legs[1]!.id = 'train-renamed';
    const { scene } = await routeSurfaceLegs(revised, saved, again.deps);
    expect(again.urls).toEqual([]);
    expect(scene.legs.map((l) => l.path)).toEqual(saved.legs.map((l) => l.path));
    // A changed mode is a different route.
    const bus = nz();
    bus.legs[1]!.mode = 'bus';
    const third = fakeDeps(() => new Response(osrm(RAIL, 650)));
    await routeSurfaceLegs(bus, saved, third.deps);
    expect(third.urls).toEqual([expect.stringContaining('routed-car')]);
  });

  it('shares lookups between drafts through the cache', async () => {
    const store = new Map<string, string>();
    const cache = {
      match: async (k: string) => (store.has(k) ? new Response(store.get(k)) : undefined),
      put: async (k: string, r: Response) => void store.set(k, await r.text()),
    } as unknown as Cache;
    const first = fakeDeps((url) => new Response(url.includes('brouter') ? brouter() : osrm(FERRY, 117, 99)), { cache });
    const a = await routeSurfaceLegs(nz(), null, first.deps);
    const second = fakeDeps(() => Promise.reject(new Error('should not be called')), { cache });
    const b = await routeSurfaceLegs(nz(), null, second.deps);
    expect(second.urls).toEqual([]);
    expect(b.scene).toEqual(a.scene);
    expect([...store.keys()][0]).toMatch(/^https:\/\/routes\.routereplay\.invalid\/v1\/train\/AKL-WLG\?airports=/);
  });
});

describe('timeline along a route', () => {
  it('moves the marker along the looked-up route, not the great circle', async () => {
    const { deps } = fakeDeps((url) => new Response(url.includes('brouter') ? brouter() : osrm(FERRY, 117, 99)));
    const { scene } = await routeSurfaceLegs(nz(), null, deps);
    const tl = buildTimeline(scene);
    const i = scene.legs.findIndex((l) => l.id === 'akl-wlg');
    expect(tl.legs[i]!.track).not.toBe(tl.legs[i]!.circle);
    const seg = tl.segments.find((x) => x.kind === 'surface' && x.leg === i)!;
    let farthest = 0;
    for (let u = 0; u <= 1; u += 0.05) {
      const s = evaluate(tl, seg.t0 + u * (seg.t1 - seg.t0));
      expect(s.aircraft.altitude).toBe(0);
      const p = tl.legs[i]!.track.at(s.legProgress);
      expect(dot(p, s.aircraft.ground)).toBeCloseTo(1, 12);
      farthest = Math.max(farthest, centralAngle(s.aircraft.ground, tl.legs[i]!.circle.at(s.legProgress)));
    }
    // The railway's westward swing takes the marker tens of kilometres off the straight line.
    expect(farthest * 6371).toBeGreaterThan(30);
    // It starts and ends at the airports, so the stops before and after stay put.
    expect(centralAngle(tl.legs[i]!.track.a, latLonToVec(akl.lat, akl.lon)) * 6371).toBeLessThan(0.01);
    expect(centralAngle(tl.legs[i]!.track.b, latLonToVec(wlg.lat, wlg.lon)) * 6371).toBeLessThan(0.01);
    expect(pcn.timeZone).toBe('Pacific/Auckland');
  });

  it('ignores a path on a flight, and a damaged path', () => {
    const s = nz();
    s.legs[0]!.path = encodePolyline(RAIL);
    s.legs[1]!.path = 'garbage';
    const tl = buildTimeline(s);
    expect(tl.legs[0]!.track).toBe(tl.legs[0]!.circle);
    expect(tl.legs[1]!.track).toBe(tl.legs[1]!.circle);
  });
});

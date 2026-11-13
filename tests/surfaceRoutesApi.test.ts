import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Env, handle } from '../src/server/index';
import { decodePolyline, encodePolyline } from '../src/shared/geo/polyline';
import { leg, spec, surface } from './helpers';

/** Saving a journey traces its train, bus, car, and ferry legs; dry runs and unchanged legs don't. */

const ORIGIN = 'http://routereplay.test';
let mf: Miniflare;
let db: D1Database;
let env: Env;
let urls: string[];

const RAIL = JSON.stringify({
  features: [
    {
      properties: { 'track-length': '640000' },
      geometry: { coordinates: [[174.82, -37.0], [175.0, -38.0], [174.6, -39.0], [175.6, -40.3], [174.78, -41.28]] },
    },
  ],
});

const NZ = spec(
  [
    leg('sfo-akl', 'SFO', 'AKL', '2031-10-17T23:00:00-07:00', '2031-10-19T07:15:00+13:00', 'B789'),
    surface('akl-wlg', 'AKL', 'WLG', '2031-10-20T07:45:00+13:00', '2031-10-20T18:25:00+13:00', 'train'),
  ],
  { environment: { weather: 'omitted' } },
);

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'routereplay-routes-test',
      modules: true,
      script: 'export default { fetch() { return new Response("unused") } }',
      compatibilityDate: '2026-11-01',
      d1Databases: { DB: 'routereplay-routes-test' },
    }),
  );
  db = (await mf.getD1Database('DB', 'routereplay-routes-test')) as unknown as D1Database;
});

afterAll(async () => {
  await mf?.dispose();
});

beforeEach(async () => {
  const tables = ['scenes', 'scene_revisions', 'publications', 'deleted_publications', 'sessions', 'idempotency', 'rate_limits'];
  await db.batch(tables.map((t) => db.prepare(`DROP TABLE IF EXISTS ${t}`)));
  const sql = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url).pathname, 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  await db.batch(
    sql
      .split(/;\s*\n/)
      .map((s) => s.trim().replace(/;$/, ''))
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
  urls = [];
  env = {
    DB: db,
    ROUTE_FETCH: (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(RAIL);
    }) as typeof fetch,
  };
});

async function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await handle(
    new Request(ORIGIN + path, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    }),
    env,
  );
  return { status: res.status, json: (await res.json()) as any };
}

describe('route lookups through the API', () => {
  it('traces surface legs when a draft is created, and spends the shared budget', async () => {
    const r = await call('/api/v1/scenes', { body: NZ });
    expect(r.status).toBe(201);
    expect(urls).toHaveLength(1);
    expect(r.json.warnings.filter((w: any) => w.code.startsWith('route_'))).toEqual([]);
    const [flight, train] = r.json.normalized.legs;
    expect(flight.path).toBeUndefined();
    expect(decodePolyline(train.path)).toHaveLength(7);
    // The record the preview reads carries the same route.
    const read = await call(`/api/v1/scenes/${r.json.id}`, { token: r.json.credentials.edit });
    expect(read.json.normalized.legs[1].path).toBe(train.path);
    const budget = await db.prepare(`SELECT count FROM rate_limits WHERE bucket = 'route_lookup:all'`).first<{ count: number }>();
    expect(budget?.count).toBe(1);
  });

  it('keeps the route on later saves that leave the leg alone', async () => {
    const r = await call('/api/v1/scenes', { body: NZ });
    const path = r.json.normalized.legs[1].path;
    const revised = { ...NZ, title: 'Retitled' };
    const put = await call(`/api/v1/scenes/${r.json.id}`, { method: 'PUT', token: r.json.credentials.edit, body: { expectedRevision: 1, spec: revised } });
    expect(put.status).toBe(200);
    expect(urls).toHaveLength(1);
    expect(put.json.normalized.legs[1].path).toBe(path);
  });

  it('saves with a straight line and a warning when the lookup fails', async () => {
    env.ROUTE_FETCH = (async () => new Response('busy', { status: 503 })) as typeof fetch;
    const r = await call('/api/v1/scenes', { body: NZ });
    expect(r.status).toBe(201);
    expect(r.json.normalized.legs[1].path).toBeUndefined();
    expect(r.json.warnings.map((w: any) => [w.code, w.path])).toContainEqual(['route_unavailable', '/legs/1/mode']);
    expect(r.json.warnings.find((w: any) => w.code === 'route_unavailable').hint).toMatch(/Save the journey again later/);
  });

  it('never looks routes up for a dry run, or when routing is off', async () => {
    const v = await call('/api/v1/validate', { body: NZ });
    expect(v.status).toBe(200);
    expect(v.json.normalized.legs[1].path).toBeUndefined();
    expect(v.json.next.join(' ')).toMatch(/traced along railways, roads, and ferry lines when you save/);
    env.SURFACE_ROUTING = 'off';
    const r = await call('/api/v1/scenes', { body: NZ });
    expect(r.status).toBe(201);
    expect(r.json.normalized.legs[1].path).toBeUndefined();
    expect(urls).toEqual([]);
  });

  it('ignores a path sent in the spec: routes come only from the lookup', async () => {
    const forged = structuredClone(NZ) as any;
    forged.legs[1].path = encodePolyline([[0, 0], [1, 1]]);
    const r = await call('/api/v1/validate', { body: forged });
    expect(r.status).toBe(422);
    expect(r.json.error.issues[0]).toMatchObject({ path: '/legs/1/path', code: 'unknown_field' });
  });
});

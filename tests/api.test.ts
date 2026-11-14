import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ASSET_MANIFEST_VERSION } from '../src/shared/scene/constants';
import { EXAMPLE_SCENE } from '../src/shared/scene/examples';
import { type Env, handle } from '../src/server/index';
import { lookupAirport } from '../src/server/airports';
import { DOCS_VERSION, WORKFLOW_MD } from '../src/server/generated/content';
import { clone } from './helpers';
import { ACTIVITY_TTL_MS, type Activity, type ViewerReport, activityEvent, currentActivity, latestViewer } from '../src/server/liveState';

const ORIGIN = 'http://routereplay.test';
let mf: Miniflare;
let db: D1Database;
let env: Env;

const SHELL = '<!doctype html><html><head><title>Route Replay</title></head><body><div id="root"></div></body></html>';

async function resetDb() {
  const tables = ['scenes', 'scene_revisions', 'publications', 'deleted_publications', 'sessions', 'idempotency', 'rate_limits'];
  await db.batch(tables.map((t) => db.prepare(`DROP TABLE IF EXISTS ${t}`)));
  const sql = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url).pathname, 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim().replace(/;$/, ''))
    .filter(Boolean);
  await db.batch(statements.map((s) => db.prepare(s)));
}

beforeAll(async () => {
  // Real local D1 (workerd SQLite), the same engine `wrangler pages dev` uses.
  mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'routereplay-test',
      modules: true,
      script: 'export default { fetch() { return new Response("unused") } }',
      compatibilityDate: '2026-11-01',
      d1Databases: { DB: 'routereplay-test' },
    }),
  );
  db = (await mf.getD1Database('DB', 'routereplay-test')) as unknown as D1Database;
});

afterAll(async () => {
  await mf?.dispose();
});

beforeEach(async () => {
  await resetDb();
  env = {
    DB: db,
    ASSETS: { fetch: async () => new Response(SHELL, { headers: { 'content-type': 'text/html' } }) },
  };
});

type Init = { method?: string; body?: unknown; token?: string; headers?: Record<string, string>; raw?: string };

async function call(path: string, init: Init = {}) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let body: string | undefined;
  if (init.raw !== undefined) body = init.raw;
  else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['content-type'] ??= 'application/json';
  }
  const res = await handle(new Request(ORIGIN + path, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body }), env);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, status: res.status, json, text };
}

async function create(spec: unknown = EXAMPLE_SCENE, headers: Record<string, string> = {}) {
  const r = await call('/api/v1/scenes', { body: spec, headers });
  return r;
}

async function created() {
  const r = await create();
  expect(r.status).toBe(201);
  return { id: r.json.id as string, edit: r.json.credentials.edit as string, owner: r.json.credentials.owner as string, json: r.json };
}

async function allDbText(): Promise<string> {
  const tables = ['scenes', 'scene_revisions', 'publications', 'sessions', 'idempotency', 'rate_limits'];
  const rows = await Promise.all(tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
  return JSON.stringify(rows.map((r) => r.results));
}

describe('create and read', () => {
  it('creates a private draft with distinct credentials and a fragment-token preview link', async () => {
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.json.id).toMatch(/^[a-z0-9]{16}$/);
    expect(r.json.revision).toBe(1);
    expect(r.json.previewUrl).toBe(`${ORIGIN}/s/${r.json.id}#k=${r.json.credentials.edit}`);
    expect(r.json.credentials.edit).toMatch(/^rr_edit_/);
    expect(r.json.credentials.owner).toMatch(/^rr_owner_/);
    expect(r.json.credentials.edit).not.toBe(r.json.credentials.owner);
    expect(r.json.capabilities).toMatchObject({ role: 'owner', publish: true });
    expect(r.json.normalized.legs[0].departureUtc).toBe('2031-01-05T16:00:00Z');
    expect(r.res.headers.get('location')).toBe(`${ORIGIN}/api/v1/scenes/${r.json.id}`);
  });

  it('stores only credential hashes', async () => {
    const { edit, owner } = await created();
    const dump = await allDbText();
    expect(dump).not.toContain(edit);
    expect(dump).not.toContain(owner);
    expect(dump).not.toContain(edit.slice(8));
  });

  it('separates edit and owner capabilities and never returns credentials on reads', async () => {
    const { id, edit, owner } = await created();
    const asEdit = await call(`/api/v1/scenes/${id}`, { token: edit });
    expect(asEdit.status).toBe(200);
    expect(asEdit.json.capabilities).toEqual({ role: 'edit', read: true, edit: true, publish: false, delete: false, rotateEditCredential: false });
    expect(asEdit.json.previewUrl).toBe(`${ORIGIN}/s/${id}`);
    const asOwner = await call(`/api/v1/scenes/${id}`, { token: owner });
    expect(asOwner.json.capabilities.role).toBe('owner');
    for (const r of [asEdit, asOwner]) {
      expect(r.text).not.toMatch(/rr_(edit|owner)_/);
    }
  });

  it('rejects missing and wrong credentials without revealing existence', async () => {
    const { id } = await created();
    expect((await call(`/api/v1/scenes/${id}`)).status).toBe(401);
    const wrong = await call(`/api/v1/scenes/${id}`, { token: 'rr_edit_' + 'A'.repeat(43) });
    const missing = await call(`/api/v1/scenes/zzzzzzzzzzzzzzzz`, { token: 'rr_edit_' + 'A'.repeat(43) });
    expect(wrong.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(wrong.json.error.code).toBe(missing.json.error.code);
  });

  it('supports conditional reads for cheap polling', async () => {
    const { id, edit } = await created();
    const first = await call(`/api/v1/scenes/${id}`, { token: edit });
    const etag = first.res.headers.get('etag')!;
    const again = await call(`/api/v1/scenes/${id}`, { token: edit, headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    // Cloudflare weakens ETags on compressed responses; weak comparison must still match.
    const weak = await call(`/api/v1/scenes/${id}`, { token: edit, headers: { 'if-none-match': `W/${etag}` } });
    expect(weak.status).toBe(304);
    const other = await call(`/api/v1/scenes/${id}`, { token: edit, headers: { 'if-none-match': 'W/"nope", "other"' } });
    expect(other.status).toBe(200);
  });

  it('changes the ETag when a revision is published', async () => {
    const { id, edit, owner } = await created();
    const first = await call(`/api/v1/scenes/${id}`, { token: edit });
    const pub = await call(`/api/v1/scenes/${id}/publications`, { token: owner, body: { revision: 1 } });
    expect(pub.status).toBe(201);
    const after = await call(`/api/v1/scenes/${id}`, { token: edit, headers: { 'if-none-match': first.res.headers.get('etag')! } });
    expect(after.status).toBe(200);
    expect(after.json.publications.map((p: { id: string }) => p.id)).toEqual([pub.json.id]);
  });

  it('returns validation issues without saving', async () => {
    const bad = clone(EXAMPLE_SCENE) as any;
    bad.legs[0].departure = '2031-01-05T10:00:00';
    const r = await create(bad);
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('validation_failed');
    expect(r.json.error.issues[0]).toMatchObject({ path: '/legs/0/departure', code: 'timestamp_format' });
    expect(r.json.error.docs).toBe(`${ORIGIN}/agent-docs#errors`);
    const count = await db.prepare('SELECT COUNT(*) AS n FROM scenes').first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it('validates without saving via /validate', async () => {
    const r = await call('/api/v1/validate', { body: EXAMPLE_SCENE });
    expect(r.status).toBe(200);
    expect(r.json.valid).toBe(true);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM scenes').first<{ n: number }>())!.n).toBe(0);
  });
});

describe('agent signals', () => {
  const NEXT = (r: { json: any }) => {
    expect(Array.isArray(r.json.next)).toBe(true);
    expect(r.json.next.length).toBeGreaterThan(0);
    for (const step of r.json.next) expect(typeof step).toBe('string');
  };

  it('returns advisory warnings on validate, create, and replace without blocking', async () => {
    // The example is dated 2031, more than two years from now.
    const v = await call('/api/v1/validate', { body: EXAMPLE_SCENE });
    expect(v.json.warnings).toEqual([expect.objectContaining({ code: 'far_future_or_past', path: '/legs/0/departure' })]);
    expect(v.json.next[0]).toMatch(/warnings\[\]/);
    const c = await created();
    expect(c.json.warnings.map((w: any) => w.code)).toEqual(['far_future_or_past']);
    const s = clone(EXAMPLE_SCENE);
    s.legs[0]!.arrival = '2031-01-06T12:45:00-08:00'; // a day late
    s.legs[1]!.departure = '2031-01-06T21:30:00-08:00';
    s.legs[1]!.arrival = '2031-01-08T07:15:00+13:00';
    const put = await call(`/api/v1/scenes/${c.id}`, { method: 'PUT', token: c.edit, body: { expectedRevision: 1, spec: s } });
    expect(put.status).toBe(200);
    expect(put.json.revision).toBe(2);
    expect(put.json.warnings.map((w: any) => `${w.code} ${w.path}`)).toEqual(['implausible_speed /legs/0', 'far_future_or_past /legs/0/departure']);
    for (const w of put.json.warnings) expect(Object.keys(w).sort()).toEqual(['code', 'hint', 'message', 'path']);
  });

  it('puts the next step in every successful agent-facing response', async () => {
    const c = await created();
    NEXT(c);
    expect(c.json.next.join(' ')).toMatch(/"this part".*viewer\.at/);
    NEXT(await call('/api/v1'));
    NEXT(await call('/api/v1/validate', { body: EXAMPLE_SCENE }));
    NEXT(await call('/api/v1/airports/SFO'));
    NEXT(await call(`/api/v1/scenes/${c.id}`, { token: c.edit }));
    const put = await call(`/api/v1/scenes/${c.id}`, { method: 'PUT', token: c.edit, body: { expectedRevision: 1, spec: EXAMPLE_SCENE } });
    NEXT(put);
    expect(put.json.next.join(' ')).toMatch(/Publish only if the creator asks/);
    NEXT(await call(`/api/v1/scenes/${c.id}/revisions`, { token: c.edit }));
    NEXT(await call(`/api/v1/scenes/${c.id}/revisions/1`, { token: c.edit }));
    NEXT(await call(`/api/v1/scenes/${c.id}/storyboard`, { token: c.edit }));
    const pub = await call(`/api/v1/scenes/${c.id}/publications`, { token: c.owner, body: { revision: 2 } });
    NEXT(pub);
    NEXT(await call(`/api/v1/scenes/${c.id}/publications`, { token: c.edit }));
    NEXT(await call(`/api/v1/publications/${pub.json.id}`));
    NEXT(await call(`/api/v1/scenes/${c.id}/credentials/edit`, { method: 'POST', token: c.owner }));
    NEXT(await call(`/api/v1/scenes/${c.id}`, { method: 'DELETE', token: c.owner }));
  });

  it('serves storyboards for drafts (with a credential) and publications (publicly)', async () => {
    const c = await created();
    expect((await call(`/api/v1/scenes/${c.id}/storyboard`)).status).toBe(401);
    const board = await call(`/api/v1/scenes/${c.id}/storyboard`, { token: c.edit });
    expect(board.status).toBe(200);
    expect(board.json.keyframes).toHaveLength(8);
    expect(board.json.svg).toBe(`${ORIGIN}/api/v1/scenes/${c.id}/storyboard.svg`);
    expect(board.res.headers.get('cache-control')).toBe('private, no-store');
    const few = await call(`/api/v1/scenes/${c.id}/storyboard?frames=3`, { token: c.edit });
    expect(few.json.keyframes.map((k: any) => k.t)).toEqual([0, 10, 20]);
    const at = await call(`/api/v1/scenes/${c.id}/storyboard?at=7.2,12`, { token: c.edit });
    expect(at.json.keyframes.map((k: any) => [k.t, k.phase])).toEqual([[7.2, 'stop'], [12, 'flight']]);
    for (const q of ['frames=1', 'frames=25', 'frames=x', 'at=', 'at=-1', 'night=abc']) {
      const bad = await call(`/api/v1/scenes/${c.id}/storyboard.svg?${q}`, { token: c.edit });
      expect(bad.status, q).toBe(400);
      expect(bad.json.error.code).toBe('invalid_query');
    }
    const svg = await call(`/api/v1/scenes/${c.id}/storyboard.svg?night=9`, { token: c.edit });
    expect(svg.res.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
    expect(svg.text).toContain('Shaded side: night at 9 s');

    const pub = await call(`/api/v1/scenes/${c.id}/publications`, { token: c.owner, body: { revision: 1 } });
    const pubBoard = await call(`/api/v1/publications/${pub.json.id}/storyboard`);
    expect(pubBoard.status).toBe(200);
    expect(pubBoard.json.keyframes).toEqual(board.json.keyframes);
    expect(pubBoard.text).not.toContain(c.id);
    expect((await call(`/api/v1/publications/${pub.json.id}/storyboard.svg`)).status).toBe(200);
    expect((await call(`/api/v1/publications/${pub.json.id}`)).json.links.storyboard).toBe(`${ORIGIN}/api/v1/publications/${pub.json.id}/storyboard`);
    await call(`/api/v1/scenes/${c.id}`, { method: 'DELETE', token: c.owner });
    expect((await call(`/api/v1/publications/${pub.json.id}/storyboard`)).status).toBe(410);
    expect((await call('/api/v1/publications/aaaaaaaaaaaa/storyboard')).status).toBe(404);
  });

  it('includes a storyboard in a dry run on request', async () => {
    const r = await call('/api/v1/validate?storyboard=4', { body: EXAMPLE_SCENE });
    expect(r.json.storyboard.keyframes).toHaveLength(4);
    expect((await call('/api/v1/validate?storyboard', { body: EXAMPLE_SCENE })).json.storyboard.keyframes).toHaveLength(8);
    expect((await call('/api/v1/validate', { body: EXAMPLE_SCENE })).json.storyboard).toBeUndefined();
  });
});

describe('request limits', () => {
  it('rejects oversized, non-JSON, and malformed bodies', async () => {
    const big = { ...clone(EXAMPLE_SCENE), title: 'x'.repeat(70_000) };
    expect((await create(big)).status).toBe(413);
    const wrongType = await call('/api/v1/scenes', { raw: JSON.stringify(EXAMPLE_SCENE), headers: { 'content-type': 'text/plain' } });
    expect(wrongType.status).toBe(415);
    const malformed = await call('/api/v1/scenes', { raw: '{"schemaVersion": 1,', headers: { 'content-type': 'application/json' } });
    expect(malformed.status).toBe(400);
    expect(malformed.json.error.code).toBe('invalid_json');
  });

  it('rate-limits creation with an explicit retry hint', async () => {
    env.CREATE_LIMIT_PER_HOUR = '2';
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(201);
    const r = await create();
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe('rate_limited');
    expect(Number(r.res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(r.json.error.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('revisions', () => {
  it('replaces the spec atomically with expectedRevision', async () => {
    const { id, edit } = await created();
    const spec = clone(EXAMPLE_SCENE);
    spec.presentation!.endHoldSeconds = 4;
    const ok = await call(`/api/v1/scenes/${id}`, { method: 'PUT', token: edit, body: { expectedRevision: 1, spec } });
    expect(ok.status).toBe(200);
    expect(ok.json.revision).toBe(2);
    expect(ok.json.normalized.presentation.endHoldSeconds).toBe(4);
    const stale = await call(`/api/v1/scenes/${id}`, { method: 'PUT', token: edit, body: { expectedRevision: 1, spec } });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toMatchObject({ code: 'revision_conflict', currentRevision: 2 });
    expect(stale.json.error.spec.presentation.endHoldSeconds).toBe(4);
  });

  it('allows exactly one of two concurrent writers', async () => {
    const { id, edit, owner } = await created();
    const a = clone(EXAMPLE_SCENE);
    a.presentation!.endHoldSeconds = 3;
    const b = clone(EXAMPLE_SCENE);
    b.presentation!.endHoldSeconds = 4;
    const results = await Promise.all([
      call(`/api/v1/scenes/${id}`, { method: 'PUT', token: edit, body: { expectedRevision: 1, spec: a } }),
      call(`/api/v1/scenes/${id}`, { method: 'PUT', token: owner, body: { expectedRevision: 1, spec: b } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const revs = await call(`/api/v1/scenes/${id}/revisions`, { token: edit });
    expect(revs.json.revisions.map((r: any) => r.revision)).toEqual([2, 1]);
  });

  it('keeps the current scene when an update is invalid', async () => {
    const { id, edit } = await created();
    const bad = clone(EXAMPLE_SCENE) as any;
    bad.legs[1].from = 'LAX';
    const r = await call(`/api/v1/scenes/${id}`, { method: 'PUT', token: edit, body: { expectedRevision: 1, spec: bad } });
    expect(r.status).toBe(422);
    expect(r.json.error.issues[0].code).toBe('disconnected_legs');
    const cur = await call(`/api/v1/scenes/${id}`, { token: edit });
    expect(cur.json.revision).toBe(1);
    expect(cur.json.spec).toEqual(EXAMPLE_SCENE);
  });

  it('requires expectedRevision and rejects stray fields', async () => {
    const { id, edit } = await created();
    const r = await call(`/api/v1/scenes/${id}`, { method: 'PUT', token: edit, body: { spec: EXAMPLE_SCENE } });
    expect(r.json.error).toMatchObject({ code: 'expected_revision_required', currentRevision: 1 });
    const r2 = await call(`/api/v1/scenes/${id}`, { method: 'PUT', token: edit, body: { ...EXAMPLE_SCENE } });
    expect(r2.json.error.code).toBe('unknown_field');
  });

  it('reads an earlier revision for undo', async () => {
    const { id, edit } = await created();
    const s = clone(EXAMPLE_SCENE);
    s.title = 'Changed';
    await call(`/api/v1/scenes/${id}`, { method: 'PUT', token: edit, body: { expectedRevision: 1, spec: s } });
    const r1 = await call(`/api/v1/scenes/${id}/revisions/1`, { token: edit });
    expect(r1.json.spec.title).toBe(EXAMPLE_SCENE.title);
  });
});

describe('idempotency', () => {
  it('replays a retried create instead of duplicating it', async () => {
    const key = 'b6f3c1f2-8d7e-4c1a-9a43-0d2a1a7b9e10';
    const a = await create(EXAMPLE_SCENE, { 'idempotency-key': key });
    const b = await create(EXAMPLE_SCENE, { 'idempotency-key': key });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.res.headers.get('idempotent-replayed')).toBe('true');
    expect(b.json.id).toBe(a.json.id);
    expect(b.json.credentials).toEqual(a.json.credentials);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM scenes').first<{ n: number }>())!.n).toBe(1);
    // The stored replay is encrypted; plaintext credentials never sit in the database.
    expect(await allDbText()).not.toContain(a.json.credentials.owner);
  });

  it('rejects reuse of a key with a different body', async () => {
    const key = 'c6f3c1f2-8d7e-4c1a-9a43-0d2a1a7b9e10';
    await create(EXAMPLE_SCENE, { 'idempotency-key': key });
    const other = { ...clone(EXAMPLE_SCENE), title: 'Different' };
    const r = await create(other, { 'idempotency-key': key });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('idempotency_key_reused');
  });

  it('rejects malformed keys', async () => {
    const r = await create(EXAMPLE_SCENE, { 'idempotency-key': 'short' });
    expect(r.json.error.code).toBe('invalid_idempotency_key');
  });
});

describe('publication', () => {
  it('requires the owner credential and an explicit revision', async () => {
    const { id, edit, owner } = await created();
    const asEdit = await call(`/api/v1/scenes/${id}/publications`, { token: edit, body: { revision: 1 } });
    expect(asEdit.status).toBe(403);
    expect(asEdit.json.error.code).toBe('owner_required');
    const noRev = await call(`/api/v1/scenes/${id}/publications`, { token: owner, body: {} });
    expect(noRev.json.error.code).toBe('revision_required');
  });

  it('creates an immutable public snapshot isolated from later edits', async () => {
    const { id, edit, owner } = await created();
    const pub = await call(`/api/v1/scenes/${id}/publications`, { token: owner, body: { revision: 1 } });
    expect(pub.status).toBe(201);
    expect(pub.json.watchUrl).toBe(`${ORIGIN}/w/${pub.json.id}`);
    const s = clone(EXAMPLE_SCENE);
    s.presentation!.durationSeconds = 40;
    await call(`/api/v1/scenes/${id}`, { method: 'PUT', token: edit, body: { expectedRevision: 1, spec: s } });
    const pubRead = await call(`/api/v1/publications/${pub.json.id}`);
    expect(pubRead.status).toBe(200);
    expect(pubRead.json.scene.presentation.durationSeconds).toBeCloseTo(20, 5);
    expect(pubRead.res.headers.get('cache-control')).toBe('public, no-cache');
    const revalidated = await call(`/api/v1/publications/${pub.json.id}`, { headers: { 'if-none-match': pubRead.res.headers.get('etag')! } });
    expect(revalidated.status).toBe(304);
    // No credentials, draft id, or edit links in public data.
    expect(pubRead.text).not.toMatch(/rr_(edit|owner|sess)_/);
    expect(pubRead.text).not.toContain(id);
    // Publishing a later revision creates a different link.
    const pub2 = await call(`/api/v1/scenes/${id}/publications`, { token: owner, body: { revision: 2 } });
    expect(pub2.status).toBe(201);
    expect(pub2.json.existing).toBe(false);
    expect(pub2.json.id).not.toBe(pub.json.id);
    const list = await call(`/api/v1/scenes/${id}/publications`, { token: edit });
    expect(list.json.publications).toHaveLength(2);
  });

  it('replays a retried publication', async () => {
    const { id, owner } = await created();
    const key = 'pub-0001-aaaa-bbbb-cccc';
    const a = await call(`/api/v1/scenes/${id}/publications`, { token: owner, body: { revision: 1 }, headers: { 'idempotency-key': key } });
    const b = await call(`/api/v1/scenes/${id}/publications`, { token: owner, body: { revision: 1 }, headers: { 'idempotency-key': key } });
    expect(b.json.id).toBe(a.json.id);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM publications').first<{ n: number }>())!.n).toBe(1);
  });

  it('hands back the existing link when a revision is published again', async () => {
    const { id, owner } = await created();
    const first = await call(`/api/v1/scenes/${id}/publications`, { token: owner, body: { revision: 1 } });
    const again = await call(`/api/v1/scenes/${id}/publications`, { token: owner, body: { revision: 1 } });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ id: first.json.id, revision: 1, existing: true, watchUrl: first.json.watchUrl, createdAt: first.json.createdAt });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM publications').first<{ n: number }>())!.n).toBe(1);
  });

  it('serves watch pages with discovery hints and JSON by content negotiation', async () => {
    const { id, owner } = await created();
    const pub = await call(`/api/v1/scenes/${id}/publications`, { token: owner, body: { revision: 1 } });
    const html = await call(`/w/${pub.json.id}`, { headers: { accept: 'text/html' } });
    expect(html.res.headers.get('content-type')).toMatch(/text\/html/);
    expect(html.text).toContain(`<link rel="alternate" type="application/json" href="${ORIGIN}/api/v1/publications/${pub.json.id}">`);
    expect(html.text).toContain('data-agent-hint');
    const asJson = await call(`/w/${pub.json.id}`, { headers: { accept: 'application/json' } });
    expect(asJson.json.scene.schemaVersion).toBe(1);
    const draftPage = await call(`/s/${id}`, { headers: { accept: 'text/html' } });
    expect(draftPage.text).toContain('noindex');
    expect(draftPage.res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('link previews', () => {
  const html = { accept: 'text/html' };
  const meta = (text: string, key: string) =>
    [...text.matchAll(new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)">`, 'g'))].map((m) => m[1]);

  async function published(spec: unknown = EXAMPLE_SCENE) {
    const r = await create(spec);
    expect(r.status).toBe(201);
    const pub = await call(`/api/v1/scenes/${r.json.id}/publications`, { token: r.json.credentials.owner, body: { revision: 1 } });
    expect(pub.status).toBe(201);
    return { id: r.json.id as string, owner: r.json.credentials.owner as string, pubId: pub.json.id as string };
  }

  it('gives watch pages the journey title and route for chat previews, but keeps them out of search', async () => {
    const { pubId } = await published();
    const page = await call(`/w/${pubId}`, { headers: html });
    expect(page.status).toBe(200);
    expect(page.text.match(/<title>/g)).toHaveLength(1);
    expect(page.text).toContain('<title>Chicago to Auckland (synthetic example) · Route Replay</title>');
    expect(meta(page.text, 'og:title')).toEqual(['Chicago to Auckland (synthetic example)']);
    expect(meta(page.text, 'og:description')).toEqual([expect.stringMatching(/^Chicago → San Francisco → Auckland · [\d,]+ km, replayed on a 3D Earth$/)]);
    expect(meta(page.text, 'description')).toEqual(meta(page.text, 'og:description'));
    expect(meta(page.text, 'og:url')).toEqual([`${ORIGIN}/w/${pubId}`]);
    expect(meta(page.text, 'og:image')).toEqual([`${ORIGIN}/share/journey-2026-11-13.jpg`]);
    expect(meta(page.text, 'twitter:card')).toEqual(['summary_large_image']);
    expect(meta(page.text, 'robots')).toEqual(['noindex']);
    expect(page.res.headers.get('x-robots-tag')).toBe('noindex');
    // Revalidated on every view, like the snapshot, so deletion takes effect at once.
    expect(page.res.headers.get('cache-control')).toBe('public, no-cache');
    // Previews never carry dates.
    expect(page.text).not.toContain('2031');
  });

  it('replaces the homepage tags in the real app shell', async () => {
    const shell = readFileSync(new URL('../index.html', import.meta.url).pathname, 'utf8');
    env.ASSETS = { fetch: async () => new Response(shell, { headers: { 'content-type': 'text/html' } }) };
    const { pubId } = await published();
    const page = await call(`/w/${pubId}`, { headers: html });
    expect(page.text.match(/<title>/g)).toHaveLength(1);
    expect(meta(page.text, 'og:title')).toEqual(['Chicago to Auckland (synthetic example)']);
    expect(meta(page.text, 'og:url')).toEqual([`${ORIGIN}/w/${pubId}`]);
    expect(page.text).not.toContain('rel="canonical"');
    expect(page.text).not.toContain('share:start');
    expect(page.text).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(page.text).toContain('<script type="module"');
  });

  it('escapes creator-supplied titles', async () => {
    const { pubId } = await published({ ...clone(EXAMPLE_SCENE), title: `Tom & "Jerry" <b>go</b> 'west'` });
    const page = await call(`/w/${pubId}`, { headers: html });
    expect(page.text).toContain('<title>Tom &amp; &quot;Jerry&quot; &lt;b&gt;go&lt;/b&gt; &#39;west&#39; · Route Replay</title>');
    expect(meta(page.text, 'og:title')).toEqual(['Tom &amp; &quot;Jerry&quot; &lt;b&gt;go&lt;/b&gt; &#39;west&#39;']);
    expect(page.text).not.toContain('<b>go');
  });

  it('answers missing and deleted journeys with 404 and 410 and no journey details', async () => {
    const missing = await call('/w/zzzzzzzzzzzz', { headers: html });
    expect(missing.status).toBe(404);
    expect(missing.text).toContain('<title>Journey not found · Route Replay</title>');
    expect(meta(missing.text, 'robots')).toEqual(['noindex']);
    expect(meta(missing.text, 'og:url')).toEqual([]);

    const { id, owner, pubId } = await published();
    expect((await call(`/api/v1/scenes/${id}`, { method: 'DELETE', token: owner })).status).toBe(200);
    const deleted = await call(`/w/${pubId}`, { headers: html });
    expect(deleted.status).toBe(410);
    expect(deleted.text).toContain('<title>Journey deleted · Route Replay</title>');
    expect(deleted.text).not.toMatch(/Chicago|Auckland/);
    expect(deleted.text).not.toContain(`/api/v1/publications/${pubId}`);
  });

  it('gives draft previews a generic card', async () => {
    const { id } = await published();
    const page = await call(`/s/${id}`, { headers: html });
    expect(page.status).toBe(200);
    expect(meta(page.text, 'robots')).toEqual(['noindex, nofollow']);
    expect(page.res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(meta(page.text, 'og:title')).toEqual(['Route Replay']);
    expect(meta(page.text, 'og:url')).toEqual([]);
    expect(page.text).not.toMatch(/Chicago|Auckland/);
  });

  it('keeps snapshots and storyboards out of search results', async () => {
    const { pubId } = await published();
    for (const path of [`/api/v1/publications/${pubId}`, `/api/v1/publications/${pubId}/storyboard`, `/api/v1/publications/${pubId}/storyboard.svg`]) {
      const r = await call(path);
      expect(r.status).toBe(200);
      expect(r.res.headers.get('x-robots-tag')).toBe('noindex');
    }
    const asJson = await call(`/w/${pubId}`, { headers: { accept: 'application/json' } });
    expect(asJson.json.id).toBe(pubId);
    expect(asJson.res.headers.get('x-robots-tag')).toBe('noindex');
  });
});

describe('homepage', () => {
  /** A request as Cloudflare delivers it, with its estimate of where the visitor is. */
  const from = (cf: Record<string, string> | undefined, headers: Record<string, string> = {}) =>
    Object.assign(new Request(`${ORIGIN}/`, { headers }), { cf }) as unknown as Request;

  it('writes the visitor’s location, rounded to whole degrees, into the real app shell', async () => {
    const shell = readFileSync(new URL('../index.html', import.meta.url).pathname, 'utf8');
    const fetched: Request[] = [];
    env.ASSETS = {
      fetch: async (r) => {
        fetched.push(r as Request);
        return new Response(shell, { headers: { 'content-type': 'text/html', etag: '"abc"' } });
      },
    };
    const res = await handle(from({ latitude: '51.50740', longitude: '-0.12780' }, { 'if-none-match': '"abc"' }), env);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('<meta name="visitor-location" content="52,0"></head>');
    // The homepage's own title and preview stay.
    expect(page).toContain('share:start');
    // One visitor's copy, fetched whole rather than revalidated.
    expect(fetched[0]!.headers.get('if-none-match')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(res.headers.get('etag')).toBeNull();
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('leaves the location out when Cloudflare has none', async () => {
    const cases: (Record<string, string> | undefined)[] = [undefined, {}, { latitude: '', longitude: '' }, { latitude: '91', longitude: '0' }];
    for (const cf of cases) {
      const page = await (await handle(from(cf), env)).text();
      expect(page).not.toContain('visitor-location');
      expect(page).toContain('<div id="root"></div>');
    }
  });

  it('rounds at the edges of the range, without a negative zero', async () => {
    const page = await (await handle(from({ latitude: '-89.6', longitude: '179.6' }), env)).text();
    expect(page).toContain('content="-90,180"');
    const west = await (await handle(from({ latitude: '-0.2', longitude: '-0.4' }), env)).text();
    expect(west).toContain('content="0,0"');
  });
});

describe('deletion', () => {
  it('only the owner can delete; watch links then report deletion', async () => {
    const { id, edit, owner } = await created();
    const pub = await call(`/api/v1/scenes/${id}/publications`, { token: owner, body: { revision: 1 } });
    expect((await call(`/api/v1/scenes/${id}`, { method: 'DELETE', token: edit })).status).toBe(403);
    const del = await call(`/api/v1/scenes/${id}`, { method: 'DELETE', token: owner });
    expect(del.status).toBe(200);
    expect(del.json.publicationsDeleted).toBe(1);
    const gone = await call(`/api/v1/publications/${pub.json.id}`);
    expect(gone.status).toBe(410);
    expect(gone.json.error.code).toBe('publication_deleted');
    expect((await call(`/api/v1/scenes/${id}`, { token: owner })).status).toBe(404);
    expect((await call(`/api/v1/publications/zzzzzzzzzzzz`)).status).toBe(404);
    const remaining = await allDbText();
    expect(remaining).not.toContain(id);
  });
});

describe('browser sessions', () => {
  async function session(id: string, token: string) {
    const r = await call(`/api/v1/scenes/${id}/session`, { method: 'POST', token, headers: { 'x-routereplay-client': 'web' } });
    expect(r.status).toBe(201);
    const cookie = r.res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\//);
    return cookie.split(';')[0]!;
  }

  it('exchanges a fragment credential for a cookie session with the same role', async () => {
    const { id, edit } = await created();
    const cookie = await session(id, edit);
    const r = await call(`/api/v1/scenes/${id}`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.json.capabilities.role).toBe('edit');
    expect(await allDbText()).not.toContain(cookie.split('=')[1]);
  });

  it('requires the page header for cookie writes', async () => {
    const { id, edit } = await created();
    const cookie = await session(id, edit);
    const s = clone(EXAMPLE_SCENE);
    s.title = 'From the page';
    const blocked = await call(`/api/v1/scenes/${id}`, { method: 'PUT', body: { expectedRevision: 1, spec: s }, headers: { cookie } });
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe('csrf_rejected');
    const crossOrigin = await call(`/api/v1/scenes/${id}`, {
      method: 'PUT',
      body: { expectedRevision: 1, spec: s },
      headers: { cookie, 'x-routereplay-client': 'web', origin: 'https://evil.example' },
    });
    expect(crossOrigin.status).toBe(403);
    const ok = await call(`/api/v1/scenes/${id}`, {
      method: 'PUT',
      body: { expectedRevision: 1, spec: s },
      headers: { cookie, 'x-routereplay-client': 'web', origin: ORIGIN },
    });
    expect(ok.status).toBe(200);
  });

  it('agents cannot mint cookie sessions', async () => {
    const { id, edit } = await created();
    const r = await call(`/api/v1/scenes/${id}/session`, { method: 'POST', token: edit });
    expect(r.status).toBe(403);
  });

  it('edit sessions cannot publish; rotating the edit credential revokes edit access', async () => {
    const { id, edit, owner } = await created();
    const editCookie = await session(id, edit);
    const ownerCookie = await session(id, owner);
    const pub = await call(`/api/v1/scenes/${id}/publications`, {
      body: { revision: 1 },
      headers: { cookie: editCookie, 'x-routereplay-client': 'web' },
    });
    expect(pub.status).toBe(403);
    expect((await call(`/api/v1/scenes/${id}/credentials/edit`, { method: 'POST', token: edit })).status).toBe(403);
    const rot = await call(`/api/v1/scenes/${id}/credentials/edit`, { method: 'POST', token: owner });
    expect(rot.status).toBe(200);
    expect(rot.json.credentials.edit).not.toBe(edit);
    expect((await call(`/api/v1/scenes/${id}`, { token: edit })).status).toBe(404);
    expect((await call(`/api/v1/scenes/${id}`, { headers: { cookie: editCookie } })).status).toBe(401);
    expect((await call(`/api/v1/scenes/${id}`, { token: rot.json.credentials.edit })).status).toBe(200);
    expect((await call(`/api/v1/scenes/${id}`, { headers: { cookie: ownerCookie } })).json.capabilities.role).toBe('owner');
  });

  it('signs out', async () => {
    const { id, edit } = await created();
    const cookie = await session(id, edit);
    const out = await call(`/api/v1/scenes/${id}/session`, { method: 'DELETE', headers: { cookie } });
    expect(out.res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await call(`/api/v1/scenes/${id}`, { headers: { cookie } })).status).toBe(401);
  });
});

describe('airport lookup', () => {
  it('resolves offsets for local times, including clock changes', async () => {
    const lis = await call('/api/v1/airports/LIS?local=2031-03-30T06:40');
    expect(lis.json).toMatchObject({ code: 'LIS', timeZone: 'Europe/Lisbon' });
    expect(lis.json.resolution.matches).toEqual([{ offset: '+01:00', timestamp: '2031-03-30T06:40:00+01:00', utc: '2031-03-30T05:40:00Z' }]);
    const gap = await call('/api/v1/airports/ORD?local=2031-03-09T02:30');
    expect(gap.json.resolution.matches).toEqual([]);
    const twice = await call('/api/v1/airports/ORD?local=2031-11-02T01:30');
    expect(twice.json.resolution.matches.map((m: any) => m.offset)).toEqual(['-05:00', '-06:00']);
    expect((await call('/api/v1/airports/CHI')).status).toBe(404);
    expect((await call('/api/v1/airports/ORD?local=tomorrow')).status).toBe(400);
  });

  it('finds every airport in the table, and nothing else', () => {
    const table = JSON.parse(readFileSync(new URL('../src/server/airports/airports.json', import.meta.url).pathname, 'utf8')) as {
      rows: [string, string, string, string, number, number, string][];
    };
    for (const [code, name, city, country, lat, lon, timeZone] of table.rows) {
      expect(lookupAirport(code)).toEqual({ code, name, city, country, lat, lon, timeZone });
    }
    const codes = new Set(table.rows.map((r) => r[0]));
    for (const code of ['AAB', 'ZZZ', 'AA', 'AAAA', 'aaa', '']) {
      if (!codes.has(code)) expect(lookupAirport(code)).toBeUndefined();
    }
  });
});

describe('agent documents', () => {
  it('serves docs with absolute URLs and no unresolved placeholders', async () => {
    const r = await call('/agent-docs');
    expect(r.res.headers.get('content-type')).toMatch(/text\/markdown/);
    expect(r.text).toContain(`POST ${ORIGIN}/api/v1/scenes`);
    expect(r.text).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(r.text).toContain('"schemaVersion": 1');
    expect(r.text).toContain(`Docs version ${DOCS_VERSION}`);
    expect(r.text).toContain(WORKFLOW_MD.replace(/\{\{ORIGIN\}\}/g, ORIGIN));
    expect(r.text).not.toMatch(/install|SKILL\.md|\/skills\//i);
    expect((await call('/llms.txt')).text).not.toMatch(/skill/i);
  });

  it('serves the acknowledgments as plain text that credits every runtime dependency', async () => {
    const r = await call('/acknowledgments');
    expect(r.status).toBe(200);
    expect(r.res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(r.text).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(r.text).toContain(`${ORIGIN}/assets/${ASSET_MANIFEST_VERSION}/BarlowCondensed-OFL.txt`);
    expect(r.text).toContain('Blue Marble');
    expect(r.text).toContain('Copyright (c) 2014 mwgg');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url).pathname, 'utf8'));
    const credited = r.text.toLowerCase();
    // Packages are credited by their usual names (react-dom as "React DOM", @react-three/fiber as "React Three Fiber").
    const names: Record<string, string> = { 'react-dom': 'react dom', '@react-three/fiber': 'react three fiber' };
    for (const name of Object.keys(pkg.dependencies)) expect(credited).toContain(names[name] ?? name);
  });

  it('no longer serves the FAQ, which the chat answers itself', async () => {
    // Like any unknown page, it falls through to static assets (the 404 page in production).
    const r = await call('/faq');
    expect(r.res.headers.get('content-type')).toMatch(/text\/html/);
    expect(r.text).toBe(SHELL);
  });

  it('no longer serves an installable skill', async () => {
    // The paths fall through to static assets (the 404 page in production), like any unknown page.
    for (const path of ['/skills/routereplay-web.zip', '/skills/routereplay-web/SKILL.md']) {
      const r = await call(path);
      expect(r.res.headers.get('content-type')).toMatch(/text\/html/);
      expect(r.text).toBe(SHELL);
    }
  });

  it('serves the schema with an absolute $id', async () => {
    const r = await call('/schemas/scene-v1.json');
    expect(r.json.$id).toBe(`${ORIGIN}/schemas/scene-v1.json`);
    expect(r.json.properties.legs.maxItems).toBe(12);
  });
});

describe('live updates', () => {
  /** Stands in for the SceneLive object, using the same rules (src/server/liveState.ts). */
  function fakeLive(clock = () => Date.now()) {
    const calls: { id: string; kind: string }[] = [];
    const objects = new Map<string, { sent: string[]; reports: ViewerReport[]; activity: Activity | null; previews: number }>();
    const obj = (id: string) => {
      if (!objects.has(id)) objects.set(id, { sent: [], reports: [], activity: null, previews: 0 });
      return objects.get(id)!;
    };
    const ns = {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (input: Request | string, init?: RequestInit) => {
          const req = typeof input === 'string' ? new Request(input, init) : input;
          const o = obj(id);
          const isUpgrade = req.headers.get('upgrade') === 'websocket';
          const path = new URL(req.url).pathname;
          const body = req.method === 'POST' ? await req.text() : '';
          calls.push({ id, kind: isUpgrade ? 'upgrade' : `${req.method} ${path}${body ? ` ${body}` : ''}` });
          // Node cannot construct a 101 response; a 200 stands in for the accepted upgrade.
          if (isUpgrade) return new Response('upgraded');
          if (path === '/state') {
            return Response.json({ previews: o.previews, viewer: latestViewer(o.reports), activity: currentActivity(o.activity, clock()) });
          }
          if (path === '/activity') {
            const b = JSON.parse(body);
            o.activity = b.state === 'working' ? { message: b.message, expiresAt: clock() + ACTIVITY_TTL_MS, updatedAt: clock() } : null;
            o.sent.push(activityEvent(o.activity, clock()));
            return Response.json({ previews: o.previews, activity: o.activity });
          }
          o.sent.push(body);
          return Response.json({ previews: o.previews });
        },
      }),
    };
    return { ns: ns as unknown as DurableObjectNamespace, calls, obj };
  }

  it('notifies the draft after every successful change, and not after failures', async () => {
    const live = fakeLive();
    env.LIVE = live.ns;
    const { id, edit, owner } = await created();
    const s = clone(EXAMPLE_SCENE);
    s.title = 'Changed';
    await call(`/api/v1/scenes/${id}`, { method: 'PUT', token: edit, body: { expectedRevision: 1, spec: s } });
    await call(`/api/v1/scenes/${id}`, { method: 'PUT', token: edit, body: { expectedRevision: 1, spec: s } }); // 409
    await call(`/api/v1/scenes/${id}/publications`, { token: owner, body: { revision: 2 } });
    await call(`/api/v1/scenes/${id}/credentials/edit`, { method: 'POST', token: owner });
    await call(`/api/v1/scenes/${id}`, { method: 'DELETE', token: owner });
    expect(live.calls.map((c) => c.id)).toEqual([id, id, id, id]);
    expect(live.calls.every((c) => c.kind === 'POST /notify {"type":"changed"}')).toBe(true);
  });

  it('only upgrades authorized same-origin WebSocket requests', async () => {
    const live = fakeLive();
    env.LIVE = live.ns;
    const { id, edit } = await created();
    const ws = { upgrade: 'websocket', connection: 'Upgrade' };
    expect((await call(`/api/v1/scenes/${id}/live`, { token: edit })).status).toBe(426);
    expect((await call(`/api/v1/scenes/${id}/live`, { headers: ws })).status).toBe(401);
    expect((await call(`/api/v1/scenes/${id}/live`, { token: edit, headers: { ...ws, origin: 'https://evil.example' } })).status).toBe(403);
    const ok = await call(`/api/v1/scenes/${id}/live`, { token: edit, headers: { ...ws, origin: ORIGIN } });
    expect(ok.text).toBe('upgraded');
    expect(live.calls).toEqual([{ id, kind: 'upgrade' }]);
  });

  it('reports when live updates are not configured', async () => {
    const { id, edit } = await created();
    const r = await call(`/api/v1/scenes/${id}/live`, { token: edit, headers: { upgrade: 'websocket' } });
    expect(r.status).toBe(501);
  });

  it('tells agents what the creator is looking at, evaluated against the current revision', async () => {
    const live = fakeLive();
    env.LIVE = live.ns;
    const { id, edit } = await created();
    const closed = await call(`/api/v1/scenes/${id}`, { token: edit });
    expect(closed.json.viewer).toEqual({ open: false, previews: 0 });
    expect(closed.json.activity).toEqual({ state: 'idle' });

    const o = live.obj(id);
    o.previews = 1;
    o.reports.push({ t: 12, paused: true, revision: 1, receivedAt: Date.now() });
    const paused = await call(`/api/v1/scenes/${id}`, { token: edit });
    expect(paused.json.viewer).toMatchObject({ open: true, previews: 1, paused: true, at: { t: 12, phase: 'flight', legId: 'sfo-akl' } });
    expect(paused.json.viewer.at.summary).toMatch(/^Flying SFO → AKL/);
    expect(paused.json.next[0]).toMatch(/paused at 12 s .*"this"/);
    expect(paused.json.next[1]).toMatch(/preview open\. Before work .*\/activity/);
    expect(closed.json.next.join(' ')).not.toMatch(/\/activity/);
    // A changed viewer changes the ETag, so conditional reads don't hide it.
    o.reports.push({ t: 3, paused: true, revision: 1, receivedAt: Date.now() + 1 });
    const moved = await call(`/api/v1/scenes/${id}`, { token: edit, headers: { 'if-none-match': paused.res.headers.get('etag')! } });
    expect(moved.status).toBe(200);
    expect(moved.json.viewer.at.legId).toBe('ord-sfo');

    // While playing, the position is extrapolated from the last report. (A socket's new report replaces its old one.)
    o.reports = [{ t: 2, paused: false, revision: 1, receivedAt: Date.now() - 3000 }];
    const playing = await call(`/api/v1/scenes/${id}`, { token: edit });
    expect(playing.json.viewer.paused).toBe(false);
    expect(playing.json.viewer.at.t).toBeGreaterThanOrEqual(5);
    expect(playing.json.viewer.at.t).toBeLessThan(5.5);
  });

  it("does not ask the object on the page's own reads", async () => {
    const live = fakeLive();
    env.LIVE = live.ns;
    const { id, edit } = await created();
    const session = await call(`/api/v1/scenes/${id}/session`, { method: 'POST', token: edit, headers: { 'x-routereplay-client': 'web' } });
    const cookie = session.res.headers.get('set-cookie')!.split(';')[0]!;
    const read = await call(`/api/v1/scenes/${id}`, { headers: { cookie } });
    expect(read.status).toBe(200);
    expect(read.json.viewer).toBeUndefined();
    expect(live.calls.filter((c) => c.kind === 'GET /state')).toEqual([]);
  });

  it('moves open previews to a moment on request', async () => {
    const live = fakeLive();
    env.LIVE = live.ns;
    const { id, edit } = await created();
    expect((await call(`/api/v1/scenes/${id}/viewer`, { body: { seek: 7.2 } })).status).toBe(401);
    for (const body of [{}, { seek: '7' }, { seek: -1 }, { seek: 999 }, { seek: 1, extra: true }]) {
      expect((await call(`/api/v1/scenes/${id}/viewer`, { token: edit, body })).status, JSON.stringify(body)).toBe(400);
    }
    const none = await call(`/api/v1/scenes/${id}/viewer`, { token: edit, body: { seek: 7.2 } });
    expect(none.json).toMatchObject({ delivered: 0, at: { t: 7.2, phase: 'stop' } });
    expect(none.json.next[0]).toMatch(/No preview is open/);
    live.obj(id).previews = 2;
    const shown = await call(`/api/v1/scenes/${id}/viewer`, { token: edit, body: { seek: 7.2 } });
    expect(shown.json.delivered).toBe(2);
    expect(live.obj(id).sent).toEqual(['{"type":"seek","t":7.2}', '{"type":"seek","t":7.2}']);
  });

  it('relays agent activity, which lapses after three minutes', async () => {
    let now = Date.now();
    const live = fakeLive(() => now);
    env.LIVE = live.ns;
    const { id, edit } = await created();
    expect((await call(`/api/v1/scenes/${id}/activity`, { body: { state: 'working' } })).status).toBe(401);
    for (const body of [{}, { state: 'busy' }, { state: 'working', message: 'x'.repeat(81) }, { state: 'working', message: 5 }, { state: 'idle', why: 1 }]) {
      expect((await call(`/api/v1/scenes/${id}/activity`, { token: edit, body })).status, JSON.stringify(body)).toBe(400);
    }
    const set = await call(`/api/v1/scenes/${id}/activity`, { token: edit, body: { state: 'working', message: 'Checking your\nconnection in SFO' } });
    expect(set.status).toBe(200);
    expect(set.json.activity).toEqual({ state: 'working', message: 'Checking your connection in SFO', expiresInSeconds: 180 });
    expect(JSON.parse(live.obj(id).sent.at(-1)!)).toMatchObject({ type: 'activity', state: 'working', message: 'Checking your connection in SFO' });
    expect((await call(`/api/v1/scenes/${id}`, { token: edit })).json.activity).toMatchObject({ state: 'working', message: 'Checking your connection in SFO' });
    now += ACTIVITY_TTL_MS + 1000;
    expect((await call(`/api/v1/scenes/${id}`, { token: edit })).json.activity).toEqual({ state: 'idle' });
    await call(`/api/v1/scenes/${id}/activity`, { token: edit, body: { state: 'working', message: 'Again' } });
    const idle = await call(`/api/v1/scenes/${id}/activity`, { token: edit, body: { state: 'idle' } });
    expect(idle.json.activity).toEqual({ state: 'idle' });
    expect(JSON.parse(live.obj(id).sent.at(-1)!)).toEqual({ type: 'activity', state: 'idle' });
  });

  it('keeps viewer state and activity out of D1 and public data', async () => {
    const live = fakeLive();
    env.LIVE = live.ns;
    const { id, edit, owner } = await created();
    live.obj(id).previews = 1;
    live.obj(id).reports.push({ t: 4.5, paused: true, revision: 1, receivedAt: Date.now() });
    await call(`/api/v1/scenes/${id}/activity`, { token: edit, body: { state: 'working', message: 'Secret-ish status' } });
    await call(`/api/v1/scenes/${id}`, { token: edit });
    const pub = await call(`/api/v1/scenes/${id}/publications`, { token: owner, body: { revision: 1 } });
    const publicRead = await call(`/api/v1/publications/${pub.json.id}`);
    expect(publicRead.text).not.toMatch(/viewer|activity|Secret-ish/);
    expect(await allDbText()).not.toMatch(/Secret-ish|"paused"|viewer/);
  });

  it('reports when live features are not configured', async () => {
    const { id, edit } = await created();
    expect((await call(`/api/v1/scenes/${id}/viewer`, { token: edit, body: { seek: 1 } })).status).toBe(501);
    expect((await call(`/api/v1/scenes/${id}/activity`, { token: edit, body: { state: 'idle' } })).status).toBe(501);
    expect((await call(`/api/v1/scenes/${id}`, { token: edit })).json.viewer).toBeUndefined();
  });
});

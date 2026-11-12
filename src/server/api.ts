/**
 * Route Replay HTTP API (v1). HTTP clients (agents) and the browser preview (including
 * its WebMCP tools) use these same operations; there is no separate write path.
 */
import { LIMITS } from '../shared/scene/constants';
import type { NormalizedSceneV1, SceneSpecV1 } from '../shared/scene/types';
import { validateScene } from '../shared/scene/validate';
import { sceneWarnings, type SceneWarning } from '../shared/scene/warnings';
import { buildTimeline } from '../shared/timeline/evaluate';
import { STORYBOARD_FRAMES, buildStoryboard, keyframeAt } from '../shared/timeline/storyboard';
import { ACTIVITY_MESSAGE_MAX, type LiveState, cleanActivityMessage } from './liveState';
import { storyboardSvg } from './storyboardSvg';
import { AIRPORT_DATA_VERSION, lookupAirport } from './airports';
import { weatherFieldsOp } from './weather';
import { formatLocalTimestamp, formatOffset, formatUtc, resolveWallTime } from '../shared/scene/time';
import { TOKEN_RE, constantTimeEqual, newToken, randomId, sha256Hex } from './crypto';
import {
  abandonIdempotent,
  beginIdempotent,
  completeIdempotent,
  enforceLimit,
  readIdempotencyKey,
  type LimitRule,
} from './guards';
import { ApiError, bearerToken, clientAddress, etagMatches, json, parseCookies, readJsonBody } from './http';
import * as store from './store';

export interface Env {
  DB: D1Database;
  ASSETS?: { fetch(input: Request | string): Promise<Response> };
  /** Optional canonical origin for links, e.g. https://routereplay.example. Defaults to the request origin. */
  PUBLIC_ORIGIN?: string;
  /** Secret mixed into hashed client addresses for rate limiting. */
  RATE_LIMIT_SALT?: string;
  /** Overrides for limits (strings, as Pages env vars are strings). */
  CREATE_LIMIT_PER_HOUR?: string;
  CREATE_LIMIT_PER_DAY?: string;
  WRITE_LIMIT_PER_HOUR?: string;
  SESSION_LIMIT_PER_HOUR?: string;
  /** One SceneLive Durable Object per draft pushes "changed" events to open previews. */
  LIVE?: DurableObjectNamespace;
}

export interface Ctx {
  waitUntil?(p: Promise<unknown>): void;
}

export type Role = 'owner' | 'edit';
const SESSION_TTL_MS = 7 * 86_400_000;
export const sessionCookieName = (sceneId: string) => `rr_s_${sceneId}`;
const SCENE_ID_RE = /^[a-z0-9]{16}$/;
const PUB_ID_RE = /^[a-z0-9]{12}$/;

const validateOptions = { lookupAirport, airportDataVersion: AIRPORT_DATA_VERSION };

function limits(env: Env) {
  const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    createPerClient: { name: 'scene_creation', windowMs: 3_600_000, limit: n(env.CREATE_LIMIT_PER_HOUR, 30) } as LimitRule,
    createGlobal: { name: 'global_scene_creation', windowMs: 86_400_000, limit: n(env.CREATE_LIMIT_PER_DAY, 2000) } as LimitRule,
    writesPerScene: { name: 'scene_write', windowMs: 3_600_000, limit: n(env.WRITE_LIMIT_PER_HOUR, 240) } as LimitRule,
    sessionsPerClient: { name: 'session_exchange', windowMs: 3_600_000, limit: n(env.SESSION_LIMIT_PER_HOUR, 60) } as LimitRule,
  };
}

export function originOf(request: Request, env: Env): string {
  return (env.PUBLIC_ORIGIN ?? new URL(request.url).origin).replace(/\/$/, '');
}

const iso = (ms: number) => new Date(ms).toISOString();

function capabilities(role: Role) {
  return {
    role,
    read: true,
    edit: true,
    publish: role === 'owner',
    delete: role === 'owner',
    rotateEditCredential: role === 'owner',
  };
}

function links(origin: string, id: string) {
  return {
    self: `${origin}/api/v1/scenes/${id}`,
    publications: `${origin}/api/v1/scenes/${id}/publications`,
    revisions: `${origin}/api/v1/scenes/${id}/revisions`,
    schema: `${origin}/schemas/scene-v1.json`,
    docs: `${origin}/agent-docs`,
  };
}

const watchUrl = (origin: string, pubId: string) => `${origin}/w/${pubId}`;

async function sceneView(db: D1Database, origin: string, row: store.SceneRow, role: Role) {
  const pubs = await store.listPublications(db, row.id);
  return {
    id: row.id,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    previewUrl: `${origin}/s/${row.id}`,
    capabilities: capabilities(role),
    spec: JSON.parse(row.spec_json) as SceneSpecV1,
    normalized: JSON.parse(row.normalized_json) as NormalizedSceneV1,
    publications: pubs.map((p) => ({
      id: p.id,
      revision: p.revision,
      createdAt: iso(p.created_at),
      watchUrl: watchUrl(origin, p.id),
    })),
    links: links(origin, row.id),
  };
}

function validationError(issues: ReturnType<typeof validateScene> & { ok: false }) {
  return new ApiError(422, 'validation_failed', `The scene spec has ${issues.issues.length} problem(s). Nothing was saved.`, {
    issues: issues.issues,
    hint: 'Fix each issue at its JSON Pointer path and resubmit. Read /schemas/scene-v1.json for field rules.',
  });
}

/** Steer the agent toward advisory warnings without blocking anything. */
function warningNext(warnings: SceneWarning[]): string[] {
  return warnings.length
    ? ['warnings[] lists likely mistakes that were still accepted. Raise material ones with the creator before going further.']
    : [];
}

async function clientSubject(request: Request, env: Env): Promise<string> {
  return (await sha256Hex(`${env.RATE_LIMIT_SALT ?? 'routereplay-local'}\n${clientAddress(request)}`)).slice(0, 32);
}

interface Authorized {
  row: store.SceneRow;
  role: Role;
  via: 'bearer' | 'session';
}

/** Resolve the caller's role for a scene from a bearer credential or a browser session cookie. */
async function authorize(request: Request, env: Env, id: string, now: number): Promise<Authorized> {
  if (!SCENE_ID_RE.test(id)) throw notFound();
  const row = await store.getScene(env.DB, id);
  const token = bearerToken(request);
  const cookie = parseCookies(request.headers.get('cookie')).get(sessionCookieName(id));
  if (!token && !cookie) {
    throw new ApiError(401, 'credential_required', 'This draft is private. Send its credential.', {
      hint: 'Use the header Authorization: Bearer <edit or owner credential> returned when the scene was created.',
    }, { 'www-authenticate': 'Bearer realm="routereplay"' });
  }
  // Unknown scene and wrong credential both answer 404 so drafts cannot be enumerated.
  if (!row) throw notFound();
  if (token) {
    if (!TOKEN_RE.test(token)) throw notFound();
    const h = await sha256Hex(token);
    if (constantTimeEqual(h, row.owner_token_hash)) return { row, role: 'owner', via: 'bearer' };
    if (constantTimeEqual(h, row.edit_token_hash)) return { row, role: 'edit', via: 'bearer' };
    throw notFound();
  }
  const session = TOKEN_RE.test(cookie!) ? await store.getSession(env.DB, await sha256Hex(cookie!)) : null;
  if (
    !session ||
    session.scene_id !== id ||
    session.expires_at < now ||
    (session.role === 'edit' && session.generation !== row.edit_generation)
  ) {
    throw new ApiError(401, 'session_expired', 'The browser session for this draft has expired or was revoked.', {
      hint: 'Open the private preview link again, or ask the agent for a new one.',
    });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // Cookie-authenticated writes must come from the Route Replay page itself.
    const origin = request.headers.get('origin');
    if (request.headers.get('x-routereplay-client') !== 'web' || (origin && origin !== new URL(request.url).origin)) {
      throw new ApiError(403, 'csrf_rejected', 'Cookie-authenticated writes require the Route Replay page.', {
        hint: 'Agents should use Authorization: Bearer instead of cookies.',
      });
    }
  }
  return { row, role: session.role, via: 'session' };
}

function requireOwner(auth: Authorized) {
  if (auth.role !== 'owner') {
    throw new ApiError(403, 'owner_required', 'This operation needs the owner credential.', {
      hint: 'The edit credential can read and revise the draft but cannot publish, delete, or rotate credentials.',
    });
  }
}

const notFound = () =>
  new ApiError(404, 'not_found', 'No draft with that id is available to this credential.', {
    hint: 'Check the scene id and credential. Deleted drafts cannot be recovered.',
  });

function maybeCleanup(env: Env, ctx: Ctx, now: number) {
  if (Math.random() < 0.02) {
    const p = store.cleanupExpired(env.DB, now).catch(() => undefined);
    ctx.waitUntil ? ctx.waitUntil(p) : void p;
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function createScene(request: Request, env: Env, ctx: Ctx, origin: string, now: number): Promise<Response> {
  const key = readIdempotencyKey(request);
  const input = await readJsonBody(request);
  const result = validateScene(input, { ...validateOptions, now });
  if (!result.ok) throw validationError(result);
  const warnings = sceneWarnings(result.normalized, now);
  const bodyText = JSON.stringify(input);

  const idem = await beginIdempotent(env.DB, 'create', key, bodyText, now, true);
  if (idem.kind === 'replay') {
    return new Response(idem.body, {
      status: idem.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'idempotent-replayed': 'true' },
    });
  }
  try {
    const lim = limits(env);
    await enforceLimit(env.DB, lim.createPerClient, await clientSubject(request, env), now);
    await enforceLimit(env.DB, lim.createGlobal, 'all', now);

    const id = randomId(16);
    const editToken = newToken('edit');
    const ownerToken = newToken('owner');
    const row: store.SceneRow = {
      id,
      revision: 1,
      spec_json: JSON.stringify(result.spec),
      normalized_json: JSON.stringify(result.normalized),
      edit_token_hash: await sha256Hex(editToken),
      owner_token_hash: await sha256Hex(ownerToken),
      edit_generation: 1,
      created_at: now,
      updated_at: now,
    };
    await store.insertScene(env.DB, row);
    const body = {
      ...(await sceneView(env.DB, origin, row, 'owner')),
      previewUrl: `${origin}/s/${id}#k=${editToken}`,
      credentials: {
        edit: editToken,
        owner: ownerToken,
        usage: 'Send as Authorization: Bearer <credential>. They are shown only once.',
      },
      warnings,
      next: [
        'Give the creator previewUrl. It contains the edit credential after # and lets them watch revisions live.',
        'Keep the owner credential private; it is required to publish, delete, or rotate the edit credential.',
        'Never post either credential publicly. Watch links created by publishing are safe to share.',
        ...warningNext(warnings),
        `Check the storyboard (GET ${origin}/api/v1/scenes/${id}/storyboard) to confirm the journey looks the way the creator described.`,
        `Later, if the creator says "this part" or "here", GET ${origin}/api/v1/scenes/${id} first: viewer.at says where their preview is paused.`,
      ],
    };
    const text = JSON.stringify(body, null, 2) + '\n';
    await completeIdempotent(env.DB, idem, 201, text, true);
    maybeCleanup(env, ctx, now);
    return new Response(text, {
      status: 201,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        location: `${origin}/api/v1/scenes/${id}`,
      },
    });
  } catch (e) {
    await abandonIdempotent(env.DB, idem);
    throw e;
  }
}

async function readScene(request: Request, env: Env, id: string, origin: string, now: number): Promise<Response> {
  const auth = await authorize(request, env, id, now);
  // Agents (bearer reads) also learn what the creator is looking at and the activity banner.
  // The page's own reads skip this, so refreshing the preview costs no Durable Object request.
  const live = auth.via === 'bearer' ? await liveContext(env, auth.row, now) : null;
  const liveTag = live ? `-${(await sha256Hex(JSON.stringify(live))).slice(0, 12)}` : '';
  const etag = `"${auth.row.id}-r${auth.row.revision}-${auth.role}${liveTag}"`;
  const headers = { etag, 'cache-control': 'private, no-cache', vary: 'authorization, cookie' };
  if (etagMatches(request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });
  const view = await sceneView(env.DB, origin, auth.row, auth.role);
  const next = [
    `To change the journey, edit spec (not normalized) and PUT it with expectedRevision ${auth.row.revision}.`,
    `GET ${view.links.self}/storyboard shows what each moment of the animation looks like.`,
  ];
  if (live?.viewer.open) {
    // Agents read the draft before changing it, so this is where they learn the creator is watching.
    next.unshift(
      `The creator has the preview open. Before work that will take more than about 10 seconds, POST ${view.links.self}/activity {"state":"working","message":"<what you're doing>"} so they can see it, and {"state":"idle"} when done.`,
    );
    if (live.viewer.paused && live.viewer.at) {
      next.unshift(
        `The creator has the preview paused at ${live.viewer.at.t} s (${live.viewer.at.summary}). If they say "this", "here", or "now", they mean this moment; say what you assumed.`,
      );
    }
  }
  return json({ ...view, ...(live ?? {}), next }, 200, headers);
}

async function liveState(env: Env, id: string): Promise<LiveState | null> {
  if (!env.LIVE) return null;
  try {
    const res = await env.LIVE.get(env.LIVE.idFromName(id)).fetch('https://live/state');
    return res.ok ? ((await res.json()) as LiveState) : null;
  } catch {
    return null;
  }
}

/** The viewer and activity fields of an agent's scene read, evaluated against the current revision. */
async function liveContext(env: Env, row: store.SceneRow, now: number) {
  const state = await liveState(env, row.id);
  if (!state) return null;
  const scene = JSON.parse(row.normalized_json) as NormalizedSceneV1;
  const v = state.viewer;
  let viewer: Record<string, unknown> = { open: state.previews > 0, previews: state.previews };
  if (state.previews > 0 && v) {
    const tl = buildTimeline(scene);
    // While playing, estimate where playback has got to (the preview loops).
    const elapsed = Math.max(0, (now - v.receivedAt) / 1000);
    const t = v.paused ? v.t : tl.duration > 0 ? (v.t + elapsed) % tl.duration : 0;
    viewer = {
      ...viewer,
      paused: v.paused,
      at: keyframeAt(tl, t),
      reportedSecondsAgo: Math.round(elapsed),
      ...(v.revision !== null && v.revision !== row.revision ? { revision: v.revision } : {}),
    };
  }
  const a = state.activity;
  return {
    viewer: viewer as { open: boolean; paused?: boolean; at?: ReturnType<typeof keyframeAt> },
    activity: a
      ? { state: 'working', message: a.message, expiresInSeconds: Math.max(0, Math.round((a.expiresAt - now) / 1000)) }
      : { state: 'idle' },
  };
}

async function replaceSceneOp(request: Request, env: Env, id: string, origin: string, now: number): Promise<Response> {
  const auth = await authorize(request, env, id, now);
  const body = await readJsonBody(request);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_body', 'Send {"expectedRevision": <number>, "spec": {...}}.');
  }
  const { expectedRevision, spec, ...rest } = body as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length) {
    throw new ApiError(400, 'unknown_field', `Unknown field(s): ${extra.join(', ')}.`, {
      hint: 'The body has exactly two fields: expectedRevision and spec. Put scene fields inside spec.',
    });
  }
  if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new ApiError(400, 'expected_revision_required', 'expectedRevision must be the integer revision you last read.', {
      currentRevision: auth.row.revision,
      hint: 'Read the scene first (GET), apply your change to its spec, and send that revision number.',
    });
  }
  if (spec === undefined) throw new ApiError(400, 'spec_required', 'Missing spec.');
  const result = validateScene(spec, { ...validateOptions, now });
  if (!result.ok) throw validationError(result);
  await enforceLimit(env.DB, limits(env).writesPerScene, id, now);

  const conflict = async () => {
    const current = (await store.getScene(env.DB, id))!;
    return new ApiError(409, 'revision_conflict', `The draft is at revision ${current.revision}, not ${expectedRevision}.`, {
      currentRevision: current.revision,
      spec: JSON.parse(current.spec_json),
      normalized: JSON.parse(current.normalized_json),
      hint: 'Someone else changed the draft. Reapply your intended change to this current spec and retry with the current revision.',
    });
  };
  if (expectedRevision !== auth.row.revision) throw await conflict();
  const next = await store.replaceScene(
    env.DB,
    id,
    expectedRevision,
    JSON.stringify(result.spec),
    JSON.stringify(result.normalized),
    now,
  );
  if (next === null) throw await conflict();
  const row = (await store.getScene(env.DB, id))!;
  const warnings = sceneWarnings(result.normalized, now);
  return json(
    {
      ...(await sceneView(env.DB, origin, row, auth.role)),
      warnings,
      next: [
        `Tell the creator the preview now shows revision ${next}.`,
        ...warningNext(warnings),
        `To confirm the change, GET ${origin}/api/v1/scenes/${id}/storyboard and compare it with what the creator asked for.`,
        'Publish only if the creator asks.',
      ],
    },
    200,
    { etag: `"${id}-r${next}-${auth.role}"` },
  );
}

async function listRevisionsOp(request: Request, env: Env, id: string, now: number): Promise<Response> {
  const auth = await authorize(request, env, id, now);
  const revs = await store.listRevisions(env.DB, id);
  return json({
    id,
    currentRevision: auth.row.revision,
    retained: store.REVISIONS_KEPT,
    revisions: revs.map((r) => ({ revision: r.revision, createdAt: iso(r.created_at) })),
    next: [`To restore a revision, GET it and PUT its spec with expectedRevision ${auth.row.revision}.`],
  });
}

async function readRevisionOp(request: Request, env: Env, id: string, rev: number, now: number): Promise<Response> {
  const auth = await authorize(request, env, id, now);
  const r = await store.getRevision(env.DB, id, rev);
  if (!r) throw new ApiError(404, 'revision_not_found', `Revision ${rev} is not retained.`);
  return json({
    id,
    revision: r.revision,
    createdAt: iso(r.created_at),
    spec: JSON.parse(r.spec_json),
    normalized: JSON.parse(r.normalized_json),
    hint: 'To restore it, PUT this spec with the current expectedRevision.',
    next: [`To restore it, PUT this spec with expectedRevision ${auth.row.revision}.`],
  });
}

async function publishOp(request: Request, env: Env, id: string, origin: string, now: number): Promise<Response> {
  const auth = await authorize(request, env, id, now);
  requireOwner(auth);
  const key = readIdempotencyKey(request);
  const body = await readJsonBody(request);
  const revision = (body as { revision?: unknown } | null)?.revision;
  if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).some((k) => k !== 'revision')) {
    throw new ApiError(400, 'invalid_body', 'Send {"revision": <number>} naming the revision to publish.');
  }
  if (typeof revision !== 'number' || !Number.isInteger(revision)) {
    throw new ApiError(400, 'revision_required', 'Name the revision to publish explicitly.', {
      currentRevision: auth.row.revision,
      hint: `To publish what the creator currently sees, send {"revision": ${auth.row.revision}}.`,
    });
  }
  const idem = await beginIdempotent(env.DB, `publish:${id}`, key, JSON.stringify(body), now, false);
  if (idem.kind === 'replay') {
    return new Response(idem.body, {
      status: idem.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'idempotent-replayed': 'true' },
    });
  }
  try {
    await enforceLimit(env.DB, limits(env).writesPerScene, id, now);
    let normalizedJson: string;
    if (revision === auth.row.revision) normalizedJson = auth.row.normalized_json;
    else {
      const r = await store.getRevision(env.DB, id, revision);
      if (!r) throw new ApiError(404, 'revision_not_found', `Revision ${revision} is not retained.`, { currentRevision: auth.row.revision });
      normalizedJson = r.normalized_json;
    }
    // Re-validate structure of the stored record's source is unnecessary: it was validated on write.
    const pubId = randomId(12);
    const snapshot = { schemaVersion: 1, scene: JSON.parse(normalizedJson) as NormalizedSceneV1 };
    await store.insertPublication(env.DB, {
      id: pubId,
      scene_id: id,
      revision,
      snapshot_json: JSON.stringify(snapshot),
      created_at: now,
    });
    const out = {
      id: pubId,
      revision,
      createdAt: iso(now),
      watchUrl: watchUrl(origin, pubId),
      apiUrl: `${origin}/api/v1/publications/${pubId}`,
      note: 'This snapshot is immutable. Later edits do not change it; publish again for a new link. Deleting the draft removes it.',
      next: [
        'Give the creator watchUrl. Anyone with it can watch; it contains no credentials.',
        'Later revisions do not change this link. Publish again if the creator wants a newer version shared.',
      ],
    };
    const text = JSON.stringify(out, null, 2) + '\n';
    await completeIdempotent(env.DB, idem, 201, text, false);
    return new Response(text, {
      status: 201,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', location: out.apiUrl },
    });
  } catch (e) {
    await abandonIdempotent(env.DB, idem);
    throw e;
  }
}

async function listPublicationsOp(request: Request, env: Env, id: string, origin: string, now: number): Promise<Response> {
  await authorize(request, env, id, now);
  const pubs = await store.listPublications(env.DB, id);
  return json({
    publications: pubs.map((p) => ({ id: p.id, revision: p.revision, createdAt: iso(p.created_at), watchUrl: watchUrl(origin, p.id) })),
    next: ['Watch links are safe to share. Each shows the revision it was published from.'],
  });
}

export async function readPublication(request: Request, env: Env, pubId: string, origin: string): Promise<Response> {
  if (!PUB_ID_RE.test(pubId)) {
    throw new ApiError(404, 'publication_not_found', 'No published journey has that id.');
  }
  const row = await store.getPublication(env.DB, pubId);
  if (!row) {
    if (await store.isPublicationDeleted(env.DB, pubId)) {
      throw new ApiError(410, 'publication_deleted', 'The owner deleted this journey.', {}, { 'cache-control': 'public, no-cache' });
    }
    throw new ApiError(404, 'publication_not_found', 'No published journey has that id.');
  }
  // Immutable content, but every view revalidates so owner deletion takes effect immediately.
  const etag = `"${row.id}"`;
  const cache = { 'cache-control': 'public, no-cache', etag };
  if (etagMatches(request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers: cache });
  const snap = JSON.parse(row.snapshot_json) as { scene: NormalizedSceneV1 };
  return json(
    {
      id: row.id,
      revision: row.revision,
      createdAt: iso(row.created_at),
      watchUrl: watchUrl(origin, row.id),
      scene: snap.scene,
      links: {
        schema: `${origin}/schemas/scene-v1.json`,
        docs: `${origin}/agent-docs`,
        storyboard: `${origin}/api/v1/publications/${row.id}/storyboard`,
      },
      next: [`To make a journey of your own, read ${origin}/agent-docs.`],
    },
    200,
    cache,
  );
}

async function deleteOp(request: Request, env: Env, id: string, now: number): Promise<Response> {
  const auth = await authorize(request, env, id, now);
  requireOwner(auth);
  const removed = await store.deleteScene(env.DB, id, now);
  return json({
    deleted: true,
    id,
    publicationsDeleted: removed,
    note: 'Watch links now report that the journey was deleted. A watch page that is already open keeps playing until it is reloaded.',
    next: ['Tell the creator the draft and all its watch links are deleted. This cannot be undone.'],
  }, 200, { 'set-cookie': clearCookie(id, request) });
}

async function rotateEditOp(request: Request, env: Env, id: string, origin: string, now: number): Promise<Response> {
  const auth = await authorize(request, env, id, now);
  requireOwner(auth);
  const token = newToken('edit');
  await store.rotateEditCredential(env.DB, id, await sha256Hex(token));
  return json({
    id,
    credentials: { edit: token },
    previewUrl: `${origin}/s/${id}#k=${token}`,
    note: 'The previous edit credential and all browser edit sessions no longer work.',
    next: ['Give the creator the new previewUrl. The old preview link no longer works.'],
  });
}

function isSecure(request: Request) {
  return new URL(request.url).protocol === 'https:';
}

function sessionCookie(id: string, token: string, request: Request) {
  return [
    `${sessionCookieName(id)}=${token}`,
    'Path=/api/v1/',
    `Max-Age=${SESSION_TTL_MS / 1000}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(isSecure(request) ? ['Secure'] : []),
  ].join('; ');
}

function clearCookie(id: string, request: Request) {
  return [`${sessionCookieName(id)}=`, 'Path=/api/v1/', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict', ...(isSecure(request) ? ['Secure'] : [])].join('; ');
}

/** Exchange a credential from the URL fragment for an HttpOnly session cookie scoped to the API. */
async function createSessionOp(request: Request, env: Env, id: string, now: number): Promise<Response> {
  if (!bearerToken(request)) {
    throw new ApiError(401, 'credential_required', 'Send the credential as Authorization: Bearer to start a browser session.');
  }
  if (request.headers.get('x-routereplay-client') !== 'web') {
    throw new ApiError(403, 'csrf_rejected', 'Sessions are only for the Route Replay page. Agents should keep using bearer credentials.');
  }
  await enforceLimit(env.DB, limits(env).sessionsPerClient, await clientSubject(request, env), now);
  const auth = await authorize(request, env, id, now);
  const token = newToken('session');
  await store.insertSession(env.DB, {
    id_hash: await sha256Hex(token),
    scene_id: id,
    role: auth.role,
    generation: auth.row.edit_generation,
    created_at: now,
    expires_at: now + SESSION_TTL_MS,
  });
  return json(
    { id, capabilities: capabilities(auth.role), expiresAt: iso(now + SESSION_TTL_MS) },
    201,
    { 'set-cookie': sessionCookie(id, token, request) },
  );
}

async function deleteSessionOp(request: Request, env: Env, id: string): Promise<Response> {
  const cookie = parseCookies(request.headers.get('cookie')).get(sessionCookieName(id));
  if (cookie && TOKEN_RE.test(cookie)) await store.deleteSession(env.DB, await sha256Hex(cookie));
  return json({ signedOut: true }, 200, { 'set-cookie': clearCookie(id, request) });
}

async function validateOp(request: Request, now: number): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const frames = query.has('storyboard') ? parseFrames(query.get('storyboard') || String(STORYBOARD_FRAMES.default)) : null;
  const input = await readJsonBody(request);
  const result = validateScene(input, { ...validateOptions, now });
  if (!result.ok) throw validationError(result);
  const warnings = sceneWarnings(result.normalized, now);
  return json({
    valid: true,
    normalized: result.normalized,
    warnings,
    ...(frames ? { storyboard: buildStoryboard(result.normalized, undefined, frames) } : {}),
    note: 'Nothing was saved. POST /api/v1/scenes to create a draft.',
    next: [
      ...warningNext(warnings),
      'To save it, POST the spec to /api/v1/scenes for a new draft, or PUT it to the existing draft with expectedRevision when revising.',
      ...(frames ? [] : ['Add ?storyboard=8 to see keyframes of the animation before saving.']),
    ],
  });
}

function parseFrames(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < STORYBOARD_FRAMES.min || n > STORYBOARD_FRAMES.max) {
    throw new ApiError(400, 'invalid_query', `frames must be an integer from ${STORYBOARD_FRAMES.min} to ${STORYBOARD_FRAMES.max}.`);
  }
  return n;
}

function parseSeconds(raw: string, name: string): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n < 0) {
    throw new ApiError(400, 'invalid_query', `${name} must be a number of seconds from 0.`);
  }
  return n;
}

/** Storyboard keyframes (JSON) or the SVG sketch for a normalized scene. */
function storyboardResponse(request: Request, scene: NormalizedSceneV1, svg: boolean, cache: string, svgUrl: string): Response {
  const q = new URL(request.url).searchParams;
  const at = q.get('at');
  let times: number[] | undefined;
  if (at !== null) {
    const list = at.split(',');
    if (list.length < 1 || list.length > STORYBOARD_FRAMES.max) {
      throw new ApiError(400, 'invalid_query', `at takes 1 to ${STORYBOARD_FRAMES.max} comma-separated times in seconds.`);
    }
    times = list.map((v) => parseSeconds(v, 'at'));
  }
  const frames = q.has('frames') ? parseFrames(q.get('frames')!) : STORYBOARD_FRAMES.default;
  const board = buildStoryboard(scene, times, frames);
  if (svg) {
    const night = q.has('night') ? parseSeconds(q.get('night')!, 'night') : 0;
    return new Response(storyboardSvg(scene, board, night), {
      headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': cache, 'x-content-type-options': 'nosniff' },
    });
  }
  return json(
    {
      ...board,
      svg: svgUrl,
      next: [
        'Compare the keyframes with what the creator asked for. onScreenSeconds shows how long each leg and stop lasts.',
        `For a picture, GET ${svgUrl} (add ?night=<seconds> to move the day/night line).`,
      ],
    },
    200,
    { 'cache-control': cache },
  );
}

async function sceneStoryboardOp(request: Request, env: Env, id: string, origin: string, now: number, svg: boolean): Promise<Response> {
  const auth = await authorize(request, env, id, now);
  const scene = JSON.parse(auth.row.normalized_json) as NormalizedSceneV1;
  return storyboardResponse(request, scene, svg, 'private, no-store', `${origin}/api/v1/scenes/${id}/storyboard.svg`);
}

async function publicationStoryboardOp(request: Request, env: Env, pubId: string, origin: string, svg: boolean): Promise<Response> {
  const row = PUB_ID_RE.test(pubId) ? await store.getPublication(env.DB, pubId) : null;
  if (!row) {
    if (PUB_ID_RE.test(pubId) && (await store.isPublicationDeleted(env.DB, pubId))) {
      throw new ApiError(410, 'publication_deleted', 'The owner deleted this journey.');
    }
    throw new ApiError(404, 'publication_not_found', 'No published journey has that id.');
  }
  const scene = (JSON.parse(row.snapshot_json) as { scene: NormalizedSceneV1 }).scene;
  return storyboardResponse(request, scene, svg, 'public, no-cache', `${origin}/api/v1/publications/${pubId}/storyboard.svg`);
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Airport lookup with optional offset resolution for a local wall time (no storage access). */
function airportOp(request: Request, code: string): Response {
  const airport = /^[A-Z]{3}$/.test(code) ? lookupAirport(code) : undefined;
  if (!airport) {
    throw new ApiError(404, 'unknown_airport', `Unknown airport code "${code}".`, {
      hint: 'Use the uppercase 3-letter IATA code of an airport with scheduled passenger service.',
    });
  }
  const local = new URL(request.url).searchParams.get('local');
  let resolution: unknown;
  if (local !== null) {
    const m = LOCAL_RE.exec(local);
    if (!m) {
      throw new ApiError(400, 'invalid_local_time', 'local must look like 2031-03-30T06:40 (no offset).');
    }
    const wall = { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]!, second: m[6] ? +m[6] : 0 };
    const options = resolveWallTime(airport.timeZone, wall);
    resolution = {
      local,
      matches: options.map((o) => ({
        offset: formatOffset(o.offsetMinutes),
        timestamp: formatLocalTimestamp(o.utcMs, o.offsetMinutes),
        utc: formatUtc(o.utcMs),
      })),
      note:
        options.length === 0
          ? 'This local time does not exist (clocks skip forward). Confirm the schedule with the creator.'
          : options.length === 2
            ? 'This local time occurs twice (clocks fall back). Ask which one was meant.'
            : 'Use timestamp in the scene spec.',
    };
  }
  return json(
    {
      ...airport,
      airportDataVersion: AIRPORT_DATA_VERSION,
      ...(resolution ? { resolution } : {}),
      next: [
        resolution
          ? 'Copy a timestamp from resolution.matches into the spec. If there are none or two, ask the creator.'
          : 'Add ?local=YYYY-MM-DDTHH:MM to get the exact offset for a local time.',
      ],
    },
    200,
    { 'cache-control': 'public, max-age=86400' },
  );
}

function index(origin: string): Response {
  return json({
    name: 'Route Replay API',
    version: 1,
    docs: `${origin}/agent-docs`,
    schema: `${origin}/schemas/scene-v1.json`,
    limits: {
      maxPayloadBytes: LIMITS.maxPayloadBytes,
      maxLegs: LIMITS.maxLegs,
      maxDurationSeconds: LIMITS.maxDurationSeconds,
      maxTitleLength: LIMITS.maxTitleLength,
    },
    endpoints: [
      'GET /api/v1/airports/{IATA}?local={YYYY-MM-DDTHH:MM}',
      'POST /api/v1/validate',
      'POST /api/v1/scenes',
      'GET /api/v1/scenes/{id}',
      'PUT /api/v1/scenes/{id}',
      'DELETE /api/v1/scenes/{id}',
      'GET /api/v1/scenes/{id}/revisions',
      'GET /api/v1/scenes/{id}/revisions/{revision}',
      'GET /api/v1/scenes/{id}/publications',
      'POST /api/v1/scenes/{id}/publications',
      'POST /api/v1/scenes/{id}/credentials/edit',
      'GET /api/v1/scenes/{id}/storyboard?frames={n}|at={seconds,...}',
      'POST /api/v1/scenes/{id}/viewer',
      'POST /api/v1/scenes/{id}/activity',
      'GET /api/v1/scenes/{id}/storyboard.svg?night={seconds}',
      'GET /api/v1/publications/{id}',
      'GET /api/v1/publications/{id}/storyboard',
      'GET /api/v1/publications/{id}/storyboard.svg',
      'GET /api/v1/weather/gfs/{cycle}/{hour}',
    ],
    next: [`Read ${origin}/agent-docs before creating a journey.`],
  }, 200, { 'cache-control': 'public, max-age=300' });
}

/** Move open previews to a moment, e.g. when the creator asks "show me the layover". */
async function viewerOp(request: Request, env: Env, id: string, now: number): Promise<Response> {
  const auth = await authorize(request, env, id, now);
  const body = await readJsonBody(request);
  const seek = (body as { seek?: unknown } | null)?.seek;
  if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).some((k) => k !== 'seek')) {
    throw new ApiError(400, 'invalid_body', 'Send {"seek": <seconds>}.');
  }
  const tl = buildTimeline(JSON.parse(auth.row.normalized_json) as NormalizedSceneV1);
  if (typeof seek !== 'number' || !Number.isFinite(seek) || seek < 0 || seek > tl.duration) {
    throw new ApiError(400, 'invalid_body', `seek must be a number of seconds from 0 to ${tl.duration}.`, {
      hint: 'Storyboard keyframes give the time (t) of each moment.',
    });
  }
  if (!env.LIVE) throw new ApiError(501, 'live_unavailable', 'Live updates are not configured on this server.');
  const t = Math.round(seek * 100) / 100;
  const res = await env.LIVE.get(env.LIVE.idFromName(id)).fetch('https://live/seek', {
    method: 'POST',
    body: JSON.stringify({ type: 'seek', t }),
  });
  const { previews } = (await res.json()) as { previews: number };
  return json({
    delivered: previews,
    at: keyframeAt(tl, t),
    next: previews
      ? ['The creator\'s preview is paused at this moment. Move it only when they ask, or once to show a finished change.']
      : ['No preview is open, so nothing moved. Give the creator the preview link if they want to look.'],
  });
}

/** Show or clear "Your agent is working" on open previews. */
async function activityOp(request: Request, env: Env, id: string, now: number): Promise<Response> {
  await authorize(request, env, id, now);
  const body = (await readJsonBody(request)) as { state?: unknown; message?: unknown } | null;
  if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).some((k) => k !== 'state' && k !== 'message')) {
    throw new ApiError(400, 'invalid_body', 'Send {"state": "working", "message": "..."} or {"state": "idle"}.');
  }
  if (body.state !== 'working' && body.state !== 'idle') {
    throw new ApiError(400, 'invalid_body', 'state must be "working" or "idle".');
  }
  const message = cleanActivityMessage(body.message);
  if (message === null) {
    throw new ApiError(400, 'invalid_body', `message must be plain text of at most ${ACTIVITY_MESSAGE_MAX} characters.`);
  }
  if (!env.LIVE) throw new ApiError(501, 'live_unavailable', 'Live updates are not configured on this server.');
  const res = await env.LIVE.get(env.LIVE.idFromName(id)).fetch('https://live/activity', {
    method: 'POST',
    body: JSON.stringify(body.state === 'working' ? { state: 'working', message } : { state: 'idle' }),
  });
  const out = (await res.json()) as { previews: number; activity: { message: string; expiresAt: number } | null };
  return json({
    activity: out.activity
      ? { state: 'working', message: out.activity.message, expiresInSeconds: Math.round((out.activity.expiresAt - now) / 1000) }
      : { state: 'idle' },
    previews: out.previews,
    next:
      body.state === 'working'
        ? ['Open previews show this for 3 minutes unless you renew it. Send {"state": "idle"} when you finish.']
        : ['Open previews no longer show that you are working.'],
  });
}

/** Tell open previews of a draft that it changed. They refetch it through the normal read. */
function notifyLive(env: Env, ctx: Ctx, id: string): void {
  if (!env.LIVE) return;
  const stub = env.LIVE.get(env.LIVE.idFromName(id));
  const p = stub.fetch('https://live/notify', { method: 'POST', body: '{"type":"changed"}' }).then(
    () => undefined,
    () => undefined,
  );
  if (ctx.waitUntil) ctx.waitUntil(p);
}

/** Upgrade an authorized browser session (or bearer client) to the draft's live-update socket. */
async function liveOp(request: Request, env: Env, id: string, now: number): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    throw new ApiError(426, 'upgrade_required', 'Connect to this endpoint with a WebSocket.');
  }
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new ApiError(403, 'csrf_rejected', 'Live updates are only for the Route Replay page.');
  }
  await authorize(request, env, id, now);
  if (!env.LIVE) throw new ApiError(501, 'live_unavailable', 'Live updates are not configured on this server.');
  return env.LIVE.get(env.LIVE.idFromName(id)).fetch(request);
}

function methodNotAllowed(allowed: string[]): ApiError {
  return new ApiError(405, 'method_not_allowed', `Use ${allowed.join(' or ')}.`, {}, { allow: allowed.join(', ') });
}

/** Route /api/v1/* requests. Throws ApiError for expected failures. */
export async function routeApi(request: Request, env: Env, ctx: Ctx, now = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  const origin = originOf(request, env);
  const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1); // ['api','v1',...]
  if (parts[0] !== 'api' || parts[1] !== 'v1') throw new ApiError(404, 'not_found', 'Unknown API version. Use /api/v1.');
  const [, , resource, id, sub, subId] = parts;
  const m = request.method.toUpperCase();

  if (resource === undefined) return index(origin);
  if (resource === 'validate' && id === undefined) {
    if (m !== 'POST') throw methodNotAllowed(['POST']);
    return validateOp(request, now);
  }
  if (resource === 'airports' && id && sub === undefined) {
    if (m !== 'GET' && m !== 'HEAD') throw methodNotAllowed(['GET']);
    return airportOp(request, id);
  }
  if (resource === 'publications' && id && sub === undefined) {
    if (m !== 'GET' && m !== 'HEAD') throw methodNotAllowed(['GET']);
    return readPublication(request, env, id, origin);
  }
  if (resource === 'weather' && id === 'gfs' && sub && subId && parts.length === 6) {
    if (m !== 'GET' && m !== 'HEAD') throw methodNotAllowed(['GET']);
    return weatherFieldsOp(request, sub, subId, now, ctx.waitUntil?.bind(ctx));
  }
  if (resource === 'publications' && id && (sub === 'storyboard' || sub === 'storyboard.svg') && subId === undefined) {
    if (m !== 'GET' && m !== 'HEAD') throw methodNotAllowed(['GET']);
    return publicationStoryboardOp(request, env, id, origin, sub === 'storyboard.svg');
  }
  if (resource === 'scenes') {
    // Successful changes to a draft are pushed to its open previews.
    const changed = (r: Response) => {
      if (r.ok && id) notifyLive(env, ctx, id);
      return r;
    };
    if (id === undefined) {
      if (m !== 'POST') throw methodNotAllowed(['POST']);
      return createScene(request, env, ctx, origin, now);
    }
    if (sub === undefined) {
      if (m === 'GET' || m === 'HEAD') return readScene(request, env, id, origin, now);
      if (m === 'PUT') return changed(await replaceSceneOp(request, env, id, origin, now));
      if (m === 'DELETE') return changed(await deleteOp(request, env, id, now));
      throw methodNotAllowed(['GET', 'PUT', 'DELETE']);
    }
    if (sub === 'revisions' && subId === undefined) {
      if (m !== 'GET') throw methodNotAllowed(['GET']);
      return listRevisionsOp(request, env, id, now);
    }
    if (sub === 'revisions' && subId !== undefined && parts.length === 6) {
      if (m !== 'GET') throw methodNotAllowed(['GET']);
      const rev = Number(subId);
      if (!Number.isInteger(rev) || rev < 1) throw new ApiError(400, 'invalid_revision', 'Revision must be a positive integer.');
      return readRevisionOp(request, env, id, rev, now);
    }
    if (sub === 'publications' && subId === undefined) {
      if (m === 'POST') return changed(await publishOp(request, env, id, origin, now));
      if (m === 'GET') return listPublicationsOp(request, env, id, origin, now);
      throw methodNotAllowed(['GET', 'POST']);
    }
    if (sub === 'credentials' && subId === 'edit' && parts.length === 6) {
      if (m !== 'POST') throw methodNotAllowed(['POST']);
      return changed(await rotateEditOp(request, env, id, origin, now));
    }
    if ((sub === 'storyboard' || sub === 'storyboard.svg') && subId === undefined) {
      if (m !== 'GET' && m !== 'HEAD') throw methodNotAllowed(['GET']);
      return sceneStoryboardOp(request, env, id, origin, now, sub === 'storyboard.svg');
    }
    if (sub === 'viewer' && subId === undefined) {
      if (m !== 'POST') throw methodNotAllowed(['POST']);
      return viewerOp(request, env, id, now);
    }
    if (sub === 'activity' && subId === undefined) {
      if (m !== 'POST') throw methodNotAllowed(['POST']);
      return activityOp(request, env, id, now);
    }
    if (sub === 'live' && subId === undefined) {
      if (m !== 'GET') throw methodNotAllowed(['GET']);
      return liveOp(request, env, id, now);
    }
    if (sub === 'session' && subId === undefined) {
      if (m === 'POST') return createSessionOp(request, env, id, now);
      if (m === 'DELETE') return deleteSessionOp(request, env, id);
      throw methodNotAllowed(['POST', 'DELETE']);
    }
  }
  throw new ApiError(404, 'not_found', `No API route for ${m} ${url.pathname}.`, { hint: `See ${origin}/agent-docs.` });
}

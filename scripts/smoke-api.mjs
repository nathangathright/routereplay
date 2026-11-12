#!/usr/bin/env node
/**
 * End-to-end HTTP smoke test against a running Route Replay (local or deployed).
 * Creates a synthetic draft, revises it, publishes it, checks public isolation, then deletes it.
 *
 * Usage: BASE_URL=http://127.0.0.1:8788 node scripts/smoke-api.mjs
 */
import { randomUUID } from 'node:crypto';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:8788').replace(/\/$/, '');
const spec = {
  schemaVersion: 1,
  title: 'Smoke test (synthetic)',
  legs: [
    { id: 'lhr-jfk', from: 'LHR', to: 'JFK', departure: '2031-06-01T10:00:00+01:00', arrival: '2031-06-01T13:00:00-04:00', aircraft: 'B77W' },
    { id: 'jfk-sfo', from: 'JFK', to: 'SFO', departure: '2031-06-01T16:00:00-04:00', arrival: '2031-06-01T19:30:00-07:00', aircraft: 'A21N' },
  ],
};

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!cond) failures++;
}

async function call(method, path, { token, body, headers = {} } = {}) {
  const h = { 'user-agent': 'routereplay-smoke/1.0', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

const docs = await call('GET', '/agent-docs');
check('agent docs served', docs.status === 200 && docs.text.includes(`${BASE}/api/v1/scenes`));
check('agent docs have no install step', !/install|\/skills\//i.test(docs.text));
const skill = await call('GET', '/skills/routereplay-web.zip');
check('skill download removed', !/zip/.test(skill.headers.get('content-type') ?? ''), skill.headers.get('content-type'));
const schema = await call('GET', '/schemas/scene-v1.json');
check('schema served', schema.status === 200 && schema.json?.properties?.legs);

const key = randomUUID();
const created = await call('POST', '/api/v1/scenes', { body: spec, headers: { 'idempotency-key': key } });
check('create', created.status === 201, `status ${created.status}`);
const { id, credentials } = created.json;
const retry = await call('POST', '/api/v1/scenes', { body: spec, headers: { 'idempotency-key': key } });
check('idempotent retry returns same draft', retry.json?.id === id);
check('create returns next steps', Array.isArray(created.json.next) && created.json.next.length > 0);
check('create returns advisory warnings (2031 is far off)', created.json.warnings?.[0]?.code === 'far_future_or_past');

// Live updates: a browser-style session opens the draft's socket and should receive pushes.
const sessionRes = await fetch(`${BASE}/api/v1/scenes/${id}/session`, {
  method: 'POST',
  headers: { authorization: `Bearer ${credentials.edit}`, 'x-routereplay-client': 'web', 'user-agent': 'routereplay-smoke/1.0' },
});
const cookie = (sessionRes.headers.get('set-cookie') ?? '').split(';')[0];
check('browser session for live updates', sessionRes.status === 201 && cookie.startsWith('rr_s_'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function openSocket() {
  const messages = [];
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/v1/scenes/${id}/live`, {
    headers: { cookie, origin: BASE, 'user-agent': 'routereplay-smoke/1.0' },
  });
  ws.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data))));
  const ok = await new Promise((resolve) => {
    ws.addEventListener('open', () => resolve(true));
    ws.addEventListener('error', () => resolve(false));
    setTimeout(() => resolve(false), 10000);
  });
  return { ws, messages, ok };
}
/** Wait up to 5 s for a message matching pred. */
async function waitFor(messages, pred) {
  for (let i = 0; i < 50; i++) {
    const m = messages.find(pred);
    if (m) return m;
    await sleep(100);
  }
  return null;
}
const { ws: socket, messages: liveMessages, ok: opened } = await openSocket();
check('live socket opens', opened);
const changes = () => liveMessages.filter((m) => m.type === 'changed').length;

const read = await call('GET', `/api/v1/scenes/${id}`, { token: credentials.edit });
check('read with edit credential', read.status === 200 && read.json.capabilities.role === 'edit');
check('reads never return credentials', !/rr_(edit|owner)_/.test(read.text));
check('anonymous read rejected', (await call('GET', `/api/v1/scenes/${id}`)).status === 401);
const etag = read.headers.get('etag');
check('conditional read', (await call('GET', `/api/v1/scenes/${id}`, { token: credentials.edit, headers: { 'if-none-match': etag } })).status === 304);

const revised = structuredClone(spec);
revised.presentation = { endHoldSeconds: 4, legWeights: { 'lhr-jfk': 2 } };
const put = await call('PUT', `/api/v1/scenes/${id}`, { token: credentials.edit, body: { expectedRevision: 1, spec: revised } });
check('revise', put.status === 200 && put.json.revision === 2);
check('revise returns warnings and next steps', Array.isArray(put.json.warnings) && put.json.next?.some((n) => n.includes('storyboard')));
const board = await call('GET', `/api/v1/scenes/${id}/storyboard?frames=5`, { token: credentials.edit });
check('draft storyboard', board.status === 200 && board.json.keyframes.length === 5 && board.json.keyframes[0].phase === 'start');
const sketch = await call('GET', `/api/v1/scenes/${id}/storyboard.svg`, { token: credentials.edit });
check('draft storyboard sketch', sketch.status === 200 && sketch.headers.get('content-type')?.startsWith('image/svg+xml') && sketch.text.includes('<polyline'));
check('revision pushed to the open preview socket', Boolean(await waitFor(liveMessages, (m) => m.type === 'changed')));

// Viewer context: the page reports where the creator paused; agents read it with the draft.
socket.send(JSON.stringify({ type: 'viewer', t: 7.5, paused: true, revision: 2 }));
let viewer = null;
for (let i = 0; i < 25 && !viewer?.paused; i++) {
  await sleep(200);
  viewer = (await call('GET', `/api/v1/scenes/${id}`, { token: credentials.edit })).json?.viewer;
}
check('agent read includes where the creator paused', viewer?.open && viewer.paused && viewer.at?.t === 7.5 && typeof viewer.at.summary === 'string', JSON.stringify(viewer?.at?.summary));
const seek = await call('POST', `/api/v1/scenes/${id}/viewer`, { token: credentials.edit, body: { seek: 3 } });
check('seek delivered to the open preview', seek.json?.delivered === 1 && Boolean(await waitFor(liveMessages, (m) => m.type === 'seek' && m.t === 3)));

// Activity: shown on open previews, sent to previews that connect while it lasts, cleared by idle.
const working = await call('POST', `/api/v1/scenes/${id}/activity`, { token: credentials.edit, body: { state: 'working', message: 'Smoke test checking things' } });
check('activity set', working.json?.activity?.state === 'working' && working.json.activity.expiresInSeconds === 180);
check('activity pushed to the open preview', Boolean(await waitFor(liveMessages, (m) => m.type === 'activity' && m.state === 'working')));
const second = await openSocket();
check('a preview that opens mid-activity sees it', second.ok && Boolean(await waitFor(second.messages, (m) => m.type === 'activity' && m.message === 'Smoke test checking things')));
second.ws.close();
check('agent read includes activity', (await call('GET', `/api/v1/scenes/${id}`, { token: credentials.edit })).json?.activity?.state === 'working');
await call('POST', `/api/v1/scenes/${id}/activity`, { token: credentials.edit, body: { state: 'idle' } });
check('idle clears activity on the preview', Boolean(await waitFor(liveMessages, (m) => m.type === 'activity' && m.state === 'idle')));
const conflict = await call('PUT', `/api/v1/scenes/${id}`, { token: credentials.edit, body: { expectedRevision: 1, spec: revised } });
check('stale revision conflicts', conflict.status === 409 && conflict.json.error.currentRevision === 2);
const bad = structuredClone(revised);
bad.legs[1].departure = '2031-06-01T16:00:00-05:00';
const invalid = await call('PUT', `/api/v1/scenes/${id}`, { token: credentials.edit, body: { expectedRevision: 2, spec: bad } });
check('invalid revision rejected with hint', invalid.status === 422 && invalid.json.error.issues[0].code === 'offset_mismatch');

check('edit credential cannot publish', (await call('POST', `/api/v1/scenes/${id}/publications`, { token: credentials.edit, body: { revision: 2 } })).status === 403);
const pub = await call('POST', `/api/v1/scenes/${id}/publications`, { token: credentials.owner, body: { revision: 1 }, headers: { 'idempotency-key': randomUUID() } });
check('publish revision 1', pub.status === 201);
const publicRead = await call('GET', `/api/v1/publications/${pub.json.id}`);
check('public read without credentials', publicRead.status === 200);
check('public data has no secrets or draft id', !/rr_(edit|owner|sess)_/.test(publicRead.text) && !publicRead.text.includes(id));
check('public data has no viewer state or activity', !/viewer|activity|Smoke test checking/.test(publicRead.text));
check('publication isolated from later revision', publicRead.json.scene.presentation.endHoldSeconds !== 4);
const pubBoard = await call('GET', `/api/v1/publications/${pub.json.id}/storyboard`);
check('public storyboard without credentials', pubBoard.status === 200 && pubBoard.json.aspectRatio === '16:9' && !pubBoard.text.includes(id));
const watchHtml = await call('GET', `/w/${pub.json.id}`, { headers: { accept: 'text/html' } });
check('watch page advertises JSON', watchHtml.text.includes(`/api/v1/publications/${pub.json.id}`));

check('edit credential cannot delete', (await call('DELETE', `/api/v1/scenes/${id}`, { token: credentials.edit })).status === 403);
const del = await call('DELETE', `/api/v1/scenes/${id}`, { token: credentials.owner });
check('owner deletes', del.status === 200);
for (let i = 0; i < 50 && changes() < 3; i++) await sleep(100);
check('deletion pushed to the open preview socket', changes() === 3, `${changes()} change messages`);
socket.close();
check('deleted publication is gone', (await call('GET', `/api/v1/publications/${pub.json.id}`)).status === 410);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

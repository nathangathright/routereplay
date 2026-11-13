#!/usr/bin/env node
/**
 * Worker CPU per request in local workerd, from V8 CPU profiles taken through the dev server's inspector.
 * Waiting on the model, D1 or fetch doesn't count (see busyMs).
 *
 *   node --use-system-ca scripts/compose-eval/cpu-profile.mjs --inspector ws://127.0.0.1:9230/ws \
 *     --url https://routereplay.localhost --model gemma-4-26b [--n 8] [--path /api/v1/compose]
 *
 * Find the inspector with: curl -s http://127.0.0.1:<port>/json (the port workerd listens on besides the HTTP one).
 * Each request is a real model call. --path /api/v1/validate --from run.json profiles the existing dry-run endpoint
 * for comparison, posting the complete specs from a saved compose run (no model calls).
 */
import { readFileSync } from 'node:fs';
import { CASES } from './cases.mjs';

const args = process.argv.slice(2);
const arg = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? d : args[i + 1];
};
const inspector = arg('inspector');
const url = arg('url').replace(/\/$/, '');
const model = arg('model', 'gemma-4-26b');
const n = Number(arg('n', '8'));
const apiPath = arg('path', '/api/v1/compose');

// The inspector proxy insists on an Origin header (Node's WebSocket accepts headers as a second argument).
const ws = new WebSocket(inspector, { headers: { Origin: 'https://devtools.devprod.cloudflare.dev' } });
await new Promise((ok, fail) => {
  ws.onopen = ok;
  ws.onerror = fail;
});
let seq = 0; // Small ids, clear of the 100000000+ range the dev server's own inspector client uses.
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  // The dev server's inspector proxy echoes each request back first; the reply is the message with a result.
  if (msg.id && pending.has(msg.id) && ('result' in msg || 'error' in msg)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((ok) => {
    const id = ++seq;
    pending.set(id, ok);
    ws.send(JSON.stringify({ id, method, params }));
  });

// Through the dev server's proxy only Profiler.stop answers with a result, so the others aren't awaited.
const fire = (method, params = {}) => ws.send(JSON.stringify({ id: ++seq, method, params }));
fire('Profiler.enable');
fire('Profiler.setSamplingInterval', { interval: 50 });

/**
 * workerd samples only while the isolate runs, so a wait on I/O shows up as one long gap after the last sample
 * before it. Busy time counts the gaps up to GAP_US and nothing for (idle).
 */
const GAP_US = 500;
function busyMs(profile) {
  const idle = new Set(profile.nodes.filter((nd) => nd.callFrame.functionName === '(idle)').map((nd) => nd.id));
  let busy = 0;
  profile.samples.forEach((id, i) => {
    if (!idle.has(id)) busy += Math.min(profile.timeDeltas[i + 1] ?? 0, GAP_US);
  });
  return busy / 1000;
}

const post = (path, body) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'routereplay-cpu-profile/1.0' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

const results = [];
const saved = arg('from') ? Object.values(JSON.parse(readFileSync(arg('from'), 'utf8')).runs).flat() : [];
const cases = CASES.filter((c) => c.ask.length === 0).slice(0, n);
for (const c of cases) {
  const body = apiPath === '/api/v1/validate' ? saved.find((r) => r.case === c.id && r.body?.complete)?.body.spec : { text: c.text, model };
  if (!body) continue;
  fire('Profiler.start');
  await new Promise((ok) => setTimeout(ok, 50));
  const res = await post(apiPath, body);
  const { result } = await send('Profiler.stop');
  const ms = busyMs(result.profile);
  results.push(ms);
  console.log(`${c.id}: ${res.status} ${ms.toFixed(2)} ms busy`);
}
results.sort((a, b) => a - b);
console.log(JSON.stringify({ path: apiPath, n: results.length, medianMs: +results[Math.floor(results.length / 2)].toFixed(2), maxMs: +results.at(-1).toFixed(2) }));
ws.close();
process.exit(0);

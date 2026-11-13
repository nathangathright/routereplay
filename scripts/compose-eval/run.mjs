#!/usr/bin/env node
/**
 * Compare extraction models on the compose test set.
 *
 *   node --use-system-ca scripts/compose-eval/run.mjs --url https://routereplay.localhost [--models gemma-4-26b,claude-haiku-5-5] [--cases a,b] [--out run.json]
 *   node --use-system-ca scripts/compose-eval/run.mjs --retry run.json --out run.json      # rerun failed requests only
 *   node scripts/compose-eval/run.mjs --rescore run.json [--out run2.json]   # re-resolve saved model output with the current resolver; no model calls
 *   node scripts/compose-eval/run.mjs --cpu run.json                         # Worker-side CPU of the resolver on saved model output (Node)
 *
 * Models named claude-* run from Node (see callClaude); the rest go through the local Worker.
 * --set holdout runs the held-out cases (default: the tuning cases; all: both).
 * --url is the local `npm run dev:worker` address (npx portless get routereplay), which needs high COMPOSE_LIMIT_*
 * values (.dev.vars). The Worker always uses its one model (gemma-4-26b); the other Workers AI models compared in
 * docs/decisions.md were run before the endpoint fixed its model. Every request asks for the model's intent (debug),
 * so a saved run can be re-scored after resolver changes without spending tokens again.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CASES as TUNING, HOLDOUT } from './cases.mjs';

const CASES = [...TUNING, ...HOLDOUT];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};

const airportRows = new Map(JSON.parse(readFileSync(path.join(root, 'src/server/airports/airports.json'), 'utf8')).rows.map((r) => [r[0], r]));
function km(a, b) {
  const [, , , , lat1, lon1] = airportRows.get(a) ?? [];
  const [, , , , lat2, lon2] = airportRows.get(b) ?? [];
  if (lat1 === undefined || lat2 === undefined) return Infinity;
  const r = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Score one result against its case. */
function score(c, body) {
  // The endpoint answers status 'ready'; the resolver (rescore, Claude runs) answers complete.
  const out = { pass: false, complete: body?.status === 'ready' || !!body?.complete, legsRight: 0, legsTotal: c.legs.length, asked: [], missedAsks: [], extraAsks: [], invented: [], legNotes: [] };
  if (!body || body.error) {
    out.legsTotal = c.legs.length;
    out.legNotes.push(body?.error?.code ?? 'no response');
    return out;
  }
  const keyOf = (q) => {
    if (q.field === 'year') return 'year';
    const m = /^\/legs\/(\d+)\/(\w+)/.exec(q.path);
    return m ? `${m[1]}.${m[2]}` : q.field;
  };
  out.asked = [...new Set(body.questions.map(keyOf))];
  out.missedAsks = c.ask.filter((k) => !out.asked.includes(k));
  out.extraAsks = out.asked.filter((k) => !c.ask.includes(k));
  const got = body.spec?.legs ?? [];
  out.legsTotal = Math.max(c.legs.length, got.length);
  c.legs.forEach((e, i) => {
    const g = got[i] ?? {};
    const wrong = [];
    const place = (field) => {
      const want = e[field];
      if (want === null) {
        if (g[field] !== undefined) {
          wrong.push(`${field} invented ${g[field]}`);
          out.invented.push(`${i}.${field}`);
        }
      } else if (typeof want === 'string') {
        if (g[field] !== want) wrong.push(`${field} ${g[field]} != ${want}`);
      } else if (!(km(g[field], want.near) <= want.km)) wrong.push(`${field} ${g[field]} not near ${want.near}`);
    };
    const time = (field, key) => {
      const want = e[key];
      const have = g[field];
      if (want === null) {
        if (have !== undefined && c.ask.includes(`${i}.${field}`)) {
          wrong.push(`${field} invented ${have}`);
          out.invented.push(`${i}.${field}`);
        } else if (have !== undefined) wrong.push(`${field} unexpected ${have}`);
        return;
      }
      const wall = want.slice(0, 16);
      const offset = want.slice(16);
      if (!have || have.slice(0, 16) !== wall || (offset && have.slice(19) !== offset)) wrong.push(`${field} ${have} != ${want}`);
    };
    place('from');
    place('to');
    time('departure', 'dep');
    time('arrival', 'arr');
    if (e.mode) {
      if (g.mode !== e.mode) wrong.push(`mode ${g.mode ?? g.aircraft} != ${e.mode}`);
    } else if (e.aircraft === null) {
      if (g.aircraft !== undefined) {
        wrong.push(`aircraft invented ${g.aircraft}`);
        out.invented.push(`${i}.aircraft`);
      }
    } else if (g.aircraft !== e.aircraft) wrong.push(`aircraft ${g.aircraft ?? g.mode} != ${e.aircraft}`);
    if (wrong.length === 0) out.legsRight++;
    else out.legNotes.push(`leg ${i}: ${wrong.join('; ')}`);
  });
  if (got.length > c.legs.length) out.legNotes.push(`${got.length - c.legs.length} extra leg(s)`);
  const legsOk = out.legsRight === c.legs.length && got.length === c.legs.length;
  out.pass = c.ask.length === 0 ? out.complete && legsOk : !out.complete && out.missedAsks.length === 0 && out.invented.length === 0;
  out.legsOk = legsOk;
  return out;
}

function summarize(model, runs) {
  const scored = runs.map((r) => ({ ...r, s: score(CASES.find((c) => c.id === r.case), r.body) }));
  const full = scored.filter((r) => CASES.find((c) => c.id === r.case).ask.length === 0);
  const asks = scored.filter((r) => CASES.find((c) => c.id === r.case).ask.length > 0);
  const legs = scored.reduce((a, r) => [a[0] + r.s.legsRight, a[1] + r.s.legsTotal], [0, 0]);
  const usage = scored.flatMap((r) => [r.body?.usage ?? []].flat());
  const sum = (f) => usage.reduce((s, u) => s + (f(u) ?? 0), 0);
  const lat = scored.map((r) => r.ms).filter(Boolean).sort((a, b) => a - b);
  const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
  const n = scored.length;
  return {
    model,
    cases: n,
    pass: scored.filter((r) => r.s.pass).length,
    fullValid: `${full.filter((r) => r.s.pass).length}/${full.length}`,
    rightQuestions: `${asks.filter((r) => r.s.pass).length}/${asks.length}`,
    invented: scored.reduce((s, r) => s + r.s.invented.length, 0),
    extraQuestions: scored.reduce((s, r) => s + r.s.extraAsks.length, 0),
    legAccuracy: `${legs[0]}/${legs[1]}`,
    errors: scored.filter((r) => !r.body || r.body.error).length,
    medianMs: pct(0.5),
    p90Ms: pct(0.9),
    inTokensAvg: Math.round(sum((u) => u.inputTokens) / n),
    outTokensAvg: Math.round(sum((u) => u.outputTokens) / n),
    neuronsAvg: usage.some((u) => u.neurons !== undefined) ? +(sum((u) => u.neurons) / n).toFixed(1) : undefined,
    // Workers AI usage reports neurons: $0.011 per 1,000 beyond the free allowance.
    usdPerRequest: +(sum((u) => u.usd ?? (u.neurons ?? 0) * 0.011e-3) / n).toFixed(6),
    details: scored.map((r) => ({ case: r.case, pass: r.s.pass, ms: r.ms, asked: r.s.asked, missed: r.s.missedAsks, extra: r.s.extraAsks, notes: r.s.legNotes, error: r.body?.error?.code })),
  };
}

function printTable(summaries) {
  const cols = ['model', 'pass', 'fullValid', 'rightQuestions', 'invented', 'extraQuestions', 'legAccuracy', 'errors', 'medianMs', 'p90Ms', 'inTokensAvg', 'outTokensAvg', 'neuronsAvg', 'usdPerRequest'];
  console.log(`| ${cols.join(' | ')} |\n|${cols.map(() => ' --- ').join('|')}|`);
  for (const s of summaries) console.log(`| ${cols.map((c) => (c === 'pass' ? `${s.pass}/${s.cases}` : (s[c] ?? '—'))).join(' | ')} |`);
  for (const s of summaries) {
    const fails = s.details.filter((d) => !d.pass);
    if (!fails.length) continue;
    console.log(`\n${s.model}: ${fails.length} failing`);
    for (const d of fails) console.log(`  ${d.case}${d.error ? ` [${d.error}]` : ''}: ${[...d.notes, d.missed.length ? `missed ${d.missed}` : '', d.extra.length ? `extra ${d.extra}` : ''].filter(Boolean).join(' | ')}`);
  }
}

/** Bundle the Worker's resolver so saved model output can be re-resolved or timed in Node. */
async function loadResolver() {
  const { build } = await import('esbuild');
  const dir = mkdtempSync(path.join(tmpdir(), 'compose-eval-'));
  const entry = path.join(dir, 'entry.ts');
  writeFileSync(
    entry,
    `export { resolveIntent } from ${JSON.stringify(path.join(root, 'src/server/compose/resolve.ts'))};
export { parseIntent, SYSTEM_PROMPT, INTENT_SCHEMA } from ${JSON.stringify(path.join(root, 'src/server/compose/intent.ts'))};
export { lookupAirport, searchAirports, AIRPORT_DATA_VERSION } from ${JSON.stringify(path.join(root, 'src/server/airports/index.ts'))};`,
  );
  const outfile = path.join(dir, 'resolver.mjs');
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
}

/**
 * Claude models run from Node with the official SDK (keeping it out of the Worker bundle), then resolve with the
 * Worker's own resolver, so results score the same way. Credentials: ANTHROPIC_API_KEY or an `ant auth login`
 * profile. --max-usd (default 0.5) stops the run before spending more.
 */
const CLAUDE = {
  'claude-haiku-5-5': { effort: 'low', usdPerMIn: 0.1, usdPerMOut: 0.5 },
  // The accuracy ceiling; medium effort keeps a full run near US$0.50.
  'claude-sonnet-5-5': { effort: 'medium', usdPerMIn: 2, usdPerMOut: 10 },
};
let claudeSpent = 0;
let claudeClient;
let resolver;

/** Claude's structured outputs document anyOf with null; the Workers AI models were run with type arrays. */
const anyOfNulls = (schema) =>
  JSON.parse(JSON.stringify(schema), (k, v) => (v && Array.isArray(v.type) ? { anyOf: v.type.map((t) => ({ type: t })) } : v));

async function callClaude(model, c) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  claudeClient ??= new Anthropic({ maxRetries: 1 });
  resolver ??= await loadResolver();
  const cfg = CLAUDE[model];
  const maxUsd = Number(arg('max-usd') ?? 0.5);
  const t0 = performance.now();
  let body;
  if (claudeSpent >= maxUsd) {
    body = { error: { code: 'budget_reached', message: `Stopped at US$${claudeSpent.toFixed(4)}.` } };
  } else {
    try {
      const message = await claudeClient.messages.create({
        model,
        max_tokens: 4096,
        system: resolver.SYSTEM_PROMPT,
        messages: [{ role: 'user', content: c.text }],
        output_config: { effort: cfg.effort, format: { type: 'json_schema', schema: anyOfNulls(resolver.INTENT_SCHEMA) } },
      });
      const usage = {
        model,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        usd: (message.usage.input_tokens * cfg.usdPerMIn + message.usage.output_tokens * cfg.usdPerMOut) / 1e6,
      };
      claudeSpent += usage.usd;
      // A refusal or a cut-off answer may not match the schema.
      const text = message.stop_reason === 'end_turn' ? message.content.find((b) => b.type === 'text')?.text : undefined;
      const intent = text ? resolver.parseIntent(text) : null;
      body = intent
        ? {
            ...resolver.resolveIntent(intent, c.text, {
              lookupAirport: resolver.lookupAirport,
              searchAirports: resolver.searchAirports,
              airportDataVersion: resolver.AIRPORT_DATA_VERSION,
              now: Date.now(),
            }),
            usage,
            intent,
          }
        : { error: { code: 'extraction_failed', message: `stop_reason ${message.stop_reason}` }, usage };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('No Anthropic credentials: set ANTHROPIC_API_KEY or run `ant auth login`.');
      if (e instanceof Anthropic.RateLimitError) body = { error: { code: 'rate_limited', message: e.message } };
      else if (e instanceof Anthropic.APIError) body = { error: { code: `anthropic_${e.status}`, message: e.message } };
      else throw e;
    }
  }
  const ms = Math.round(performance.now() - t0);
  process.stderr.write(`${model} ${c.id} ${ms} ms ${body.error ? body.error.code : body.complete || body.status === 'ready' ? 'complete' : `${body.questions.length} questions`} (spent US$${claudeSpent.toFixed(4)})\n`);
  return { case: c.id, ms, body };
}

async function callCompose(url, model, c) {
  if (model in CLAUDE) return callClaude(model, c);
  const t0 = performance.now();
  let body;
  try {
    const res = await fetch(`${url}/api/v1/compose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'routereplay-compose-eval/1.0' },
      body: JSON.stringify({ messages: [{ role: 'user', content: c.text }], debug: true }),
    });
    body = await res.json();
  } catch (e) {
    body = { error: { code: 'fetch_failed', message: String(e) } };
  }
  const ms = Math.round(performance.now() - t0);
  process.stderr.write(`${model} ${c.id} ${ms} ms ${body.error ? body.error.code : body.complete || body.status === 'ready' ? 'complete' : `${body.questions.length} questions`}\n`);
  return { case: c.id, ms, body };
}

async function runModels() {
  const url = String(arg('url') ?? process.env.COMPOSE_URL ?? '').replace(/\/$/, '');
  if (!url) throw new Error('Pass --url (npx portless get routereplay).');
  const models = String(arg('models') ?? 'gemma-4-26b').split(',');
  const only = arg('cases') ? String(arg('cases')).split(',') : null;
  const cases = (arg('set') === 'holdout' ? HOLDOUT : arg('set') === 'all' ? CASES : TUNING).filter((c) => !only || only.includes(c.id));
  const runs = {};
  await Promise.all(
    models.map(async (model) => {
      runs[model] = [];
      for (const c of cases) runs[model].push(await callCompose(url, model, c));
    }),
  );
  return { url, at: new Date().toISOString(), runs };
}

/** Run again only the requests that failed (network or server errors), keeping the rest. */
async function retry(saved) {
  for (const [model, list] of Object.entries(saved.runs)) {
    for (let i = 0; i < list.length; i++) {
      const code = list[i].body?.error?.code;
      if (code === 'fetch_failed' || code === 'internal_error' || code === 'model_unavailable') {
        list[i] = await callCompose(saved.url, model, CASES.find((c) => c.id === list[i].case));
      }
    }
  }
  return saved;
}

/** Re-resolve saved model output with the current resolver. */
async function rescore(saved) {
  const r = await loadResolver();
  const opts = { lookupAirport: r.lookupAirport, searchAirports: r.searchAirports, airportDataVersion: r.AIRPORT_DATA_VERSION, now: Date.now() };
  for (const list of Object.values(saved.runs)) {
    for (const run of list) {
      if (!run.body?.intent) continue;
      const { usage, intent } = run.body;
      run.body = { ...r.resolveIntent(r.parseIntent(intent), CASES.find((c) => c.id === run.case).text, opts), usage, intent };
    }
  }
  return saved;
}

async function cpu(saved) {
  const r = await loadResolver();
  const opts = { lookupAirport: r.lookupAirport, searchAirports: r.searchAirports, airportDataVersion: r.AIRPORT_DATA_VERSION, now: Date.now() };
  const intents = Object.values(saved.runs).flat().filter((run) => run.body?.intent).map((run) => [JSON.stringify(run.body.intent), CASES.find((c) => c.id === run.case).text]);
  // What the Worker does per request besides waiting: parse the model's JSON, resolve, validate, serialize the answer.
  const once = ([json, text]) => JSON.stringify(r.resolveIntent(r.parseIntent(json), text, opts));
  const first = process.cpuUsage();
  once(intents[0]);
  const firstMs = (process.cpuUsage(first).user + process.cpuUsage(first).system) / 1000;
  for (let k = 0; k < 3; k++) for (const t of intents) once(t);
  const t0 = process.cpuUsage();
  const reps = 20;
  for (let k = 0; k < reps; k++) for (const t of intents) once(t);
  const used = process.cpuUsage(t0);
  const warmMs = (used.user + used.system) / 1000 / (reps * intents.length);
  console.log(JSON.stringify({ intents: intents.length, firstCallMs: +firstMs.toFixed(2), warmMsPerRequest: +warmMs.toFixed(3) }));
}

const out = arg('out');
let saved;
if (arg('cpu')) {
  await cpu(JSON.parse(readFileSync(String(arg('cpu')), 'utf8')));
  process.exit(0);
} else if (arg('rescore')) saved = await rescore(JSON.parse(readFileSync(String(arg('rescore')), 'utf8')));
else if (arg('retry')) saved = await retry(JSON.parse(readFileSync(String(arg('retry')), 'utf8')));
else saved = await runModels();
if (typeof out === 'string') writeFileSync(out, JSON.stringify(saved, null, 1));
const summaries = Object.entries(saved.runs).map(([m, runs]) => summarize(m, runs));
printTable(summaries);
if (typeof out === 'string') writeFileSync(out.replace(/\.json$/, '.summary.json'), JSON.stringify(summaries, null, 1));

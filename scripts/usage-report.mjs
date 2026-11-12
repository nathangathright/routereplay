#!/usr/bin/env node
/**
 * Usage visibility for the free-tier budget (docs/budgets.md).
 * Reports the last 24 hours of Worker requests (this Worker and account-wide, since the 100k/day
 * limit is shared by every Worker and Pages Function in the account), Durable Object requests, and D1 usage,
 * and exits with status 1 when any figure passes the alert threshold (default 70%).
 *
 * Auth: CLOUDFLARE_API_TOKEN (Account Analytics Read, D1 Read), or the current
 * `wrangler login` session. Usage: node scripts/usage-report.mjs [--threshold 0.7]
 */
import { execFileSync } from 'node:child_process';

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? '9de782296eecae639581790a3e12ef2e';
const WORKER = 'routereplay-web';
const DATABASE = 'routereplay';
const LIMITS = { workerRequests: 100_000, doRequests: 100_000, d1RowsRead: 5_000_000, d1RowsWritten: 100_000, d1Bytes: 5 * 1024 ** 3 };
const ti = process.argv.indexOf('--threshold');
const THRESHOLD = ti > 0 ? Number(process.argv[ti + 1]) : 0.7;

function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const out = execFileSync('npx', ['wrangler', 'auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const m = out.match(/[A-Za-z0-9._-]{30,}/g);
  if (!m) throw new Error('No Cloudflare token: set CLOUDFLARE_API_TOKEN or run wrangler login');
  return m[m.length - 1];
}

const auth = { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' };

async function api(path) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: auth });
  const j = await r.json();
  if (!j.success) throw new Error(`${path}: ${JSON.stringify(j.errors)}`);
  return j.result;
}

async function graphql(query, variables) {
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: auth, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data.viewer.accounts[0];
}

const end = new Date();
const start = new Date(end.getTime() - 86_400_000);
const vars = { a: ACCOUNT, s: start.toISOString(), e: end.toISOString() };

const db = (await api(`/accounts/${ACCOUNT}/d1/database?name=${DATABASE}`)).find((d) => d.name === DATABASE);

const usage = await graphql(
  `query($a: string!, $s: Time!, $e: Time!) { viewer { accounts(filter: {accountTag: $a}) {
    pages: pagesFunctionsInvocationsAdaptiveGroups(limit: 100, filter: {datetime_geq: $s, datetime_leq: $e}) { sum { requests errors } dimensions { scriptName } }
    workers: workersInvocationsAdaptive(limit: 100, filter: {datetime_geq: $s, datetime_leq: $e}) { sum { requests errors } dimensions { scriptName } }
    durable: durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: {datetime_geq: $s, datetime_leq: $e}) { sum { requests } dimensions { scriptName } }
    d1: d1AnalyticsAdaptiveGroups(limit: 10, filter: {datetime_geq: $s, datetime_leq: $e, databaseId: "${db.uuid}"}) { sum { readQueries writeQueries rowsRead rowsWritten } }
  } } }`,
  vars,
);

const sum = (rows, f = () => true) => rows.filter(f).reduce((s, r) => ({ requests: s.requests + r.sum.requests, errors: s.errors + r.sum.errors }), { requests: 0, errors: 0 });
const ours = sum(usage.workers, (r) => r.dimensions.scriptName === WORKER);
const durable = usage.durable.filter((r) => r.dimensions.scriptName === WORKER).reduce((s, r) => s + r.sum.requests, 0);
const accountWide = { requests: sum(usage.pages).requests + sum(usage.workers).requests };
const d1 = usage.d1.reduce((s, r) => ({ rowsRead: s.rowsRead + r.sum.rowsRead, rowsWritten: s.rowsWritten + r.sum.rowsWritten, readQueries: s.readQueries + r.sum.readQueries, writeQueries: s.writeQueries + r.sum.writeQueries }), { rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 });
const size = Number(db.file_size ?? 0);

const rows = [
  ['Route Replay Worker requests', ours.requests, LIMITS.workerRequests],
  ['Account-wide Worker + Pages Function requests', accountWide.requests, LIMITS.workerRequests],
  ['Route Replay Durable Object requests', durable, LIMITS.doRequests],
  ['D1 rows read', d1.rowsRead, LIMITS.d1RowsRead],
  ['D1 rows written', d1.rowsWritten, LIMITS.d1RowsWritten],
  ['D1 storage (bytes)', size, LIMITS.d1Bytes],
];
console.log(`Usage ${start.toISOString()} → ${end.toISOString()} (alert at ${Math.round(THRESHOLD * 100)}% of free limits)`);
let alert = false;
for (const [name, value, limit] of rows) {
  const pct = value / limit;
  if (pct >= THRESHOLD) alert = true;
  console.log(`${pct >= THRESHOLD ? 'ALERT' : 'ok   '} ${name}: ${value.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} (${(pct * 100).toFixed(2)}%)`);
}
console.log(`Worker errors: ${ours.errors}. D1 queries: ${d1.readQueries} read, ${d1.writeQueries} write. Analytics can lag by a few minutes.`);
process.exit(alert ? 1 : 0);

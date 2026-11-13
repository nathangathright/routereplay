import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Env, handle } from '../src/server/index';
import { MODEL } from '../src/server/compose/models';

const ORIGIN = 'http://routereplay.test';
let mf: Miniflare;
let db: D1Database;
let env: Env;
/** What the fake model was asked, and what it answers next. */
let seen: { model: string; input: { messages: { role: string; content: string }[] } }[];
let answers: unknown[];

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'routereplay-compose-test',
      modules: true,
      script: 'export default { fetch() { return new Response("unused") } }',
      compatibilityDate: '2026-11-01',
      d1Databases: { DB: 'routereplay-compose-test' },
    }),
  );
  db = (await mf.getD1Database('DB', 'routereplay-compose-test')) as unknown as D1Database;
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
  await db.batch(sql.split(/;\s*\n/).map((s) => s.trim().replace(/;$/, '')).filter(Boolean).map((s) => db.prepare(s)));
  seen = [];
  answers = [];
  env = {
    DB: db,
    AI: {
      async run(model: string, input: unknown) {
        seen.push({ model, input: input as (typeof seen)[number]['input'] });
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return { choices: [{ message: { content: JSON.stringify(next) } }], usage: { prompt_tokens: 480, completion_tokens: 160 } };
      },
    },
  };
});

const flight = (l: Record<string, unknown>) => ({
  mode: 'flight', from: '', fromCode: null, to: '', toCode: null, departDate: null, departTime: null,
  arriveDate: null, arriveTime: null, flight: null, aircraft: null, ...l,
});
const QF93 = flight({ from: 'MEL', fromCode: 'MEL', to: 'SFO', toCode: 'SFO', departDate: '2027-03-05', departTime: '10:15', arriveTime: '06:05', flight: 'QF93', aircraft: '787-9' });
const QF93_TEXT = 'QF93 MEL-SFO 5 Mar 2027 dep 10:15 arr 06:05, 787-9.';

async function call(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } };
  if (body === undefined) init.headers = headers;
  const res = await handle(new Request(ORIGIN + path, init), env);
  return { res, status: res.status, json: (await res.json()) as any };
}
const compose = (messages: { role: string; content: string }[], extra: Record<string, unknown> = {}) =>
  call('/api/v1/compose', { messages, ...extra });

describe('compose', () => {
  it('reports the allowance without using a message', async () => {
    const r = await call('/api/v1/compose');
    expect(r.status).toBe(200);
    expect(r.json.limits).toMatchObject({ remaining: 20, perHour: 20 });
    expect((await call('/api/v1/compose')).json.limits.remaining).toBe(20);
  });

  it('turns a complete itinerary into a ready spec with a summary, using one message', async () => {
    answers.push({ legs: [QF93] });
    const r = await compose([{ role: 'user', content: QF93_TEXT }], { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('ready');
    expect(r.json.spec.legs[0]).toMatchObject({ from: 'MEL', to: 'SFO', departure: '2027-03-05T10:15:00+11:00', arrival: '2027-03-05T06:05:00-08:00', aircraft: 'B789' });
    expect(r.json.legs).toEqual([{ route: 'Melbourne (MEL) → San Francisco (SFO)', when: 'Fri 5 Mar 2027, 10:15 → 06:05', by: 'Boeing 787-9' }]);
    expect(r.json.limits).toMatchObject({ remaining: 19, perHour: 20 });
    expect(r.json.intent).toBeUndefined();
    // One message goes to the model as written; a client can't pick the model.
    expect(seen[0]!.model).toBe(MODEL);
    expect(seen[0]!.input.messages[1]!.content).toBe(QF93_TEXT);
  });

  it('asks for what is missing, then resolves the answer against the question', async () => {
    answers.push({ legs: [flight({ from: 'London', to: 'New York', toCode: 'JFK', departDate: '2027-05-03', departTime: '11:00', arriveTime: '13:55', aircraft: 'Boeing 777-300ER' })] });
    const first = await compose([{ role: 'user', content: 'London to New York on 3 May 2027, 11:00 to 13:55, Boeing 777-300ER.' }]);
    expect(first.json.status).toBe('needs_info');
    const questions = first.json.questions.map((q: { question: string }) => q.question);
    expect(questions.join(' ')).toMatch(/Which airport in London/);

    answers.push({ legs: [flight({ from: 'Heathrow', fromCode: 'LHR', to: 'JFK', toCode: 'JFK', departDate: '2027-05-03', departTime: '11:00', arriveTime: '13:55', aircraft: 'Boeing 777-300ER' })] });
    const second = await compose([
      { role: 'user', content: 'London to New York on 3 May 2027, 11:00 to 13:55, Boeing 777-300ER.' },
      { role: 'assistant', content: questions.join('\n') },
      { role: 'user', content: 'Heathrow to JFK' },
    ]);
    expect(second.json.status).toBe('ready');
    expect(second.json.spec.legs[0]).toMatchObject({ from: 'LHR', to: 'JFK', aircraft: 'B77W' });
    expect(second.json.limits.remaining).toBe(18);
    // The conversation reaches the model as a transcript.
    expect(seen[1]!.input.messages[1]!.content).toMatch(/^Traveller: London to New York[\s\S]*\n\nRoute Replay: Which airport in London[\s\S]*\n\nTraveller: Heathrow to JFK$/);
  });

  it("checks guards against the traveller's words only", async () => {
    // The question mentioned LHR; the traveller never did, so the model's LHR for "London" is still a question.
    answers.push({ legs: [flight({ from: 'London', fromCode: 'LHR', to: 'JFK', toCode: 'JFK', departDate: '2027-05-03', departTime: '11:00', arriveTime: '13:55', aircraft: '777-300ER' })] });
    const r = await compose([
      { role: 'user', content: 'London to JFK on 3 May 2027, 11:00 to 13:55, 777-300ER' },
      { role: 'assistant', content: 'Which airport in London? Options: LHR (London Heathrow Airport), LGW (London Gatwick Airport)' },
      { role: 'user', content: 'not sure' },
    ]);
    expect(r.json.status).toBe('needs_info');
    expect(r.json.questions[0]).toMatchObject({ path: '/legs/0/from' });
  });

  it("stops at the client's hourly limit with a clear state, and keeps saying so", async () => {
    env.COMPOSE_LIMIT_PER_HOUR = '2';
    answers.push({ legs: [QF93] }, { legs: [QF93] });
    expect((await compose([{ role: 'user', content: QF93_TEXT }])).json.limits.remaining).toBe(1);
    expect((await compose([{ role: 'user', content: QF93_TEXT }])).json.limits.remaining).toBe(0);
    const over = await compose([{ role: 'user', content: QF93_TEXT }]);
    expect(over.status).toBe(429);
    expect(over.json.error).toMatchObject({ code: 'rate_limited', limits: { remaining: 0, perHour: 2, reached: 'client' } });
    expect(Number(over.res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(seen).toHaveLength(2);
    expect((await call('/api/v1/compose')).json.limits).toMatchObject({ remaining: 0, reached: 'client' });
  });

  it("stops everyone at the day's cap", async () => {
    env.COMPOSE_LIMIT_PER_DAY = '1';
    answers.push({ legs: [QF93] });
    expect((await compose([{ role: 'user', content: QF93_TEXT }])).json.limits.remaining).toBe(0);
    const over = await compose([{ role: 'user', content: QF93_TEXT }], {});
    expect(over.json.error.limits).toMatchObject({ remaining: 0, reached: 'everyone' });
  });

  it("reports the allowance on errors, and a request that never reached the model doesn't use a message", async () => {
    const long = await compose([{ role: 'user', content: 'x'.repeat(4001) }]);
    expect(long.status).toBe(413);
    expect(long.json.error.limits.remaining).toBe(20);
    const bad = await compose([{ role: 'assistant', content: 'Hello' }]);
    expect(bad.status).toBe(400);
    expect(bad.json.error.limits.remaining).toBe(20);

    answers.push(new Error('upstream timeout'));
    const down = await compose([{ role: 'user', content: QF93_TEXT }]);
    expect(down.status).toBe(502);
    expect(down.json.error).toMatchObject({ code: 'model_unavailable', limits: { remaining: 19 } });
    expect(JSON.stringify(down.json)).not.toContain('QF93');
  });

  it('lets the page create the draft and publish it through an owner session', async () => {
    answers.push({ legs: [QF93] });
    const composed = await compose([{ role: 'user', content: QF93_TEXT }]);
    // What the homepage does: create with the existing endpoint, then open /s/{id}#k=<owner credential>, whose
    // handshake exchanges the credential for a session cookie with the owner's role.
    const web = { 'x-routereplay-client': 'web' };
    const created = await call('/api/v1/scenes', composed.json.spec, { ...web, 'idempotency-key': crypto.randomUUID() });
    expect(created.status).toBe(201);
    const { id } = created.json;
    const session = await handle(
      new Request(`${ORIGIN}/api/v1/scenes/${id}/session`, { method: 'POST', headers: { ...web, authorization: `Bearer ${created.json.credentials.owner}` } }),
      env,
    );
    expect(session.status).toBe(201);
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    expect((await session.json() as any).capabilities).toMatchObject({ role: 'owner', publish: true });
    const published = await call(`/api/v1/scenes/${id}/publications`, { revision: 1 }, { ...web, cookie, origin: ORIGIN, 'idempotency-key': crypto.randomUUID() });
    expect(published.status).toBe(201);
    expect(published.json.watchUrl).toMatch(/\/w\/[a-z0-9]{12}$/);
  });
});

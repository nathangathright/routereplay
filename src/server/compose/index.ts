/**
 * /api/v1/compose: a conversation about a trip in, a scene spec (or the questions that block one) out. Saves nothing.
 * The text goes to the extraction model and is then discarded; only rate-limit counters are written.
 *
 *   GET  → { limits }                       how many messages this client has left, without using one
 *   POST { messages: [{ role, content }] }  → { status: 'ready' | 'needs_info', questions, legs, spec, assumed, limits, … }
 *
 * `questions` has one entry per leg that still needs something (plus any about the whole trip), each saying whether
 * an AI with web search could look it up, so the page can offer to hand the research to the person's own AI.
 *
 * The client keeps the conversation and sends all of it each time; the last message is the person's. Every response,
 * errors included, carries `limits` (as `error.limits` on errors), so the page can show how many messages are left.
 */
import { AIRPORT_DATA_VERSION, lookupAirport, searchAirports } from '../airports';
import { type LimitChecks, type LimitCount, countLimits, peekLimits, retryAfterSeconds } from '../guards';
import { ApiError, json, readJsonBody } from '../http';
import { type ChatMessage, modelInput, travellerText } from './intent';
import { type ModelEnv, extract } from './models';
import { resolveIntent } from './resolve';
import { summarize } from '../../shared/scene/summary';

export interface ComposeEnv extends ModelEnv {
  DB: D1Database;
  COMPOSE_LIMIT_PER_HOUR?: string;
  COMPOSE_LIMIT_PER_DAY?: string;
}

export const MAX_CHARACTERS = 4000;
const MAX_MESSAGES = 30;

/**
 * 20 messages per client an hour, and 800 a day for everyone: at about 9 neurons a message (up to ~20 for a long
 * confirmation email), 800 keeps a typical day inside Workers AI's 10,000 free neurons.
 */
function checks(env: ComposeEnv, client: string): LimitChecks {
  const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  return [
    [{ name: 'compose', windowMs: 3_600_000, limit: n(env.COMPOSE_LIMIT_PER_HOUR, 20) }, client],
    [{ name: 'global_compose', windowMs: 86_400_000, limit: n(env.COMPOSE_LIMIT_PER_DAY, 800) }, 'all'],
  ];
}

export interface Limits {
  /** Messages this client can still send now: the smaller of its own allowance and what's left for everyone today. */
  remaining: number;
  /** Messages per client per hour. */
  perHour: number;
  /** When `remaining` next goes up. */
  resetsAt: string;
  /** Set once a limit stops messages: this client's hourly limit, or today's limit for everyone. */
  reached?: 'client' | 'everyone';
}

function limitsOf([client, everyone]: LimitCount[]): Limits {
  const left = (c: LimitCount) => Math.max(0, c.rule.limit - c.count);
  const binding = left(everyone!) < left(client!) ? everyone! : client!;
  const reached = client!.count > client!.rule.limit ? 'client' : everyone!.count > everyone!.rule.limit ? 'everyone' : undefined;
  const resetFrom = reached === 'everyone' ? everyone! : reached === 'client' ? client! : binding;
  return {
    remaining: Math.min(left(client!), left(everyone!)),
    perHour: client!.rule.limit,
    resetsAt: new Date(resetFrom.resetsAt).toISOString(),
    ...(reached ? { reached } : {}),
  };
}

/** Errors carry the limits too. */
const withLimits = (e: ApiError, limits: Limits) => new ApiError(e.status, e.code, e.message, { ...e.extra, limits }, e.headers);

export async function composeLimitsOp(env: ComposeEnv, client: string, now: number): Promise<Response> {
  return json({ limits: limitsOf(await peekLimits(env.DB, checks(env, client), now)), maxCharacters: MAX_CHARACTERS });
}

function readMessages(body: unknown): ChatMessage[] {
  const messages = (body as { messages?: unknown } | null)?.messages;
  const bad = (message: string, hint?: string) => new ApiError(400, 'invalid_request', message, hint ? { hint } : {});
  if (!Array.isArray(messages) || messages.length === 0) {
    throw bad('Send {"messages": [{"role": "user", "content": "<your trip>"}]}.');
  }
  if (messages.length > MAX_MESSAGES) throw bad(`At most ${MAX_MESSAGES} messages.`, 'Start a new conversation.');
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const { role, content } = (m ?? {}) as { role?: unknown; content?: unknown };
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      throw bad('Each message needs a role ("user" or "assistant") and content (a string).');
    }
    out.push({ role, content });
  }
  const last = out[out.length - 1]!;
  if (last.role !== 'user' || !last.content.trim()) throw bad('The last message must be the traveller’s, and not empty.');
  const total = out.reduce((n, m) => n + m.content.length, 0);
  if (total > MAX_CHARACTERS) {
    throw new ApiError(413, 'text_too_long', `The conversation is ${total} characters; the limit is ${MAX_CHARACTERS}.`, {
      hint: 'Start a new conversation with just the flights, trains, buses, drives and ferries.',
    });
  }
  return out;
}

export async function composeOp(request: Request, env: ComposeEnv, client: string, now: number): Promise<Response> {
  const limitChecks = checks(env, client);
  let messages: ChatMessage[];
  let debug = false;
  try {
    const body = await readJsonBody(request);
    messages = readMessages(body);
    debug = (body as { debug?: unknown }).debug === true;
  } catch (e) {
    // A request that never reached the model doesn't use a message.
    if (e instanceof ApiError) throw withLimits(e, limitsOf(await peekLimits(env.DB, limitChecks, now)));
    throw e;
  }

  const counts = await countLimits(env.DB, limitChecks, now);
  const limits = limitsOf(counts);
  if (limits.reached) {
    const over = counts.find((c) => c.count > c.rule.limit)!;
    const retryAfter = retryAfterSeconds(over, now);
    throw new ApiError(
      429,
      'rate_limited',
      limits.reached === 'client'
        ? `You've used the ${limits.perHour} messages an hour this page allows.`
        : 'Route Replay has used up today’s messages for everyone.',
      { retryAfterSeconds: retryAfter, limits, hint: 'Your own AI agent can make the journey instead: copy the agent prompt into it.' },
      { 'retry-after': String(retryAfter) },
    );
  }

  let extraction;
  try {
    extraction = await extract(env, modelInput(messages));
  } catch (e) {
    // Never echo the itinerary; the provider's message is enough to diagnose.
    const detail = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
    throw new ApiError(502, 'model_unavailable', 'The itinerary reader is unavailable. Try again shortly.', { hint: detail, limits });
  }
  const { intent, usage } = extraction;
  if (!intent) throw new ApiError(502, 'extraction_failed', 'I couldn’t read that. Try again, or put it another way.', { limits });

  const result = resolveIntent(intent, travellerText(messages), { lookupAirport, searchAirports, airportDataVersion: AIRPORT_DATA_VERSION, now });
  return json({
    status: result.complete ? 'ready' : 'needs_info',
    questions: result.questions,
    ...(result.complete ? { legs: summarize(result.spec.legs as Parameters<typeof summarize>[0], result.places, result.airports, result.assumed) } : {}),
    spec: result.spec,
    assumed: result.assumed,
    airports: result.airports,
    issues: result.issues,
    warnings: result.warnings,
    limits,
    // The model's reading and its cost, for debugging and evaluation.
    ...(debug ? { intent, usage } : {}),
  });
}

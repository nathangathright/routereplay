/**
 * POST /api/v1/compose: plain-language itinerary in, scene spec (or the questions that block one) out. Saves nothing.
 * The text goes to the extraction model and is then discarded; only rate-limit counters are written.
 */
import { AIRPORT_DATA_VERSION, lookupAirport, searchAirports } from '../airports';
import { type LimitRule, enforceLimits } from '../guards';
import { ApiError, json, readJsonBody } from '../http';
import { type ModelEnv, MODELS, extract } from './models';
import { resolveIntent } from './resolve';

export interface ComposeEnv extends ModelEnv {
  DB: D1Database;
  /** Models a request may name, comma-separated; the first is the default. */
  COMPOSE_MODELS?: string;
  COMPOSE_LIMIT_PER_HOUR?: string;
  COMPOSE_LIMIT_PER_DAY?: string;
}

const DEFAULT_MODEL = 'gemma-4-26b';
const MAX_TEXT = 4000;

export async function composeOp(request: Request, env: ComposeEnv, clientSubject: string, now: number): Promise<Response> {
  const body = await readJsonBody(request);
  if (typeof body !== 'object' || body === null || typeof (body as { text?: unknown }).text !== 'string') {
    throw new ApiError(400, 'invalid_request', 'Send {"text": "<your itinerary>"}.');
  }
  const { text, model: requested, debug } = body as { text: string; model?: unknown; debug?: unknown };
  if (!text.trim()) throw new ApiError(400, 'invalid_request', 'The itinerary text is empty.');
  if (text.length > MAX_TEXT) {
    throw new ApiError(413, 'text_too_long', `The itinerary is ${text.length} characters; the limit is ${MAX_TEXT}.`, {
      hint: 'Paste only the flights, trains, buses, drives and ferries.',
    });
  }
  const allowed = (env.COMPOSE_MODELS ?? DEFAULT_MODEL).split(',').map((s) => s.trim()).filter((s) => s in MODELS);
  const model = requested ?? allowed[0];
  if (typeof model !== 'string' || !allowed.includes(model)) {
    throw new ApiError(400, 'unsupported_model', `Model ${JSON.stringify(model)} is not available.`, { hint: `Available: ${allowed.join(', ')}.` });
  }

  // 800 a day keeps the default model inside Workers AI's 10,000 free neurons (about 9 per request, up to ~20 for a
  // long confirmation email).
  const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  const perClient: LimitRule = { name: 'compose', windowMs: 3_600_000, limit: n(env.COMPOSE_LIMIT_PER_HOUR, 20) };
  const global: LimitRule = { name: 'global_compose', windowMs: 86_400_000, limit: n(env.COMPOSE_LIMIT_PER_DAY, 800) };
  await enforceLimits(env.DB, [[perClient, clientSubject], [global, 'all']], now);

  let extraction;
  try {
    extraction = await extract(env, model, text);
  } catch (e) {
    // Never echo the itinerary; the provider's message is enough to diagnose.
    const detail = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
    throw new ApiError(502, 'model_unavailable', 'The extraction model is unavailable. Try again shortly.', { hint: detail });
  }
  const { intent, usage } = extraction;
  if (!intent) throw new ApiError(502, 'extraction_failed', 'The model returned no usable itinerary. Try again, or rephrase.');
  const result = resolveIntent(intent, text, { lookupAirport, searchAirports, airportDataVersion: AIRPORT_DATA_VERSION, now });

  return json({
    ...result,
    usage,
    // The model's reading, for debugging and evaluation.
    ...(debug === true ? { intent } : {}),
    note: result.complete
      ? 'Nothing was saved. POST spec to /api/v1/scenes to create the journey.'
      : 'Nothing was saved. Answer the questions, add the answers to the text, and send it again.',
  });
}

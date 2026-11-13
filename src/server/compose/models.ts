/**
 * The extraction model: itinerary text in, an Intent out, as schema-constrained JSON through the Workers AI binding.
 * Chosen by comparison (docs/decisions.md, "A journey from plain text"); clients can't pick another.
 *
 * Price in neurons (https://developers.cloudflare.com/workers-ai/platform/pricing/, November 2026): 10,000 a day free
 * on every plan, then $0.011 per 1,000 on Workers Paid.
 */
import { INTENT_SCHEMA, type Intent, SYSTEM_PROMPT, parseIntent } from './intent';

export const MODEL = '@cf/google/gemma-4-26b-a4b-it';
const NEURONS_PER_M_IN = 9091;
const NEURONS_PER_M_OUT = 27273;

export interface ModelEnv {
  AI?: { run(model: string, input: unknown): Promise<unknown> };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  neurons: number;
}

export interface Extraction {
  intent: Intent | null;
  usage: Usage;
}

export async function extract(env: ModelEnv, text: string): Promise<Extraction> {
  if (!env.AI) throw new Error('The AI binding is not configured.');
  const out = (await env.AI.run(MODEL, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'itinerary', schema: INTENT_SCHEMA, strict: true } },
    max_tokens: 2048,
    temperature: 0,
    // Reasoning off: it added tokens and latency without changing the extraction.
    chat_template_kwargs: { enable_thinking: false },
  })) as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const inputTokens = out.usage?.prompt_tokens ?? 0;
  const outputTokens = out.usage?.completion_tokens ?? 0;
  const neurons = (inputTokens * NEURONS_PER_M_IN + outputTokens * NEURONS_PER_M_OUT) / 1e6;
  return {
    intent: parseIntent(out.choices?.[0]?.message?.content ?? null),
    usage: { inputTokens, outputTokens, neurons: Math.round(neurons * 100) / 100 },
  };
}

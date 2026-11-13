/**
 * Workers AI models for extraction: itinerary text in, an Intent out, as schema-constrained JSON through the AI
 * binding. Prices are in neurons (https://developers.cloudflare.com/workers-ai/platform/pricing/, November 2026:
 * 10,000 a day free on every plan, then $0.011 per 1,000 on Workers Paid).
 *
 * Claude models were compared from Node instead (scripts/compose-eval/claude.mjs): the Anthropic SDK would add
 * 880 KiB to the Worker bundle, about 6.5 ms of parsing in every fresh isolate, for every endpoint.
 */
import { INTENT_SCHEMA, type Intent, SYSTEM_PROMPT, parseIntent } from './intent';

interface ModelConfig {
  id: string;
  /** "openai": json_schema wraps {name, schema}; "cloudflare": json_schema is the schema itself. */
  responseFormat: 'openai' | 'cloudflare';
  /** Turn reasoning off through the chat template. */
  noThinking?: boolean;
  neuronsPerMIn: number;
  neuronsPerMOut: number;
}

export const MODELS: Record<string, ModelConfig> = {
  'gemma-4-26b': { id: '@cf/google/gemma-4-26b-a4b-it', responseFormat: 'openai', noThinking: true, neuronsPerMIn: 9091, neuronsPerMOut: 27273 },
  'granite-4.0-h-micro': { id: '@cf/ibm-granite/granite-4.0-h-micro', responseFormat: 'cloudflare', neuronsPerMIn: 1542, neuronsPerMOut: 10158 },
  'glm-4.7-flash': { id: '@cf/zai-org/glm-4.7-flash', responseFormat: 'openai', noThinking: true, neuronsPerMIn: 5500, neuronsPerMOut: 36400 },
  'gpt-oss-20b': { id: '@cf/openai/gpt-oss-20b', responseFormat: 'cloudflare', neuronsPerMIn: 18182, neuronsPerMOut: 27273 },
  'llama-4-scout': { id: '@cf/meta/llama-4-scout-17b-16e-instruct', responseFormat: 'cloudflare', neuronsPerMIn: 24545, neuronsPerMOut: 77273 },
  'llama-3.3-70b': { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', responseFormat: 'cloudflare', neuronsPerMIn: 26668, neuronsPerMOut: 204805 },
  'gpt-oss-120b': { id: '@cf/openai/gpt-oss-120b', responseFormat: 'cloudflare', neuronsPerMIn: 31818, neuronsPerMOut: 68182 },
};

const USD_PER_NEURON = 0.011 / 1000;

export interface ModelEnv {
  AI?: { run(model: string, input: unknown): Promise<unknown> };
}

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  neurons: number;
  /** Beyond the free allowance. */
  usd: number;
}

export interface Extraction {
  intent: Intent | null;
  usage: Usage;
}

export async function extract(env: ModelEnv, name: string, userText: string): Promise<Extraction> {
  const m = MODELS[name]!;
  if (!env.AI) throw new Error('The AI binding is not configured.');
  const out = (await env.AI.run(m.id, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userText },
    ],
    response_format:
      m.responseFormat === 'openai'
        ? { type: 'json_schema', json_schema: { name: 'itinerary', schema: INTENT_SCHEMA, strict: true } }
        : { type: 'json_schema', json_schema: INTENT_SCHEMA },
    max_tokens: 2048,
    temperature: 0,
    ...(m.noThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  })) as WorkersAiOutput;
  const inputTokens = out.usage?.prompt_tokens ?? 0;
  const outputTokens = out.usage?.completion_tokens ?? 0;
  const neurons = (inputTokens * m.neuronsPerMIn + outputTokens * m.neuronsPerMOut) / 1e6;
  return {
    intent: parseIntent(outputOf(out)),
    usage: { model: name, inputTokens, outputTokens, neurons: round(neurons, 2), usd: round(neurons * USD_PER_NEURON, 7) },
  };
}

interface WorkersAiOutput {
  response?: unknown;
  choices?: { message?: { content?: unknown } }[];
  output?: { type?: string; content?: { type?: string; text?: string }[] }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Workers AI models answer in three shapes: {response}, OpenAI chat completions, and OpenAI responses. */
function outputOf(out: WorkersAiOutput): unknown {
  if (out.choices?.[0]?.message) return out.choices[0].message.content;
  if (out.response !== undefined) return out.response;
  for (const item of out.output ?? []) {
    if (item.type !== 'message') continue;
    for (const c of item.content ?? []) if (c.type === 'output_text') return c.text;
  }
  return null;
}

const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;

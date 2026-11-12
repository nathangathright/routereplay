import { LIMITS } from '../shared/scene/constants';
import type { ValidationIssue } from '../shared/scene/types';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    hint?: string;
    issues?: ValidationIssue[];
    retryAfterSeconds?: number;
    docs?: string;
    [extra: string]: unknown;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Partial<ApiErrorBody['error']> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2) + '\n', {
    status,
    headers: { ...BASE_HEADERS, 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(err: ApiError, origin: string): Response {
  const body: ApiErrorBody = {
    error: {
      code: err.code,
      message: err.message,
      ...err.extra,
      docs: `${origin}/agent-docs#errors`,
    },
  };
  return json(body, err.status, err.headers);
}

/** Read a JSON body with a hard size limit and content-type check. */
export async function readJsonBody(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) {
    throw new ApiError(415, 'unsupported_media_type', 'Send the request body as JSON.', {
      hint: 'Set the header Content-Type: application/json.',
    });
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > LIMITS.maxPayloadBytes) throw tooLarge();
  const buf = await request.arrayBuffer();
  if (buf.byteLength > LIMITS.maxPayloadBytes) throw tooLarge();
  const text = new TextDecoder().decode(buf);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON.', {
      hint: e instanceof Error ? e.message : undefined,
    });
  }
}

function tooLarge() {
  return new ApiError(413, 'payload_too_large', `The request body exceeds ${LIMITS.maxPayloadBytes} bytes.`, {
    hint: 'Scene specs are compact: no meshes, frames, media, or research notes.',
  });
}

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

export function bearerToken(request: Request): string | null {
  const h = request.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1]! : null;
}

export function clientAddress(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
}

/**
 * If-None-Match uses weak comparison (RFC 9110 §13.1.2). Cloudflare weakens ETags when it
 * compresses a response, so clients send back W/"…" for the strong tag we issued.
 */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const opaque = (t: string) => t.trim().replace(/^W\//, '');
  const target = opaque(etag);
  return ifNoneMatch.split(',').some((t) => t.trim() === '*' || opaque(t) === target);
}

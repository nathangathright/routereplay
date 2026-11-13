/** Rate limiting and idempotency backed by D1. */
import { decryptWithSecret, encryptWithSecret, sha256Hex } from './crypto';
import { ApiError } from './http';

export interface LimitRule {
  name: string;
  windowMs: number;
  limit: number;
}

/**
 * Fixed-window counter. Each call costs one D1 write, so it is applied only to
 * operations that write anyway (create, replace, publish, session exchange).
 */
export async function enforceLimit(db: D1Database, rule: LimitRule, subject: string, now: number): Promise<void> {
  const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs;
  const bucket = `${rule.name}:${subject}`;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(bucket, windowStart)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  if (count > rule.limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + rule.windowMs - now) / 1000));
    throw new ApiError(
      429,
      'rate_limited',
      `Too many ${rule.name.replace(/_/g, ' ')} requests. Limit: ${rule.limit} per ${Math.round(rule.windowMs / 60_000)} minutes.`,
      { retryAfterSeconds, hint: `Wait ${retryAfterSeconds} seconds before retrying. Do not retry in a tight loop.` },
      { 'retry-after': String(retryAfterSeconds) },
    );
  }
}

/** Like enforceLimit, but reports whether the call fits instead of failing the request. */
export async function withinLimit(db: D1Database, rule: LimitRule, subject: string, now: number): Promise<boolean> {
  try {
    await enforceLimit(db, rule, subject, now);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) return false;
    throw e;
  }
}

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
const KEY_RE = /^[A-Za-z0-9_.:-]{16,128}$/;

export type IdempotencyStart =
  | { kind: 'none' }
  | { kind: 'new'; scope: string; keyHash: string; key: string }
  | { kind: 'replay'; status: number; body: string };

export function readIdempotencyKey(request: Request): string | null {
  const key = request.headers.get('idempotency-key');
  if (key === null) return null;
  if (!KEY_RE.test(key)) {
    throw new ApiError(400, 'invalid_idempotency_key', 'Idempotency-Key must be 16–128 characters of letters, digits, or _.:-', {
      hint: 'Use a freshly generated UUID for each logical operation and reuse it only when retrying that operation.',
    });
  }
  return key;
}

/**
 * Reserve an idempotency key. A retry with the same key and identical body replays the
 * stored response; a different body is rejected; a concurrent duplicate gets 409.
 */
export async function beginIdempotent(
  db: D1Database,
  scope: string,
  key: string | null,
  body: string,
  now: number,
  encrypted: boolean,
): Promise<IdempotencyStart> {
  if (key === null) return { kind: 'none' };
  const keyHash = await sha256Hex(`${scope}\n${key}`);
  const requestHash = await sha256Hex(body);
  for (let attempt = 0; attempt < 2; attempt++) {
    const inserted = await db
      .prepare(
        `INSERT INTO idempotency (scope, key_hash, request_hash, status, response, created_at, expires_at)
         VALUES (?, ?, ?, 0, NULL, ?, ?) ON CONFLICT(scope, key_hash) DO NOTHING`,
      )
      .bind(scope, keyHash, requestHash, now, now + IDEMPOTENCY_TTL_MS)
      .run();
    if (inserted.meta.changes === 1) return { kind: 'new', scope, keyHash, key };
    const existing = await db
      .prepare('SELECT request_hash, status, response, expires_at FROM idempotency WHERE scope = ? AND key_hash = ?')
      .bind(scope, keyHash)
      .first<{ request_hash: string; status: number; response: string | null; expires_at: number }>();
    if (!existing) continue;
    if (existing.expires_at < now) {
      await db.prepare('DELETE FROM idempotency WHERE scope = ? AND key_hash = ?').bind(scope, keyHash).run();
      continue;
    }
    if (existing.request_hash !== requestHash) {
      throw new ApiError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request body.', {
        hint: 'Generate a new key for a new operation. Reuse a key only to retry the identical request.',
      });
    }
    if (existing.status === 0 || existing.response === null) {
      throw new ApiError(409, 'request_in_progress', 'The original request with this Idempotency-Key is still in progress.', {
        retryAfterSeconds: 2,
        hint: 'Retry the same request in a few seconds.',
      }, { 'retry-after': '2' });
    }
    const text = encrypted ? await decryptWithSecret(`${scope}\n${key}`, existing.response) : existing.response;
    return { kind: 'replay', status: existing.status, body: text };
  }
  throw new ApiError(503, 'idempotency_unavailable', 'Could not reserve the idempotency key. Retry shortly.');
}

export async function completeIdempotent(
  db: D1Database,
  start: IdempotencyStart,
  status: number,
  body: string,
  encrypted: boolean,
): Promise<void> {
  if (start.kind !== 'new') return;
  const stored = encrypted ? await encryptWithSecret(`${start.scope}\n${start.key}`, body) : body;
  await db
    .prepare('UPDATE idempotency SET status = ?, response = ? WHERE scope = ? AND key_hash = ?')
    .bind(status, stored, start.scope, start.keyHash)
    .run();
}

export async function abandonIdempotent(db: D1Database, start: IdempotencyStart): Promise<void> {
  if (start.kind !== 'new') return;
  await db.prepare('DELETE FROM idempotency WHERE scope = ? AND key_hash = ?').bind(start.scope, start.keyHash).run();
}

/** Rate limiting and idempotency backed by D1. */
import { decryptWithSecret, encryptWithSecret, sha256Hex } from './crypto';
import { ApiError } from './http';

export interface LimitRule {
  name: string;
  windowMs: number;
  limit: number;
}

const COUNT_SQL = `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
  ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
  RETURNING count`;

const PEEK_SQL = 'SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?';

export type LimitChecks = [rule: LimitRule, subject: string][];

/** A rule's count in its current window, including the request just counted (if it was). */
export interface LimitCount {
  rule: LimitRule;
  count: number;
  /** When the window ends, in ms since the epoch. */
  resetsAt: number;
}

const windowStart = (rule: LimitRule, now: number) => Math.floor(now / rule.windowMs) * rule.windowMs;

/**
 * Count one request against each rule, in one D1 round trip, and return the counts. Each costs one D1 write,
 * so counters are applied only to operations that write anyway (create, replace, publish, session exchange)
 * or that cost money (compose).
 */
export async function countLimits(db: D1Database, checks: LimitChecks, now: number): Promise<LimitCount[]> {
  const windows = checks.map(([rule]) => windowStart(rule, now));
  const results = await db.batch<{ count: number }>(
    checks.map(([rule, subject], i) => db.prepare(COUNT_SQL).bind(`${rule.name}:${subject}`, windows[i])),
  );
  return checks.map(([rule], i) => ({ rule, count: results[i]?.results[0]?.count ?? 1, resetsAt: windows[i]! + rule.windowMs }));
}

/** The counts so far, without counting a request (D1 reads only). */
export async function peekLimits(db: D1Database, checks: LimitChecks, now: number): Promise<LimitCount[]> {
  const windows = checks.map(([rule]) => windowStart(rule, now));
  const results = await db.batch<{ count: number }>(
    checks.map(([rule, subject], i) => db.prepare(PEEK_SQL).bind(`${rule.name}:${subject}`, windows[i])),
  );
  return checks.map(([rule], i) => ({ rule, count: results[i]?.results[0]?.count ?? 0, resetsAt: windows[i]! + rule.windowMs }));
}

/** Seconds until the window resets, at least 1. */
export const retryAfterSeconds = (c: LimitCount, now: number) => Math.max(1, Math.ceil((c.resetsAt - now) / 1000));

/** Fixed-window counters: count the request, and fail it with 429 once any rule is over its limit. */
export async function enforceLimits(db: D1Database, checks: LimitChecks, now: number): Promise<void> {
  for (const c of await countLimits(db, checks, now)) {
    if (c.count <= c.rule.limit) continue;
    const retryAfter = retryAfterSeconds(c, now);
    throw new ApiError(
      429,
      'rate_limited',
      `Too many ${c.rule.name.replace(/_/g, ' ')} requests. Limit: ${c.rule.limit} per ${Math.round(c.rule.windowMs / 60_000)} minutes.`,
      { retryAfterSeconds: retryAfter, hint: `Wait ${retryAfter} seconds before retrying. Do not retry in a tight loop.` },
      { 'retry-after': String(retryAfter) },
    );
  }
}

export function enforceLimit(db: D1Database, rule: LimitRule, subject: string, now: number): Promise<void> {
  return enforceLimits(db, [[rule, subject]], now);
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

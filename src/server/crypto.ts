/** Token generation, hashing, and small encryption helpers (Web Crypto only). */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomId(length: number): string {
  // Rejection sampling avoids modulo bias.
  const out: string[] = [];
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < 252 && out.length < length) out.push(ALPHABET[b % 36]!);
    }
  }
  return out.join('');
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export type TokenKind = 'edit' | 'owner' | 'session';
const PREFIX: Record<TokenKind, string> = { edit: 'rr_edit_', owner: 'rr_owner_', session: 'rr_sess_' };

/** 256-bit random bearer token with a recognizable prefix (useful for secret scanning). */
export function newToken(kind: TokenKind): string {
  return PREFIX[kind] + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export const TOKEN_RE = /^rr_(edit|owner|sess)_[A-Za-z0-9_-]{43}$/;

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('routereplay:idem:enc:' + secret)));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypt text with a key derived from a client-held secret. Output: base64url(iv).base64url(ciphertext). */
export async function encryptWithSecret(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), new TextEncoder().encode(plaintext)),
  );
  return `${base64url(iv)}.${base64url(ct)}`;
}

export async function decryptWithSecret(secret: string, payload: string): Promise<string> {
  const [ivPart, ctPart] = payload.split('.');
  if (!ivPart || !ctPart) throw new Error('Malformed ciphertext');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64url(ivPart) },
    await aesKey(secret),
    fromBase64url(ctPart),
  );
  return new TextDecoder().decode(pt);
}

/** Remove bearer tokens from any text that might be logged. */
export function redact(text: string): string {
  return text.replace(/rr_(edit|owner|sess)_[A-Za-z0-9_-]+/g, 'rr_$1_[redacted]');
}

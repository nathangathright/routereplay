import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../src/server/security';

describe('security headers', () => {
  it('static _headers and Function HTML use the same CSP', () => {
    const file = readFileSync(new URL('../public/_headers', import.meta.url).pathname, 'utf8');
    const line = file.split('\n').find((l) => l.trim().startsWith('Content-Security-Policy:'))!;
    expect(line.split('Content-Security-Policy:')[1]!.trim()).toBe(CONTENT_SECURITY_POLICY);
  });
});

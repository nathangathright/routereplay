import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('static redirects', () => {
  it('sends /shortcut to an iCloud shortcut link, temporarily, so a new version takes over on deploy', () => {
    const file = readFileSync(new URL('../public/_redirects', import.meta.url).pathname, 'utf8');
    const rules = file
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(/\s+/));
    const rule = rules.find(([from]) => from === '/shortcut');
    expect(rule).toBeDefined();
    expect(rule![1]).toMatch(/^https:\/\/www\.icloud\.com\/shortcuts\/[0-9a-f]{32}$/);
    expect(rule![2]).toBe('302');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FAQ_CREDITS, PRIVACY_QUESTION, answerParts, faq } from '../src/app/faq';

const sections = faq('routereplay.video');
const items = sections.flatMap((s) => s.items);
const paragraphs = [...items.flatMap((q) => q.answer), FAQ_CREDITS];

describe('the chat’s questions and answers', () => {
  it('answers the privacy question the chat’s first message opens', () => {
    const privacy = items.find((q) => q.id === PRIVACY_QUESTION);
    expect(privacy?.answer.join(' ')).toContain('Neither Cloudflare nor Route Replay keeps the text or uses it to train models');
  });

  it('quotes how long sessions and drafts last from the numbers the server enforces', () => {
    const text = paragraphs.join('\n');
    expect(text).toContain('stays open in your browser for 7 days');
    expect(text).toContain('for 180 days is deleted');
  });

  it('gives every question its own id', () => {
    expect(new Set(items.map((q) => q.id)).size).toBe(items.length);
    expect(items.length).toBe(13);
  });

  it('links only to pages the Worker serves', () => {
    const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url).pathname, 'utf8');
    const hrefs = paragraphs.flatMap((p) => answerParts(p).flatMap((part) => (typeof part === 'string' ? [] : [part.href])));
    expect(hrefs).toEqual(expect.arrayContaining(['/agent-docs', '/acknowledgments']));
    for (const href of hrefs) expect(wrangler).toContain(`"${href}"`);
    // Nothing left unrendered: a link that didn't parse would show its brackets.
    for (const p of paragraphs) for (const part of answerParts(p)) if (typeof part === 'string') expect(part).not.toMatch(/\]\(|\{\{/);
  });

  it('splits a paragraph into text and links', () => {
    expect(answerParts('Point it at [example.com/agent-docs](/agent-docs).')).toEqual([
      'Point it at ',
      { text: 'example.com/agent-docs', href: '/agent-docs' },
      '.',
    ]);
    expect(answerParts('No links here.')).toEqual(['No links here.']);
  });
});

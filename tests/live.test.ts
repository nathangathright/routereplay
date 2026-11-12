import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_TTL_MS,
  activityEvent,
  cleanActivityMessage,
  currentActivity,
  latestViewer,
  parseViewerMessage,
} from '../src/server/liveState';

describe('live channel rules', () => {
  it('accepts only well-formed viewer reports', () => {
    expect(parseViewerMessage('{"type":"viewer","t":7.234,"paused":true,"revision":3}', 1000)).toEqual({
      t: 7.23,
      paused: true,
      revision: 3,
      receivedAt: 1000,
    });
    expect(parseViewerMessage('{"type":"viewer","t":2,"paused":false}', 5)!.revision).toBeNull();
    for (const bad of [
      'not json',
      '{"type":"seek","t":1,"paused":true}',
      '{"type":"viewer","t":-1,"paused":true}',
      '{"type":"viewer","t":"7","paused":true}',
      '{"type":"viewer","t":1}',
      '{"type":"viewer","t":1e9,"paused":true}',
      `{"type":"viewer","t":1,"paused":true,"x":"${'a'.repeat(300)}"}`,
    ]) {
      expect(parseViewerMessage(bad, 0), bad).toBeNull();
    }
    expect(parseViewerMessage(new ArrayBuffer(4), 0)).toBeNull();
  });

  it('uses the most recent report among open previews', () => {
    const a = { t: 1, paused: true, revision: 1, receivedAt: 10 };
    const b = { t: 2, paused: false, revision: 1, receivedAt: 20 };
    expect(latestViewer([a, null, b, undefined])).toBe(b);
    expect(latestViewer([null])).toBeNull();
  });

  it('lets activity lapse after three minutes', () => {
    const a = { message: 'Checking flights', expiresAt: 1000 + ACTIVITY_TTL_MS, updatedAt: 1000 };
    expect(currentActivity(a, 1000 + ACTIVITY_TTL_MS - 1)).toBe(a);
    expect(currentActivity(a, 1000 + ACTIVITY_TTL_MS)).toBeNull();
    expect(currentActivity(undefined, 0)).toBeNull();
    expect(JSON.parse(activityEvent(a, 1000))).toEqual({ type: 'activity', state: 'working', message: 'Checking flights', expiresInMs: ACTIVITY_TTL_MS });
    expect(JSON.parse(activityEvent(null, 0))).toEqual({ type: 'activity', state: 'idle' });
  });

  it('keeps activity messages to one short line of plain text', () => {
    expect(cleanActivityMessage('  Checking\nyour  connection in SFO ')).toBe('Checking your connection in SFO');
    expect(cleanActivityMessage(undefined)).toBe('');
    expect(cleanActivityMessage('x'.repeat(81))).toBeNull();
    expect(cleanActivityMessage(42)).toBeNull();
    // Markup is not interpreted anywhere; it stays text.
    expect(cleanActivityMessage('<b>hi</b>')).toBe('<b>hi</b>');
  });
});

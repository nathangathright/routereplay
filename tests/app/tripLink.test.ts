import { describe, expect, it } from 'vitest';
import { tripFromHash } from '../../src/app/tripLink';

describe('tripFromHash', () => {
  it('decodes a percent-encoded trip, keeping lines', () => {
    const trip = 'QF93 MEL → LAX, 14 Mar 2027 10:30\nthen AA 2 to JFK & on';
    expect(tripFromHash(`#trip=${encodeURIComponent(trip)}`)).toBe(trip);
  });

  it('keeps a plus sign as a plus', () => {
    expect(tripFromHash('#trip=Seats%201A+1B')).toBe('Seats 1A+1B');
  });

  it('normalizes line endings and trims', () => {
    expect(tripFromHash('#trip=%0D%0A%20BA%20117%0D%0ALHR%20to%20JFK%20%0A')).toBe('BA 117\nLHR to JFK');
  });

  it('keeps text with a stray percent sign as it came', () => {
    expect(tripFromHash('#trip=100% sure: BA 117')).toBe('100% sure: BA 117');
  });

  it('ignores other fragments and empty trips', () => {
    expect(tripFromHash('')).toBeNull();
    expect(tripFromHash('#k=rr_edit_abc')).toBeNull();
    expect(tripFromHash('#trip=')).toBeNull();
    expect(tripFromHash('#trip=%20%0A')).toBeNull();
  });
});

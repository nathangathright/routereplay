import type { SceneSpecV1 } from './types';

/**
 * Synthetic example used in documentation, tests, and the landing page.
 * Not a real booking or schedule.
 */
export const EXAMPLE_SCENE: SceneSpecV1 = {
  schemaVersion: 1,
  title: 'Chicago to Auckland (synthetic example)',
  legs: [
    {
      id: 'ord-sfo',
      from: 'ORD',
      to: 'SFO',
      departure: '2031-01-05T10:00:00-06:00',
      arrival: '2031-01-05T12:45:00-08:00',
      aircraft: 'B739',
    },
    {
      id: 'sfo-akl',
      from: 'SFO',
      to: 'AKL',
      departure: '2031-01-05T21:30:00-08:00',
      arrival: '2031-01-07T07:15:00+13:00',
      aircraft: 'B789',
    },
  ],
  presentation: {
    durationSeconds: 20,
    stopHolds: { 'ord-sfo': 2 },
  },
};

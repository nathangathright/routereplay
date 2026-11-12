/**
 * Pure rules for the live channel (plan 2, A1 and A2), shared by the SceneLive Durable Object
 * and the tests. Viewer state lives only on open sockets; activity lapses on its own.
 */
export const ACTIVITY_TTL_MS = 3 * 60_000;
export const ACTIVITY_MESSAGE_MAX = 80;

/** What an open preview last reported: kept as the socket's attachment, never stored. */
export interface ViewerReport {
  t: number;
  paused: boolean;
  revision: number | null;
  receivedAt: number;
}

export interface Activity {
  message: string;
  expiresAt: number;
  updatedAt: number;
}

/** What the API learns from the draft's object. */
export interface LiveState {
  previews: number;
  viewer: ViewerReport | null;
  activity: Activity | null;
}

/** Accept only well-formed viewer reports from the page; anything else is ignored. */
export function parseViewerMessage(raw: string | ArrayBuffer, now: number): ViewerReport | null {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  const v = m as { type?: unknown; t?: unknown; paused?: unknown; revision?: unknown };
  if (v?.type !== 'viewer' || typeof v.t !== 'number' || !Number.isFinite(v.t) || v.t < 0 || v.t > 3600) return null;
  if (typeof v.paused !== 'boolean') return null;
  const revision = typeof v.revision === 'number' && Number.isInteger(v.revision) && v.revision > 0 ? v.revision : null;
  return { t: Math.round(v.t * 100) / 100, paused: v.paused, revision, receivedAt: now };
}

/** The most recent report among open previews. */
export function latestViewer(reports: unknown[]): ViewerReport | null {
  let best: ViewerReport | null = null;
  for (const r of reports) {
    const v = r as ViewerReport | null;
    if (v && typeof v.receivedAt === 'number' && (!best || v.receivedAt > best.receivedAt)) best = v;
  }
  return best;
}

export function currentActivity(stored: Activity | undefined | null, now: number): Activity | null {
  return stored && stored.expiresAt > now ? stored : null;
}

/** The event an open preview receives when activity changes (or when it connects mid-activity). */
export function activityEvent(activity: Activity | null, now: number): string {
  return JSON.stringify(
    activity
      ? { type: 'activity', state: 'working', message: activity.message, expiresInMs: Math.max(0, activity.expiresAt - now) }
      : { type: 'activity', state: 'idle' },
  );
}

// Control characters and line/paragraph separators (written as escapes so the source stays ASCII).
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]+', 'g');

/** Plain single-line text, at most ACTIVITY_MESSAGE_MAX characters. */
export function cleanActivityMessage(raw: unknown): string | null {
  if (raw === undefined) return '';
  if (typeof raw !== 'string') return null;
  const text = raw.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= ACTIVITY_MESSAGE_MAX ? text : null;
}

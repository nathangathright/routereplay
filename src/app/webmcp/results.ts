/** What the pages' tools return: results, failures the agent can act on, and the journey in an agent's terms. */
import { ApiFailure } from '../api';
import type { NormalizedSceneV1 } from '../../shared/scene/types';

export type ToolResult = { ok: true; [k: string]: unknown } | { ok: false; status?: number; error: { code: string; message: string; [k: string]: unknown } };

/** A tool's failure, returned rather than thrown so the agent reads what went wrong and what to do. */
export function failed(code: string, message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { ok: false, error: { code, message, ...extra } };
}

/** An API failure as a tool result: its status and everything the API said to do, except the bulky normalized record. */
export function apiFailed(e: unknown): ToolResult {
  if (e instanceof ApiFailure) {
    const { status, code, message, normalized: _normalized, ...rest } = e.info;
    return { ok: false, status, error: { code, message, ...rest } };
  }
  return failed('client_error', e instanceof Error ? e.message : String(e));
}

/** The chat is reading a message or saving its change: wait, so neither undoes the other. */
export function chatChanging(person: 'creator' | 'person'): ToolResult {
  return failed('creator_editing', `The ${person} is changing the trip in the page’s chat right now.`, {
    retryable: true,
    hint: 'Wait a few seconds, read the trip again, and apply your change to it as it is then.',
  });
}

/**
 * The journey as an agent reads it: each leg with its airports, local and UTC times, aircraft or ground mode,
 * distance, pacing weight and screen time, and the airports' names and time zones. Route geometry is left out.
 */
export function journeyFacts(scene: NormalizedSceneV1) {
  const p = scene.presentation;
  return {
    title: scene.title,
    durationSeconds: p.durationSeconds,
    startHoldSeconds: p.startHoldSeconds,
    endHoldSeconds: p.endHoldSeconds,
    weather: scene.environment.weather,
    legs: scene.legs.map((l) => ({
      id: l.id,
      from: l.from,
      to: l.to,
      ...(l.mode ? { mode: l.mode, followsRoute: l.path !== undefined } : { aircraft: l.aircraft }),
      departureLocal: l.departureLocal,
      arrivalLocal: l.arrivalLocal,
      departureUtc: l.departureUtc,
      arrivalUtc: l.arrivalUtc,
      distanceKm: l.distanceKm,
      weight: l.weight,
      flightSeconds: l.flightSeconds,
      holdAfterSeconds: l.holdAfterSeconds,
    })),
    airports: Object.fromEntries(
      Object.values(scene.airports).map((a) => [a.code, { name: a.name, city: a.city, country: a.country, timeZone: a.timeZone }]),
    ),
  };
}

/**
 * Advisory warnings (plan 2, A3): likely mistakes that pass validation. They never block
 * saving. Agents should raise material ones with the creator.
 */
import { CLOUD_ARCHIVE_START_MS, CLOUD_STEP_HOURS, cloudFieldAt } from '../weather/gfs';
import { WARNING_THRESHOLDS as W } from './constants';
import type { NormalizedSceneV1 } from './types';

export type WarningCode =
  | 'implausible_speed'
  | 'long_block_time'
  | 'short_screen_time'
  | 'compressed_connection'
  | 'far_future_or_past'
  | 'no_cloud_data';

export interface SceneWarning {
  /** JSON Pointer into the spec where a fix would go. */
  path: string;
  code: WarningCode;
  message: string;
  hint: string;
}

const YEAR_MS = 365.25 * 86_400_000;

function duration(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

const km = (n: number) => Math.round(n).toLocaleString('en-US');

function stay(hours: number): string {
  return hours < 48 ? `${Math.round(hours)}-hour` : `${Math.round(hours / 24)}-day`;
}

export function sceneWarnings(scene: NormalizedSceneV1, nowMs: number): SceneWarning[] {
  const out: SceneWarning[] = [];
  const legs = scene.legs;

  legs.forEach((leg, i) => {
    const route = `${leg.from} → ${leg.to}`;
    const blockMinutes = (Date.parse(leg.arrivalUtc) - Date.parse(leg.departureUtc)) / 60_000;
    const kmh = leg.distanceKm / (blockMinutes / 60);
    const tooFast = kmh > W.maxAverageKmh;
    const tooSlow = kmh < W.minAverageKmh && blockMinutes > W.slowCheckMinBlockMinutes;
    if (tooFast || tooSlow) {
      out.push({
        path: `/legs/${i}`,
        code: 'implausible_speed',
        message: `${route} covers ${km(leg.distanceKm)} km in ${duration(blockMinutes)}, an average of ${km(kmh)} km/h.`,
        hint: tooFast
          ? 'Airliners average roughly 500–950 km/h gate to gate. Check both dates and times, and both airports.'
          : 'That is slower than any scheduled jet. Check that the arrival date is not a day late, and that both airports are right.',
      });
    } else if (blockMinutes > W.longBlockMinutes) {
      out.push({
        path: `/legs/${i}/arrival`,
        code: 'long_block_time',
        message: `${route} takes ${duration(blockMinutes)}, longer than the longest scheduled nonstop flights (about 19 hours).`,
        hint: 'Check whether the arrival is on the wrong day, or whether a stop on the way should be its own leg.',
      });
    }

    if (leg.flightSeconds < W.minScreenSeconds) {
      out.push({
        path: `/legs/${i}`,
        code: 'short_screen_time',
        message: `${route} is on screen for ${leg.flightSeconds.toFixed(1)} s, too fast to follow.`,
        hint: `Add seconds to presentation.durationSeconds and raise presentation.legWeights["${leg.id}"] to match. normalized.legs[].flightSeconds shows the result.`,
      });
    }

    // A stop that races through more than a day per second strobes day and night (routereplay's rule).
    const next = legs[i + 1];
    if (next && leg.holdAfterSeconds > 0) {
      const hours = (Date.parse(next.departureUtc) - Date.parse(leg.arrivalUtc)) / 3_600_000;
      const rate = hours / leg.holdAfterSeconds;
      if (rate > W.maxLayoverHoursPerSecond) {
        const needed = Math.ceil((hours / W.maxLayoverHoursPerSecond) * 10) / 10;
        out.push({
          path: `/presentation/stopHolds/${leg.id}`,
          code: 'compressed_connection',
          message: `The ${stay(hours)} stay in ${leg.to} passes in ${leg.holdAfterSeconds.toFixed(1)} s, about ${Math.round(rate)} hours a second, so day and night flash past.`,
          hint: `Set presentation.stopHolds["${leg.id}"] to at least ${needed} s, or to 0 to cut straight to the next departure.`,
        });
      }
    }
  });

  const first = legs[0]!;
  const start = Date.parse(first.departureUtc);
  const date = first.departureLocal.slice(0, 10);
  if (start > nowMs + W.maxYearsFromToday * YEAR_MS || start < nowMs - W.maxYearsFromToday * YEAR_MS) {
    const future = start > nowMs;
    out.push({
      path: '/legs/0/departure',
      code: 'far_future_or_past',
      message: `The journey starts on ${date}, more than ${W.maxYearsFromToday} years ${future ? 'from now' : 'ago'}.`,
      hint: 'Ask the creator to confirm the year; it may be a typo. Once they confirm it, ignore this warning.',
    });
  }

  // Weather-model clouds exist from March 2021 to 16 days after the pinned run; the span between is unbroken.
  // A journey years away already has a warning; missing clouds there go without saying.
  const run = scene.environment.cloudRun;
  if (scene.environment.weather === 'clouds' && run && !out.some((w) => w.code === 'far_future_or_past')) {
    const step = CLOUD_STEP_HOURS * 3_600_000;
    const end = Date.parse(legs[legs.length - 1]!.arrivalUtc);
    const firstCovered = cloudFieldAt(Math.floor(start / step) * step, run) !== null;
    const lastCovered = cloudFieldAt(Math.ceil(end / step) * step, run) !== null;
    if (!firstCovered || !lastCovered) {
      const none = !firstCovered && !lastCovered && (end < CLOUD_ARCHIVE_START_MS || start > nowMs);
      out.push({
        path: '/environment/weather',
        code: 'no_cloud_data',
        message: none
          ? 'No weather-model data covers this journey, so no clouds are drawn.'
          : 'Weather-model clouds cover only part of this journey; the rest is drawn without clouds.',
        hint: 'Clouds come from NOAA\'s GFS model, which covers 22 March 2021 to 16 days after the save. For an upcoming trip, save again closer to departure. Otherwise nothing needs fixing.',
      });
    }
  }
  return out;
}

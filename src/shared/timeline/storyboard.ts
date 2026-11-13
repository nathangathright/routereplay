/**
 * Storyboards (plan 2, A5): what the animation shows at chosen moments, from the same
 * evaluate() the renderer draws. There is no GPU on the server, so agents check their work
 * against these keyframes (and the SVG sketch built from them) instead of screenshots.
 */
import { vecToLatLon, dot } from '../geo/vec';
import { formatLocalTimestamp, formatUtc, zoneOffsetMinutes } from '../scene/time';
import type { NormalizedSceneV1 } from '../scene/types';
import { DEFAULT_ASPECT, type Phase, type Timeline, buildTimeline, evaluate, visibleLabelOpacity } from './evaluate';
import { framing } from './view';

export const STORYBOARD_FRAMES = { default: 8, min: 2, max: 24 } as const;

export interface Keyframe {
  /** Presentation time in seconds. */
  t: number;
  phase: Phase;
  legId: string;
  /** Fraction of the current leg flown (0 before departure, 1 after arrival). */
  legProgress: number;
  /** Plain-language description, e.g. "Flying ORD → SFO, 43% of the way" or "By train AKL → WLG, 43% of the way". */
  summary: string;
  /** The physical moment shown. */
  utc: string;
  /** Local time at the airports involved: both ends during a flight, otherwise the current airport. */
  local: Record<string, string>;
  aircraft: { lat: number; lon: number; sunElevationDeg: number; daylight: boolean };
  /** Airport labels clearly visible at this moment. */
  labels: string[];
  camera: { centerLat: number; centerLon: number; viewRadiusKm: number };
}

export interface Storyboard {
  durationSeconds: number;
  /** The shape the keyframes are framed for. Scenes no longer have one; viewers pick it when they export. */
  aspectRatio: string;
  /** How long each part of the journey is on screen. */
  onScreenSeconds: {
    startHold: number;
    /** `mode` is present on train, bus, car, and ferry legs. */
    legs: { id: string; from: string; to: string; mode?: string; startsAt: number; seconds: number }[];
    stops: { airport: string; afterLegId: string; startsAt: number; seconds: number; connectionMinutes: number }[];
    endHold: number;
  };
  keyframes: Keyframe[];
}

const round = (x: number, d: number) => {
  const f = 10 ** d;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
};

function localTime(scene: NormalizedSceneV1, code: string, utcMs: number): string {
  const zone = scene.airports[code]!.timeZone;
  return formatLocalTimestamp(Math.round(utcMs / 60_000) * 60_000, zoneOffsetMinutes(zone, utcMs)).replace(/:00([+-])/, '$1');
}

export function keyframeAt(tl: Timeline, tIn: number): Keyframe {
  const scene = tl.scene;
  const s = evaluate(tl, tIn);
  const leg = scene.legs[s.legIndex]!;
  const route = `${leg.from} → ${leg.to}`;
  const progress = round(s.legProgress, 3);
  const summary =
    s.phase === 'start'
      ? `At ${leg.from} before departure`
      : s.phase === 'flight'
        ? `Flying ${route}, ${Math.round(s.legProgress * 100)}% of the way`
        : s.phase === 'surface'
          ? `By ${leg.mode} ${route}, ${Math.round(s.legProgress * 100)}% of the way`
          : s.phase === 'stop'
          ? `Connecting at ${leg.to}`
          : `Arrived at ${leg.to}`;
  const moving = s.phase === 'flight' || s.phase === 'surface';
  const codes = moving ? [leg.from, leg.to] : [s.phase === 'start' ? leg.from : leg.to];
  const local: Record<string, string> = {};
  for (const c of codes) local[c] = localTime(scene, c, s.physicalUtcMs);
  const ground = vecToLatLon(s.aircraft.ground);
  const elevation = (Math.asin(Math.max(-1, Math.min(1, dot(s.aircraft.ground, s.sun)))) * 180) / Math.PI;
  const view = framing(s.camera, DEFAULT_ASPECT);
  const center = vecToLatLon(view.center);
  return {
    t: round(s.t, 2),
    phase: s.phase,
    legId: leg.id,
    legProgress: progress,
    summary,
    utc: formatUtc(Math.round(s.physicalUtcMs / 60_000) * 60_000),
    local,
    aircraft: { lat: round(ground.lat, 2), lon: round(ground.lon, 2), sunElevationDeg: round(elevation, 1), daylight: elevation > 0 },
    labels: s.labels
      .filter((l) => visibleLabelOpacity(l, s.camera.position) >= 0.5)
      .sort((a, b) => a.index - b.index)
      .map((l) => l.code),
    camera: { centerLat: round(center.lat, 2), centerLon: round(center.lon, 2), viewRadiusKm: Math.round(view.viewRadiusKm / 10) * 10 },
  };
}

/** Evenly spaced moments from the first frame to the last, inclusive. */
export function evenTimes(duration: number, frames: number): number[] {
  return Array.from({ length: frames }, (_, i) => (duration * i) / (frames - 1));
}

export function buildStoryboard(scene: NormalizedSceneV1, times?: number[], frames: number = STORYBOARD_FRAMES.default): Storyboard {
  const tl = buildTimeline(scene);
  const legs: Storyboard['onScreenSeconds']['legs'] = [];
  const stops: Storyboard['onScreenSeconds']['stops'] = [];
  let startHold = 0;
  let endHold = 0;
  for (const seg of tl.segments) {
    const seconds = round(seg.t1 - seg.t0, 2);
    const leg = scene.legs[seg.leg]!;
    if (seg.kind === 'start') startHold = seconds;
    else if (seg.kind === 'end') endHold = seconds;
    else if (seg.kind === 'flight' || seg.kind === 'surface')
      legs.push({ id: leg.id, from: leg.from, to: leg.to, ...(leg.mode ? { mode: leg.mode } : {}), startsAt: round(seg.t0, 2), seconds });
    else {
      const next = scene.legs[seg.leg + 1]!;
      stops.push({
        airport: leg.to,
        afterLegId: leg.id,
        startsAt: round(seg.t0, 2),
        seconds,
        connectionMinutes: Math.round((Date.parse(next.departureUtc) - Date.parse(leg.arrivalUtc)) / 60_000),
      });
    }
  }
  // Legs with a zero hold still have a connection worth reporting.
  scene.legs.slice(0, -1).forEach((leg, i) => {
    if (stops.some((s) => s.afterLegId === leg.id)) return;
    const next = scene.legs[i + 1]!;
    stops.push({
      airport: leg.to,
      afterLegId: leg.id,
      startsAt: round(tl.legs[i]!.flightEnd, 2),
      seconds: 0,
      connectionMinutes: Math.round((Date.parse(next.departureUtc) - Date.parse(leg.arrivalUtc)) / 60_000),
    });
  });
  stops.sort((a, b) => a.startsAt - b.startsAt);
  const at = times ?? evenTimes(tl.duration, frames);
  return {
    durationSeconds: round(tl.duration, 2),
    aspectRatio: '16:9',
    onScreenSeconds: { startHold, legs, stops, endHold },
    keyframes: at.map((t) => keyframeAt(tl, t)),
  };
}

/**
 * Deterministic scene evaluation: scene = evaluate(timeline, presentationTime).
 *
 * Everything here is a pure function of the normalized record and the requested
 * presentation time. No previous frame, wall clock, playback speed, or unseeded
 * randomness is consulted, so seeking in any order reproduces the same state.
 */
import { GreatCircle } from '../geo/greatCircle';
import { sunDirection } from '../geo/solar';
import { PathTrack, type Track } from '../geo/track';
import {
  type Vec3,
  add,
  clamp,
  cross,
  dot,
  latLonToVec,
  length,
  normalize,
  scale,
  smoothstep,
  smootherstep,
  sub,
} from '../geo/vec';
import type { AircraftType } from '../scene/aircraft';
import { type AspectRatio, HOLD_MINUTES, SURFACE_MODES, type SurfaceMode } from '../scene/constants';
import { exposureProfile, meterGlobe } from './exposure';
import { type LabelState, type Pulse, labelsAt } from './labels';
import type { NormalizedSceneV1 } from '../scene/types';

/** `flight` and `surface` are a leg in motion: flown, or travelled by train, bus, car, or ferry. */
export type Phase = 'start' | 'flight' | 'surface' | 'stop' | 'end';

/**
 * What moves along a leg: the flight's aircraft type, or a surface leg's mode (each mode draws its own vehicle).
 * A connection dissolves from one craft to the next only when they differ.
 */
export type Craft = AircraftType | SurfaceMode;

export const isSurfaceMode = (craft: Craft): craft is SurfaceMode => (SURFACE_MODES as readonly string[]).includes(craft);

interface Segment {
  kind: Phase;
  t0: number;
  t1: number;
  /** Leg index: the leg in motion, the leg about to depart (start), or the leg just arrived (stop/end). */
  leg: number;
}

interface TimelineLeg {
  id: string;
  from: string;
  to: string;
  craft: Craft;
  /** Surface legs only: how the leg was travelled, which is also its craft. */
  mode: SurfaceMode | null;
  /** Between the two airports: sets how far the camera pulls back. */
  circle: GreatCircle;
  /** The line travelled: the great circle, or a surface leg's looked-up route. */
  track: Track;
  depMs: number;
  arrMs: number;
  /** Display altitude at mid-flight in Earth radii (artistic, not physical); 0 on surface legs. */
  cruise: number;
  /** This leg's length as a fraction of the trip's longest: how far the camera pulls back on it. */
  height: number;
  flightStart: number;
  flightEnd: number;
}

export interface LabelOccurrence {
  /** Index into the airport visit sequence: 0 is the origin, k is the arrival of leg k-1. */
  index: number;
  code: string;
  position: Vec3;
}

export interface Timeline {
  scene: NormalizedSceneV1;
  duration: number;
  fps: number;
  durationInFrames: number;
  segments: Segment[];
  legs: TimelineLeg[];
  occurrences: LabelOccurrence[];
}

export interface CameraState {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  fovDeg: number;
}

export type { LabelState, Pulse } from './labels';
export { smootherstep };

export interface SceneState {
  t: number;
  phase: Phase;
  legIndex: number;
  /** Position fraction along the current leg. */
  legProgress: number;
  physicalUtcMs: number;
  aircraft: {
    /** Unit vector of the ground position. */
    ground: Vec3;
    /** Display altitude above the surface, in Earth radii. */
    altitude: number;
    /** Unit tangent of travel direction. */
    heading: Vec3;
    /**
     * What is drawn, with weights that add up to 1: one craft, or two while a connection changes aircraft or
     * moves between the air and the ground (the offline renderer's dissolve through the middle half of the stop).
     */
    mix: { type: Craft; weight: number }[];
  };
  /** Revealed fraction of each leg's trail. */
  trail: number[];
  sun: Vec3;
  camera: CameraState;
  /** Airport labels in the offline renderer's layout, for this frame shape (see labels.ts). */
  labels: LabelState[];
  /** Rings growing from airports the aircraft has just reached. */
  pulses: Pulse[];
}

const NORTH: Vec3 = [0, 1, 0];
const DEG = Math.PI / 180;

/** Width ÷ height of each export shape. */
export const ASPECT_VALUE: Record<AspectRatio, number> = { '16:9': 16 / 9, '1:1': 1, '9:16': 9 / 16 };
/** Framing used where no viewport exists (storyboards, and evaluate without an aspect). */
export const DEFAULT_ASPECT = ASPECT_VALUE['16:9'];

/*
 * The offline renderer's cinematography (routereplay motion.py, camera_geometry.py, trip.py): one continuous
 * shot looking straight down at the aircraft, north up, that stays over the airport through holds and stops.
 * Zoom is the globe's apparent radius on a 1080-pixel short side seen through a 70° field: 1300 px at the
 * airports, easing out by 4p(1 − p) toward 440 px at mid-flight on the trip's longest leg, and proportionally
 * less on shorter legs. Flights, stops, and holds all ease with smootherstep.
 */
const SHORT_SIDE_PX = 1080;
const SHORT_SIDE_FOV = 70 * DEG;
/** Focal length in pixels of a 1080-pixel short side seen through 70°. */
export const FOCAL_PX = SHORT_SIDE_PX / (2 * Math.tan(SHORT_SIDE_FOV / 2));
const GROUND_RADIUS_PX = 1300;
const SUMMIT_RADIUS_PX = 440;
/** Illustrative cruise: 11 km at mid-flight following sin(πp), drawn 12× taller, as the offline renderer does. */
export const CRUISE_DISPLAY = (11_000 * 12) / 6_371_000;
/**
 * The aircraft is an icon of constant size: the offline renderer draws its 12.01-unit fuselage in a 224-pixel
 * crop 16.4 units wide, on a 1080-pixel short side.
 */
export const AIRCRAFT_SHORT_SIDE_FRACTION = ((12.01 / 16.4) * 224) / SHORT_SIDE_PX;
const HOLD_MS = HOLD_MINUTES * 60_000;

/** Flight progress (fraction of the route covered) for a fraction u of a flight's screen time. */
export const flightProgress = smootherstep;

/** Display altitude (Earth radii) along a leg: the trail and aircraft share it. */
export function displayAltitude(cruise: number, p: number): number {
  return cruise * Math.sin(Math.PI * clamp(p, 0, 1));
}

/**
 * Vertical field of view (degrees) for a viewport of the given width ÷ height: 70° across whichever side is
 * shorter, so the shot keeps the offline renderer's framing in any shape.
 */
export function verticalFovFor(aspect: number): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT;
  return a >= 1 ? SHORT_SIDE_FOV / DEG : (2 * Math.atan(Math.tan(SHORT_SIDE_FOV / 2) / a)) / DEG;
}

/** Camera distance from Earth's centre (Earth radii) at which the globe's silhouette has this apparent radius. */
function cameraDistance(radiusPx: number): number {
  return Math.sqrt(1 + (FOCAL_PX / radiusPx) ** 2);
}

/** Apparent globe radius at progress p along a leg whose length is `height` of the trip's longest. */
function apparentRadius(p: number, height: number): number {
  const lift = 4 * p * (1 - p) * height;
  return GROUND_RADIUS_PX / (1 + (GROUND_RADIUS_PX / SUMMIT_RADIUS_PX - 1) * lift);
}

export function buildTimeline(scene: NormalizedSceneV1): Timeline {
  const p = scene.presentation;
  const segments: Segment[] = [];
  const legs: TimelineLeg[] = [];
  let t = 0;
  const push = (kind: Phase, d: number, leg: number) => {
    if (d > 0) segments.push({ kind, t0: t, t1: t + d, leg });
    t += d;
  };
  push('start', p.startHoldSeconds, 0);
  const circles = scene.legs.map((leg) => {
    const a = scene.airports[leg.from]!;
    const b = scene.airports[leg.to]!;
    return GreatCircle.fromLatLon(a.lat, a.lon, b.lat, b.lon);
  });
  const longest = Math.max(...circles.map((c) => c.angle), 1e-9);
  scene.legs.forEach((leg, i) => {
    const circle = circles[i]!;
    const flightStart = t;
    const surface = leg.mode !== undefined;
    push(surface ? 'surface' : 'flight', leg.flightSeconds, i);
    legs.push({
      id: leg.id,
      from: leg.from,
      to: leg.to,
      craft: surface ? leg.mode! : leg.aircraft!,
      mode: leg.mode ?? null,
      circle,
      track: (surface && leg.path && PathTrack.fromPolyline(leg.path)) || circle,
      depMs: Date.parse(leg.departureUtc),
      arrMs: Date.parse(leg.arrivalUtc),
      cruise: surface ? 0 : CRUISE_DISPLAY,
      height: circle.angle / longest,
      flightStart,
      flightEnd: t,
    });
    if (i < scene.legs.length - 1) push('stop', leg.holdAfterSeconds, i);
  });
  push('end', p.endHoldSeconds, scene.legs.length - 1);
  const duration = t;

  const occurrences: LabelOccurrence[] = [];
  const first = scene.airports[scene.legs[0]!.from]!;
  occurrences.push({ index: 0, code: first.code, position: latLonToVec(first.lat, first.lon) });
  scene.legs.forEach((leg, i) => {
    const ap = scene.airports[leg.to]!;
    occurrences.push({ index: i + 1, code: ap.code, position: latLonToVec(ap.lat, ap.lon) });
  });

  return {
    scene,
    duration,
    fps: p.fps,
    durationInFrames: Math.max(1, Math.round(duration * p.fps)),
    segments,
    legs,
    occurrences,
  };
}

function segmentAt(tl: Timeline, t: number): Segment {
  const segs = tl.segments;
  if (segs.length === 0) return { kind: 'end', t0: 0, t1: 0, leg: tl.legs.length - 1 };
  for (const s of segs) if (t < s.t1) return s;
  return segs[segs.length - 1]!;
}

function rotateAround(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
}

/** Rotate heading a toward heading b about the radial axis by fraction f. */
function turnHeading(a: Vec3, b: Vec3, radial: Vec3, f: number): Vec3 {
  const angle = Math.atan2(dot(cross(a, b), radial), dot(a, b));
  return normalize(rotateAround(a, radial, angle * f));
}

interface Kinematics {
  seg: Segment;
  legIndex: number;
  legProgress: number;
  physicalUtcMs: number;
  ground: Vec3;
  altitude: number;
  heading: Vec3;
  /** Apparent globe radius (pixels on a 1080-pixel short side) the camera frames. */
  radiusPx: number;
}

function kinematics(tl: Timeline, tIn: number): Kinematics {
  const t = clamp(tIn, 0, tl.duration);
  const seg = segmentAt(tl, t);
  const u = seg.t1 > seg.t0 ? clamp((t - seg.t0) / (seg.t1 - seg.t0), 0, 1) : 1;
  const leg = tl.legs[seg.leg]!;
  const eased = smootherstep(u);
  switch (seg.kind) {
    case 'start':
      // Waiting at the gate while the last 20 minutes before departure pass.
      return {
        seg,
        legIndex: 0,
        legProgress: 0,
        physicalUtcMs: leg.depMs - HOLD_MS * (1 - eased),
        ground: leg.track.a,
        altitude: 0,
        heading: leg.track.tangent(0),
        radiusPx: GROUND_RADIUS_PX,
      };
    case 'flight':
    case 'surface': {
      const p = flightProgress(u);
      return {
        seg,
        legIndex: seg.leg,
        legProgress: p,
        physicalUtcMs: leg.depMs + p * (leg.arrMs - leg.depMs),
        ground: leg.track.at(p),
        altitude: displayAltitude(leg.cruise, p),
        heading: leg.track.tangent(p),
        radiusPx: apparentRadius(p, leg.height),
      };
    }
    case 'stop': {
      const next = tl.legs[seg.leg + 1]!;
      const ground = leg.track.b;
      return {
        seg,
        legIndex: seg.leg,
        legProgress: 1,
        physicalUtcMs: leg.arrMs + eased * (next.depMs - leg.arrMs),
        ground,
        altitude: 0,
        heading: turnHeading(leg.track.tangent(1), next.track.tangent(0), ground, eased),
        radiusPx: GROUND_RADIUS_PX,
      };
    }
    case 'end':
    default: {
      // At the gate while the first 20 minutes after arrival pass (no hold: the clock stops at arrival).
      const hold = seg.kind === 'end' ? HOLD_MS * eased : 0;
      return {
        seg,
        legIndex: seg.leg,
        legProgress: 1,
        physicalUtcMs: leg.arrMs + hold,
        ground: leg.track.b,
        altitude: 0,
        heading: leg.track.tangent(1),
        radiusPx: GROUND_RADIUS_PX,
      };
    }
  }
}

/** World north projected onto the view plane, falling back to the heading at the poles. */
function northUp(dir: Vec3, heading: Vec3): Vec3 {
  const proj = sub(NORTH, scale(dir, dot(NORTH, dir)));
  const w = smoothstep(0.03, 0.25, length(proj));
  const alt = sub(heading, scale(dir, dot(heading, dir)));
  return normalize(add(scale(normalize(proj, alt), w), scale(normalize(alt, proj), 1 - w)), [0, 0, 1]);
}

/** The camera's position at presentation time t (Earth frame, Earth radii), whatever the frame's shape. */
export function cameraPositionAt(tl: Timeline, t: number): Vec3 {
  const k = kinematics(tl, t);
  return scale(k.ground, cameraDistance(k.radiusPx));
}

/** Straight down at the aircraft (or the airport it waits at), north up. */
function evaluateCamera(k: Kinematics, aspect: number): CameraState {
  return {
    position: scale(k.ground, cameraDistance(k.radiusPx)),
    target: [0, 0, 0],
    up: northUp(k.ground, k.heading),
    fovDeg: verticalFovFor(aspect),
  };
}

function aircraftMix(tl: Timeline, k: Kinematics, t: number): SceneState['aircraft']['mix'] {
  const here = tl.legs[k.legIndex]!.craft;
  const seg = k.seg;
  if (seg.kind !== 'stop') return [{ type: here, weight: 1 }];
  const next = tl.legs[seg.leg + 1]!.craft;
  const w = smootherstep(((t - seg.t0) / (seg.t1 - seg.t0) - 0.25) / 0.5);
  if (next === here || w === 0) return [{ type: here, weight: 1 }];
  if (w === 1) return [{ type: next, weight: 1 }];
  return [
    { type: here, weight: 1 - w },
    { type: next, weight: w },
  ];
}

/** The scene at time t, framed for a viewport `aspect` (width ÷ height) wide. */
export function evaluate(tl: Timeline, tIn: number, aspect: number = DEFAULT_ASPECT): SceneState {
  const t = clamp(Number.isFinite(tIn) ? tIn : 0, 0, tl.duration);
  const k = kinematics(tl, t);
  const trail = tl.legs.map((_, i) => {
    if (i < k.legIndex) return 1;
    if (i > k.legIndex) return 0;
    return k.seg.kind === 'start' ? 0 : k.legProgress;
  });
  const camera = evaluateCamera(k, aspect);
  const shape = Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT;
  const { labels, pulses } = labelsAt(tl, t, shape, camera, (when) => evaluateCamera(kinematics(tl, when), shape), trail);
  return {
    t,
    phase: k.seg.kind,
    legIndex: k.legIndex,
    legProgress: k.legProgress,
    physicalUtcMs: k.physicalUtcMs,
    aircraft: { ground: k.ground, altitude: k.altitude, heading: k.heading, mix: aircraftMix(tl, k, t) },
    trail,
    sun: sunDirection(k.physicalUtcMs),
    camera,
    labels,
    pulses,
  };
}

export const frameToTime = (frame: number, fps: number): number => frame / fps;

const exposures = new WeakMap<Timeline, Float32Array>();

/**
 * Camera exposure at presentation time `t` (see exposure.ts). It is metered once per frame over the whole
 * journey, in order, so any frame reproduces the same value however playback seeks. The meter sees the
 * square around the frame's centre that every screen shape shares (70° across), so the shape doesn't matter.
 */
export function exposureAt(tl: Timeline, t: number): number {
  let profile = exposures.get(tl);
  if (!profile) {
    const meters = new Float64Array(tl.durationInFrames + 1);
    const tanHalf = Math.tan(SHORT_SIDE_FOV / 2);
    for (let i = 0; i < meters.length; i++) {
      const k = kinematics(tl, i / tl.fps);
      const camera = scale(k.ground, cameraDistance(k.radiusPx));
      meters[i] = meterGlobe(camera, scale(k.ground, -1), northUp(k.ground, k.heading), tanHalf, sunDirection(k.physicalUtcMs));
    }
    profile = exposureProfile(meters, 1 / tl.fps);
    exposures.set(tl, profile);
  }
  const x = clamp(t * tl.fps, 0, profile.length - 1);
  const i = Math.floor(x);
  const a = profile[i]!;
  const b = profile[Math.min(i + 1, profile.length - 1)]!;
  return a + (b - a) * (x - i);
}

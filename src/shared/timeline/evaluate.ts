/**
 * Deterministic scene evaluation: scene = evaluate(timeline, presentationTime).
 *
 * Everything here is a pure function of the normalized record and the requested
 * presentation time. No previous frame, wall clock, playback speed, or unseeded
 * randomness is consulted, so seeking in any order reproduces the same state.
 */
import { GreatCircle } from '../geo/greatCircle';
import { SmoothPath } from '../geo/smoothPath';
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
import { type LabelState, labelsAt } from './labels';
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
  /** A surface leg's route, smoothed for the camera to glide over; null on flights and on legs drawn straight. */
  glide: SmoothPath | null;
  depMs: number;
  arrMs: number;
  /** Display altitude at mid-flight in Earth radii (artistic, not physical); 0 on surface legs. */
  cruise: number;
  /**
   * This leg's length as a fraction of the trip's longest, surface legs included: how far the camera pulls back
   * on a flight. Surface legs don't pull back by it.
   */
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

export type { LabelState } from './labels';
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
 *
 * Train, bus, car, and ferry legs are filmed differently, like a drone following the vehicle: they don't take
 * off or land. The camera stays at the airports' zoom, rising only as far as it must to keep the ground from
 * crossing the frame faster than SURFACE_SCREEN_SPEED, so only a long leg played fast rises at all. It glides
 * over the route smoothed along its length (SmoothPath, with a window tied to the ground the frame spans), while
 * the vehicle keeps to the road, railway, or ferry line and drifts a little within the frame. The vehicle gets
 * up to speed and slows to a stop over the first and last SURFACE_RAMP of the leg, steady between.
 */
const SHORT_SIDE_PX = 1080;
const SHORT_SIDE_FOV = 70 * DEG;
/** Focal length in pixels of a 1080-pixel short side seen through 70°. */
export const FOCAL_PX = SHORT_SIDE_PX / (2 * Math.tan(SHORT_SIDE_FOV / 2));
const GROUND_RADIUS_PX = 1300;
const SUMMIT_RADIUS_PX = 440;
/** Fraction of a surface leg's screen time spent getting up to speed, and again slowing to a stop. */
export const SURFACE_RAMP = 0.2;
/** The ground crosses a surface leg's frame no faster than this, in pixels a second of a 1080-pixel short side. */
export const SURFACE_SCREEN_SPEED = 0.1 * SHORT_SIDE_PX;
/**
 * The camera's smoothing window on each side of the vehicle, as a fraction of the ground that half the frame's
 * short side spans straight below the camera. The camera then stays within a third of that window of the
 * vehicle (SmoothPath), so the vehicle stays within GLIDE_WINDOW / 3 of half the short side from the centre.
 */
export const GLIDE_WINDOW = 0.5;
/**
 * The vehicle's safe area: it stays within this fraction of the short side from the frame's centre. The window
 * keeps it within 1/12 (a 90-pixel radius on a 1080-pixel short side), and the labels keep the central 224 pixels
 * clear for it.
 */
export const SURFACE_SAFE_RADIUS = 1 / 8;
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

/**
 * Route covered (0–1) for a fraction u of a surface leg's screen time. The speed rises along a smoothstep over the
 * first SURFACE_RAMP of the time, holds steady, and falls the same way over the last, so the vehicle starts and
 * stops with no speed or acceleration and the position is C2. Steady speed is 1 / (1 − SURFACE_RAMP) of the
 * average: 1.25 times, where a flight's smootherstep peaks at 1.875.
 */
export function surfaceProgress(u: number): number {
  const x = clamp(u, 0, 1);
  const a = SURFACE_RAMP;
  if (x < a) return rampProgress(x / a);
  if (x > 1 - a) return 1 - rampProgress((1 - x) / a);
  return (x - a / 2) / (1 - a);
}

/** Route covered y of the way through a ramp: the integral of smoothstep from 0 to y is y³ − y⁴ / 2. */
function rampProgress(y: number): number {
  return (SURFACE_RAMP / (1 - SURFACE_RAMP)) * y * y * y * (1 - y / 2);
}

/** The rate of surfaceProgress: route covered per unit of u. */
export function surfaceSpeed(u: number): number {
  const x = clamp(u, 0, 1);
  const a = SURFACE_RAMP;
  const y = x < a ? x / a : x > 1 - a ? (1 - x) / a : 1;
  return (y * y * (3 - 2 * y)) / (1 - a);
}

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

/** Camera distance from Earth's centre (Earth radii) at the airports, through holds and stops. */
const GROUND_DISTANCE = cameraDistance(GROUND_RADIUS_PX);

/**
 * Height above the ground (Earth radii) of the camera over a surface leg's vehicle covering `rate` radians of
 * route a second: the airports' height, or higher where the ground straight below would otherwise cross the
 * frame faster than SURFACE_SCREEN_SPEED (FOCAL_PX × rate / height pixels a second). The two are joined by a
 * smooth maximum (an eighth-power mean), so the height follows the speed smoothly, is exactly the airports' at a
 * standstill, and rises less than 1 % until the speed nears the limit.
 */
export function droneHeight(rate: number): number {
  const low = GROUND_DISTANCE - 1;
  const needed = (FOCAL_PX * Math.max(rate, 0)) / SURFACE_SCREEN_SPEED;
  const r2 = (needed / low) * (needed / low);
  const r4 = r2 * r2;
  // The eighth root as three square roots: much cheaper than Math.pow before the code is optimized.
  return low * Math.sqrt(Math.sqrt(Math.sqrt(1 + r4 * r4)));
}

/**
 * The camera's smoothing window (radians of arc on each side) at a height: GLIDE_WINDOW of the ground that half
 * the short side spans straight below the camera, smoothly capped at the route's length, which SmoothPath needs.
 */
function glideWindow(height: number, routeLength: number): number {
  const w = GLIDE_WINDOW * height * Math.tan(SHORT_SIDE_FOV / 2);
  const r2 = (w / routeLength) * (w / routeLength);
  return w / Math.sqrt(Math.sqrt(1 + r2 * r2));
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
  // Surface legs count toward the longest: a flight's pull-back shows its length against the whole trip's.
  const longest = Math.max(...circles.map((c) => c.angle), 1e-9);
  scene.legs.forEach((leg, i) => {
    const circle = circles[i]!;
    const flightStart = t;
    const surface = leg.mode !== undefined;
    push(surface ? 'surface' : 'flight', leg.flightSeconds, i);
    const route = surface && leg.path ? PathTrack.fromPolyline(leg.path) : null;
    legs.push({
      id: leg.id,
      from: leg.from,
      to: leg.to,
      craft: surface ? leg.mode! : leg.aircraft!,
      mode: leg.mode ?? null,
      circle,
      track: route ?? circle,
      // A straight leg has no bends to smooth: the camera stays over the vehicle.
      glide: route && new SmoothPath(route.points, route.distances),
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
  /** The ground point straight below the camera: the aircraft's, or a surface leg's smoothed route. */
  eye: Vec3;
  /** The camera's distance from Earth's centre, in Earth radii. */
  distance: number;
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
        eye: leg.track.a,
        distance: GROUND_DISTANCE,
      };
    case 'flight': {
      const p = flightProgress(u);
      const ground = leg.track.at(p);
      return {
        seg,
        legIndex: seg.leg,
        legProgress: p,
        physicalUtcMs: leg.depMs + p * (leg.arrMs - leg.depMs),
        ground,
        altitude: displayAltitude(leg.cruise, p),
        heading: leg.track.tangent(p),
        eye: ground,
        distance: cameraDistance(apparentRadius(p, leg.height)),
      };
    }
    case 'surface': {
      // A drone over the vehicle: its height from the vehicle's own speed, gliding over the smoothed route.
      const p = surfaceProgress(u);
      const ground = leg.track.at(p);
      const height = droneHeight((leg.track.angle * surfaceSpeed(u)) / (seg.t1 - seg.t0));
      const glide = leg.glide;
      return {
        seg,
        legIndex: seg.leg,
        legProgress: p,
        physicalUtcMs: leg.depMs + p * (leg.arrMs - leg.depMs),
        ground,
        altitude: 0,
        heading: leg.track.tangent(p),
        eye: glide ? glide.at(p * glide.length, glideWindow(height, glide.length)) : ground,
        distance: 1 + height,
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
        eye: ground,
        distance: GROUND_DISTANCE,
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
        eye: leg.track.b,
        distance: GROUND_DISTANCE,
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
  return scale(k.eye, k.distance);
}

/** Straight down at the aircraft (or the airport it waits at, or a surface leg's smoothed route), north up. */
function evaluateCamera(k: Kinematics, aspect: number): CameraState {
  return {
    position: scale(k.eye, k.distance),
    target: [0, 0, 0],
    up: northUp(k.eye, k.heading),
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
  const labels = labelsAt(tl, t, shape, camera, (when) => evaluateCamera(kinematics(tl, when), shape), trail);
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
      const camera = scale(k.eye, k.distance);
      meters[i] = meterGlobe(camera, scale(k.eye, -1), northUp(k.eye, k.heading), tanHalf, sunDirection(k.physicalUtcMs));
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

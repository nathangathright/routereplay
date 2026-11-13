/**
 * Airport labels, as the offline renderer places them (routereplay `labels.py` and `scene_overlays.py`, and its
 * presentation contract):
 *
 * - Only the current flight's endpoints are introduced. A destination's label appears on the first frame its
 *   airport is on screen during the incoming flight; the origin's on the first frame.
 * - Until arrival the panel holds a fixed screen slot, chosen before playback from the route's direction on
 *   screen, clear of the centred aircraft and of the airport's path.
 * - On arrival its anchor locks to the ground under the panel: it stays put through the stop (the camera is still),
 *   then recedes with the ground as the camera climbs away, shrinking with distance and fading out.
 * - A departed visit retires before the leg after next begins, fading over its last 0.3 s if it is still showing.
 *   Repeated visits to an airport have separate lifetimes.
 * - A deliberate difference: a departed label never grows back. The offline renderer lets it, when the camera
 *   comes down toward the next airport on a short or north–south leg before the old label has gone; here it
 *   retires on the first frame it would grow, fading over 0.3 s.
 *
 * Everything is a pure function of the timeline, the frame's shape, and presentation time. Lengths are pixels of
 * the offline renderer's frame, whose short side is 1080, measured from the frame's centre with y down; this
 * renderer scales them to the screen's short side, as it does the camera's field of view.
 */
import { type Vec3, add, cross, dot, length, normalize, scale, smootherstep } from '../geo/vec';
import type { CameraState, Timeline } from './evaluate';

/** Split-flap panel size: three 66×108 cards with 5-pixel gaps in a 6-pixel border. */
export const PANEL_W = 220;
export const PANEL_H = 120;
/** Seconds since a label appeared until its last card has turned (three 0.52 s flips, 0.11 s apart). */
export const FLAP_DURATION = 0.52;
export const FLAP_STAGGER = 0.11;
/** How long an arrival pulse lasts, in presentation seconds. */
export const PULSE_SECONDS = 1.7;
/** A retiring label fades out over this long. */
const RETIRE_SECONDS = 0.3;

/** Focal length in pixels: 70° across a 1080-pixel short side. */
const FOCAL = 540 / Math.tan((35 * Math.PI) / 180);
/** A point counts as on screen this far inside the frame's edge and this far inside the globe's limb. */
const EDGE = 12;
const MIN_MARGIN = 0.06;
/** The centred aircraft's exclusion square (its 224-pixel sprite) and an airport ring's clearance. */
const AIRCRAFT_HALF = 112;
const RING_CLEARANCE = 18;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** 1 straight below the camera, 0 at the limb, negative behind the globe. */
  margin: number;
}

export interface LabelState {
  /** Index into the airport visit sequence: 0 is the origin, k is the arrival of leg k-1. */
  index: number;
  code: string;
  position: Vec3;
  /** Presentation seconds since the label appeared, which time its split-flap cards. */
  age: number;
  /** The panel: its top-left corner and size. */
  panel: Rect;
  opacity: number;
  /**
   * The airport on screen, while it is in front of the globe's limb (`margin` as in ScreenPoint); `reached` once
   * the aircraft has arrived there.
   */
  marker: { x: number; y: number; margin: number; reached: boolean } | null;
  /** True when a flight arrives at or leaves this place somewhere in the journey; false for a station or terminal. */
  airport: boolean;
}

/** A ring that grows from an airport as the aircraft lands there. */
export interface Pulse {
  x: number;
  y: number;
  age: number;
}

interface View {
  right: Vec3;
  up: Vec3;
  radial: Vec3;
  /** Camera distance from Earth's centre, in Earth radii. */
  d: number;
}

/** The camera looks at Earth's centre, so its axes and distance are all that projection needs. */
function viewOf(camera: CameraState): View {
  const d = length(camera.position);
  const radial = scale(camera.position, 1 / d);
  const right = normalize(cross(camera.up, radial));
  return { right, up: cross(radial, right), radial, d };
}

/** Where a point on the globe's surface lands in the frame (the offline renderer's `camera_geometry.project`). */
function project(v: View, p: Vec3): ScreenPoint {
  const lx = dot(p, v.right);
  const ly = dot(p, v.up);
  const lz = dot(p, v.radial);
  const den = Math.max(v.d - lz, 1e-6);
  return { x: (FOCAL * lx) / den, y: (-FOCAL * ly) / den, margin: (v.d * lz - 1) / (v.d - 1) };
}

interface Frame {
  halfW: number;
  halfH: number;
}

/** The frame's half-extents for a width ÷ height of `aspect`, with the short side 1080. */
function frameFor(aspect: number): Frame {
  return { halfW: 540 * Math.max(1, aspect), halfH: 540 * Math.max(1, 1 / aspect) };
}

function visible(f: Frame, p: ScreenPoint): boolean {
  return p.margin >= MIN_MARGIN && Math.abs(p.x) <= f.halfW - EDGE && Math.abs(p.y) <= f.halfH - EDGE;
}

interface Visit {
  slot: Rect;
  appear: number | null;
  /** When the anchor locks to the ground: departure for the origin, arrival otherwise. The final visit never locks. */
  lock: number | null;
  anchor: Vec3;
  /** Depth of the anchor when it locked: the panel's size scales by this over its current depth. */
  refDepth: number;
  /** When the visit's outgoing leg starts, after which its label only recedes; null for the final visit. */
  departs: number | null;
  end: number;
  /** True when `end` is a deadline the label fades out toward, rather than the frame it was found gone. */
  deadline: boolean;
  /** From `heldFrom` on, the panel keeps the size it had shrunk to, `held`, while it fades out instead of growing. */
  heldFrom: number;
  held: number;
  airport: boolean;
}

interface Layout {
  visits: Visit[];
}

type CameraAt = (t: number) => CameraState;

/**
 * Slot candidates (the offline renderer's, converted from top-left corners in its 1080×1920 frame). Consecutive
 * visits alternate between an upper and a lower lane, so a departing label and the next one stay apart.
 */
function slotCandidates(i: number, dx: number): Rect[] {
  const odd = i % 2 === 1;
  const x = Math.abs(dx) < 35 ? -110 : (i === 0 ? dx > 0 : dx <= 0) ? -320 : 100;
  const y = odd ? -350 : 170;
  const slots: [number, number][] = [
    [x, y],
    [x, odd ? y - 120 : y + 120],
  ];
  if (x !== -110) slots.push([x < -110 ? -370 : 150, odd ? -140 : -10]);
  return slots.map(([sx, sy]) => ({ x: sx, y: sy, w: PANEL_W, h: PANEL_H }));
}

/** The offline renderer's slot score: overlap with the aircraft, then nearness to the airport's path, then distance. */
function slotScore(slot: Rect, path: { x: number; y: number }[]): [number, number, number] {
  const aircraft =
    slot.x < AIRCRAFT_HALF && slot.x + slot.w > -AIRCRAFT_HALF && slot.y < AIRCRAFT_HALF && slot.y + slot.h > -AIRCRAFT_HALF;
  let near = 0;
  let total = 0;
  for (const p of path) {
    const dx = Math.max(slot.x - p.x, p.x - slot.x - slot.w, 0);
    const dy = Math.max(slot.y - p.y, p.y - slot.y - slot.h, 0);
    const dist = Math.hypot(dx, dy);
    if (dist < RING_CLEARANCE) near++;
    total += dist;
  }
  return [aircraft ? 1 : 0, near, path.length ? total / path.length : 0];
}

function lexLess(a: readonly number[], b: readonly number[]): boolean {
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k]! < b[k]!;
  return false;
}

/** The ground point under a slot's centre at the lock, and its depth then. */
function anchorFor(v: View, slot: Rect): { anchor: Vec3; refDepth: number } {
  const cx = slot.x + slot.w / 2;
  const cy = slot.y + slot.h / 2;
  // Camera-local ray (right, up, toward the camera) from the eye at (0, 0, d).
  const ray = normalize([cx / FOCAL, -cy / FOCAL, -1]);
  const b = v.d * ray[2];
  const near = -b - Math.sqrt(Math.max(b * b - (v.d * v.d - 1), 0));
  const local: Vec3 = [near * ray[0], near * ray[1], v.d + near * ray[2]];
  const anchor = add(add(scale(v.right, local[0]), scale(v.up, local[1])), scale(v.radial, local[2]));
  return { anchor, refDepth: v.d - local[2] };
}

/** A locked panel: centred on its anchor, scaled by depth, fading out between 30 % and 12 % of its size. */
function groundPanel(v: View, visit: Visit, t: number): { panel: Rect; opacity: number; scale: number } {
  const p = project(v, visit.anchor);
  const depthScale = visit.refDepth / (v.d - dot(visit.anchor, v.radial));
  const s = t >= visit.heldFrom ? Math.min(depthScale, visit.held) : depthScale;
  const w = PANEL_W * s;
  const h = PANEL_H * s;
  let opacity = p.margin > 0 ? smootherstep((s - 0.12) / 0.18) : 0;
  if (opacity < 1 / 255) opacity = 0;
  return { panel: { x: p.x - w / 2, y: p.y - h / 2, w, h }, opacity, scale: s };
}

function buildLayout(tl: Timeline, aspect: number, cameraAt: CameraAt): Layout {
  const frame = frameFor(aspect);
  const legs = tl.legs;
  const positions = tl.occurrences.map((o) => o.position);
  const fps = tl.fps;
  const frames = tl.durationInFrames;
  const views: View[] = [];
  for (let tick = 0; tick < frames; tick++) views.push(viewOf(cameraAt(tick / fps)));

  const visits: Visit[] = positions.map((position, i) => {
    const leg = legs[Math.max(0, i - 1)]!;
    const start = leg.flightStart;
    const end = leg.flightEnd;
    // Which way the route runs on screen at mid-flight decides the side.
    const mid = viewOf(cameraAt((start + end) / 2));
    const dx = project(mid, positions[Math.max(0, i - 1) + 1]!).x - project(mid, positions[Math.max(0, i - 1)]!).x;
    // The airport's path on screen while it can be seen during the incoming flight.
    const path: { x: number; y: number }[] = [];
    const see = (v: View) => {
      const p = project(v, position);
      if (visible(frame, p)) path.push(p);
    };
    if (i === 0) see(views[0]!);
    else {
      for (let tick = Math.ceil(start * fps); tick < Math.min(frames, Math.ceil(end * fps)); tick++) see(views[tick]!);
      see(viewOf(cameraAt(end)));
    }
    const candidates = slotCandidates(i, dx);
    const scores = candidates.map((c) => slotScore(c, path));
    let best = 0;
    if (scores[0]![0] !== 0 || scores[0]![1] !== 0) {
      for (let k = 1; k < scores.length; k++) if (lexLess(scores[k]!, scores[best]!)) best = k;
    }
    const slot = candidates[best]!;
    const lock = i < legs.length ? (i === 0 ? 0 : legs[i - 1]!.flightEnd) : null;
    const forcedEnd = i + 1 < legs.length ? legs[i + 1]!.flightStart : i < legs.length ? tl.duration : Infinity;
    const { anchor, refDepth } = lock === null ? { anchor: position, refDepth: 1 } : anchorFor(viewOf(cameraAt(lock)), slot);
    const code = tl.occurrences[i]!.code;
    return {
      slot,
      appear: null,
      lock,
      anchor,
      refDepth,
      departs: i < legs.length ? legs[i]!.flightStart : null,
      end: forcedEnd,
      deadline: true,
      heldFrom: Infinity,
      held: Infinity,
      airport: legs.some((l) => l.mode === null && (l.from === code || l.to === code)),
    };
  });

  // First frame each visit is seen. For a locked panel: the first frame it has gone (transparent or out of frame),
  // or, once departed, the first frame it would grow back, from which it fades out instead.
  const shrinking = visits.map(() => Infinity);
  for (let tick = 0; tick < frames; tick++) {
    const t = tick / fps;
    const v = views[tick]!;
    visits.forEach((visit, i) => {
      const intro = i === 0 ? 0 : legs[i - 1]!.flightStart;
      if (visit.appear === null && t >= intro && visible(frame, project(v, positions[i]!))) visit.appear = t;
      if (visit.lock !== null && visit.lock <= t && t < visit.end) {
        const { panel, opacity, scale: s } = groundPanel(v, visit, t);
        const gone =
          panel.x >= frame.halfW || panel.x + panel.w <= -frame.halfW || panel.y >= frame.halfH || panel.y + panel.h <= -frame.halfH;
        if (opacity === 0 || gone) {
          visit.end = t;
          visit.deadline = false;
        } else if (visit.departs !== null && t > visit.departs && s > shrinking[i]! * (1 + 1e-9)) {
          visit.end = Math.min(visit.end, t + RETIRE_SECONDS + 1 / fps);
          visit.heldFrom = t;
          visit.held = shrinking[i]!;
        }
        shrinking[i] = s;
      }
    });
  }
  return { visits };
}

const layouts = new WeakMap<Timeline, Map<number, Layout>>();

function layoutFor(tl: Timeline, aspect: number, cameraAt: CameraAt): Layout {
  let byAspect = layouts.get(tl);
  if (!byAspect) layouts.set(tl, (byAspect = new Map()));
  let layout = byAspect.get(aspect);
  if (!layout) {
    // A resizing window asks for many shapes; keep only the recent ones.
    if (byAspect.size >= 4) byAspect.delete(byAspect.keys().next().value!);
    layout = buildLayout(tl, aspect, cameraAt);
    byAspect.set(aspect, layout);
  }
  return layout;
}

/**
 * The labels, airport markers, and arrival pulses at presentation time `t` for a frame `aspect` (width ÷ height)
 * wide. `camera` is the camera at `t`; `cameraAt` evaluates it at other times, for the layout computed once per
 * timeline and frame shape; `trail` is each leg's flown fraction.
 */
export function labelsAt(
  tl: Timeline,
  t: number,
  aspect: number,
  camera: CameraState,
  cameraAt: CameraAt,
  trail: readonly number[],
): { labels: LabelState[]; pulses: Pulse[] } {
  const layout = layoutFor(tl, aspect, cameraAt);
  const v = viewOf(camera);
  const labels: LabelState[] = [];
  layout.visits.forEach((visit, i) => {
    if (visit.appear === null || t < visit.appear || t >= visit.end) return;
    const occ = tl.occurrences[i]!;
    let { panel, opacity } = visit.lock !== null && t >= visit.lock ? groundPanel(v, visit, t) : { panel: visit.slot, opacity: 1 };
    if (visit.deadline) {
      // Retiring while still on screen (a departed label that would grow back, or the leg after next is
      // starting): fade it out before the deadline frame.
      opacity *= smootherstep((visit.end - 1 / tl.fps - t) / RETIRE_SECONDS);
      if (opacity < 1 / 255) opacity = 0;
    }
    const p = project(v, occ.position);
    const reached = i === 0 || (trail[i - 1] ?? 0) >= 0.999;
    labels.push({
      index: occ.index,
      code: occ.code,
      position: occ.position,
      age: t - visit.appear,
      panel,
      opacity,
      marker: p.margin >= 0 ? { x: p.x, y: p.y, margin: p.margin, reached } : null,
      airport: visit.airport,
    });
  });
  const pulses: Pulse[] = [];
  tl.legs.forEach((leg, k) => {
    const age = t - leg.flightEnd;
    if (age < 0 || age >= PULSE_SECONDS) return;
    const p = project(v, tl.occurrences[k + 1]!.position);
    if (p.margin > 0) pulses.push({ x: p.x, y: p.y, age });
  });
  return { labels, pulses };
}

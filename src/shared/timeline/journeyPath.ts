/**
 * The line a train, bus, car, or ferry stands on: its leg's track, joined with any legs either side travelled
 * the same way (train after train), measured in radians of arc from the start of the first. Each body's front
 * and rear rest on the line, so a vehicle turns with the route and a train's cars follow its locomotive round
 * bends. Beyond the line's ends the bodies carry straight on, so they never stray onto a flight's ground track
 * or another mode's route while one dissolves into the other at a connection.
 */
import type { Track } from '../geo/track';
import { type Vec3, add, dot, normalize, scale, sub } from '../geo/vec';
import type { SurfaceMode } from '../scene/constants';
import type { SceneState, Timeline } from './evaluate';

/**
 * How much of the line at each end sets the direction it carries on in, in radians (about 30 km). A traced route
 * starts and ends at an airport, often with a short connector to the station at an angle to the line itself.
 */
const END_CHORD = 30 / 6371;

export class JourneyPath {
  private readonly tracks: readonly Track[];
  /** Distance at the start of each track, and the total at the end. */
  private readonly starts: number[];
  /** The line's direction at its two ends, along the chord over its first and last END_CHORD. */
  private readonly startDirection: Vec3;
  private readonly endDirection: Vec3;

  constructor(tracks: readonly Track[]) {
    this.tracks = tracks;
    const starts = [0];
    for (const t of tracks) starts.push(starts[starts.length - 1]! + t.angle);
    this.starts = starts;
    const reach = Math.min(END_CHORD, this.length);
    const first = tracks[0]!.a;
    const last = tracks[tracks.length - 1]!.b;
    this.startDirection = along(first, sub(this.within(reach), first));
    this.endDirection = along(last, sub(last, this.within(this.length - reach)));
  }

  get length(): number {
    return this.starts[this.starts.length - 1]!;
  }

  /** Distance from the start of the line to a fraction of the way along its k-th track. */
  distance(track: number, progress: number): number {
    return this.starts[track]! + progress * this.tracks[track]!.angle;
  }

  /** The ground point at distance s, carrying straight on (along a great circle) beyond either end. */
  at(s: number): Vec3 {
    if (s <= 0) return beyond(this.tracks[0]!.a, this.startDirection, s);
    if (s >= this.length) return beyond(this.tracks[this.tracks.length - 1]!.b, this.endDirection, s - this.length);
    return this.within(s);
  }

  private within(s: number): Vec3 {
    let i = 0;
    while (i < this.tracks.length - 1 && s >= this.starts[i + 1]!) i++;
    const track = this.tracks[i]!;
    return track.at((s - this.starts[i]!) / track.angle);
  }
}

/** The unit direction of `d` along the ground at `p`. */
function along(p: Vec3, d: Vec3): Vec3 {
  return normalize(sub(d, scale(p, dot(d, p))));
}

/** The point `d` radians from `p` along the unit tangent `t` (backwards when d < 0). */
function beyond(p: Vec3, t: Vec3, d: number): Vec3 {
  return normalize(add(scale(p, Math.cos(d)), scale(t, Math.sin(d))));
}

interface Line {
  path: JourneyPath;
  /** Index of the line's first leg. */
  first: number;
}

const lines = new WeakMap<Timeline, Line[]>();

/** The line each leg's vehicle stands on: runs of consecutive legs with the same mode share one. */
function legLines(tl: Timeline): Line[] {
  let out = lines.get(tl);
  if (!out) {
    out = [];
    for (let i = 0; i < tl.legs.length; ) {
      let j = i + 1;
      const mode = tl.legs[i]!.mode;
      while (mode !== null && j < tl.legs.length && tl.legs[j]!.mode === mode) j++;
      const line = { path: new JourneyPath(tl.legs.slice(i, j).map((l) => l.track)), first: i };
      for (let k = i; k < j; k++) out.push(line);
      i = j;
    }
    lines.set(tl, out);
  }
  return out;
}

/**
 * Where the `mode` vehicle stands at this moment: its line, and its distance along it. That is the current leg,
 * or, while a connection dissolves into it, the leg about to depart.
 */
export function vehiclePlace(
  tl: Timeline,
  state: Pick<SceneState, 'legIndex' | 'legProgress'>,
  mode: SurfaceMode,
): { path: JourneyPath; at: number } {
  const current = tl.legs[state.legIndex]!.mode === mode;
  const leg = current ? state.legIndex : state.legIndex + 1;
  const { path, first } = legLines(tl)[leg]!;
  return { path, at: path.distance(leg - first, current ? state.legProgress : 0) };
}

/** One rigid body standing on the path: its centre on the ground, and its heading. */
export interface BodyPose {
  ground: Vec3;
  heading: Vec3;
}

/**
 * Where a body `length` long stands with its front at distance `front`: its front and rear both on the path,
 * like a railway car on its bogies. Its centre is the middle of that chord, so on a bend it cuts the corner
 * slightly, and it points from rear to front.
 */
export function bodyOnPath(path: JourneyPath, front: number, length: number): BodyPose {
  const f = path.at(front);
  const r = path.at(front - length);
  const ground = normalize(add(f, r));
  const chord = sub(f, r);
  return { ground, heading: normalize(sub(chord, scale(ground, dot(chord, ground)))) };
}

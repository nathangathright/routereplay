/**
 * The ground under the whole journey: every leg's track, end to end, measured in radians of arc from the first
 * departure. Train, bus, car, and ferry models stand on it: each body's front and rear rest on the line, so a
 * vehicle turns with the route and a train's cars follow its locomotive round bends and through connections.
 */
import type { Track } from '../geo/track';
import { type Vec3, add, dot, normalize, scale, sub } from '../geo/vec';
import type { Timeline } from './evaluate';

export class JourneyPath {
  private readonly tracks: readonly Track[];
  /** Distance at the start of each leg, and the total at the end. */
  private readonly starts: number[];

  constructor(tracks: readonly Track[]) {
    this.tracks = tracks;
    const starts = [0];
    for (const t of tracks) starts.push(starts[starts.length - 1]! + t.angle);
    this.starts = starts;
  }

  get length(): number {
    return this.starts[this.starts.length - 1]!;
  }

  /** Distance from the first departure to a fraction of the way along a leg. */
  distance(leg: number, progress: number): number {
    return this.starts[leg]! + progress * this.tracks[leg]!.angle;
  }

  /** The ground point at distance s, continuing straight ahead (along a great circle) beyond either end. */
  at(s: number): Vec3 {
    if (s <= 0) return beyond(this.tracks[0]!.a, this.tracks[0]!.tangent(0), s);
    const end = this.length;
    const last = this.tracks[this.tracks.length - 1]!;
    if (s >= end) return beyond(last.b, last.tangent(1), s - end);
    let i = 0;
    while (s >= this.starts[i + 1]!) i++;
    const track = this.tracks[i]!;
    return track.at((s - this.starts[i]!) / track.angle);
  }
}

const paths = new WeakMap<Timeline, JourneyPath>();

/** The journey's path, built once per timeline. */
export function journeyPath(tl: Timeline): JourneyPath {
  let p = paths.get(tl);
  if (!p) {
    p = new JourneyPath(tl.legs.map((l) => l.track));
    paths.set(tl, p);
  }
  return p;
}

/** The point `d` radians from `p` along the unit tangent `t` (backwards when d < 0). */
function beyond(p: Vec3, t: Vec3, d: number): Vec3 {
  return normalize(add(scale(p, Math.cos(d)), scale(t, Math.sin(d))));
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

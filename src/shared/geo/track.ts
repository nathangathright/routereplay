/**
 * The line a leg follows: a great circle for flights, or a looked-up route (railway, road, ferry line) for
 * surface legs. Both are parametrized by the fraction f of the distance along them.
 */
import { COINCIDENT_ANGLE, GreatCircle } from './greatCircle';
import { type Vec3, add, clamp, latLonToVec, normalize } from './vec';
import { decodePolyline } from './polyline';

export interface Track {
  readonly a: Vec3;
  readonly b: Vec3;
  /** Length along the track, in radians of arc. */
  readonly angle: number;
  /** Fractions of the length where the track turns; drawing samples them so corners stay sharp. */
  readonly corners: readonly number[];
  at(f: number): Vec3;
  /** Unit direction of travel at f; at a corner, the bisector of the two directions. */
  tangent(f: number): Vec3;
}

const CORNER_EPS = 1e-9;

/** A route of great-circle segments through the given points, at constant speed along its length. */
export class PathTrack implements Track {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly angle: number;
  readonly corners: readonly number[];
  private readonly segments: GreatCircle[];
  /** Arc length at the start of each segment, and the total at the end. */
  private readonly cumulative: number[];

  private constructor(points: Vec3[]) {
    const segments: GreatCircle[] = [];
    for (let i = 1; i < points.length; i++) segments.push(new GreatCircle(points[i - 1]!, points[i]!));
    const cumulative = [0];
    for (const s of segments) cumulative.push(cumulative[cumulative.length - 1]! + s.angle);
    this.segments = segments;
    this.cumulative = cumulative;
    this.angle = cumulative[cumulative.length - 1]!;
    this.a = segments[0]!.a;
    this.b = segments[segments.length - 1]!.b;
    this.corners = cumulative.slice(1, -1).map((s) => s / this.angle);
  }

  /** Points closer than a few metres are merged. Null when fewer than two distinct points remain. */
  static fromPoints(points: readonly Vec3[]): PathTrack | null {
    const distinct: Vec3[] = [];
    for (const p of points) {
      const last = distinct[distinct.length - 1];
      if (!last) distinct.push(normalize(p));
      else {
        try {
          if (new GreatCircle(last, p).angle >= COINCIDENT_ANGLE) distinct.push(normalize(p));
        } catch {
          // Coincident with the previous point: skip it.
        }
      }
    }
    return distinct.length >= 2 ? new PathTrack(distinct) : null;
  }

  /** From an encoded polyline; null when it is malformed or degenerate. */
  static fromPolyline(encoded: string): PathTrack | null {
    try {
      return PathTrack.fromPoints(decodePolyline(encoded).map(([lat, lon]) => latLonToVec(lat, lon)));
    } catch {
      return null;
    }
  }

  private locate(f: number): { k: number; u: number } {
    const s = clamp(f, 0, 1) * this.angle;
    const c = this.cumulative;
    let lo = 0;
    let hi = this.segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c[mid]! <= s) lo = mid;
      else hi = mid - 1;
    }
    const len = this.segments[lo]!.angle;
    return { k: lo, u: clamp((s - c[lo]!) / len, 0, 1) };
  }

  at(f: number): Vec3 {
    const { k, u } = this.locate(f);
    return this.segments[k]!.at(u);
  }

  tangent(f: number): Vec3 {
    const { k, u } = this.locate(f);
    const seg = this.segments[k]!;
    // Exactly on a corner (where drawing samples), point between the incoming and outgoing directions.
    if (u < CORNER_EPS && k > 0) return normalize(add(this.segments[k - 1]!.tangent(1), seg.tangent(0)), seg.tangent(0));
    if (u > 1 - CORNER_EPS && k < this.segments.length - 1)
      return normalize(add(seg.tangent(1), this.segments[k + 1]!.tangent(0)), seg.tangent(1));
    return seg.tangent(u);
  }
}

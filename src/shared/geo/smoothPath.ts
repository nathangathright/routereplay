/**
 * A route low-passed along its length, for a camera that glides over a winding road or railway instead of
 * following every bend. Its point at distance s, for a window w, is the tent-weighted mean of the route within ±w
 * of s (the weight falls linearly from the middle to nothing at ±w). Bends much shorter than w average away, and
 * longer ones are followed. The mean is symmetric, so it never lags behind the route or runs ahead of it.
 *
 * - **Ends:** beyond each end the route is point-reflected through the end, so the mean at either end is the end
 *   itself, and near the ends it still cuts corners rather than stopping short.
 * - **Close to the route:** no point within ±w of s is farther from the route's point at s than |s − s'| along it,
 *   so the mean lies within w/3 of it (the tent's mean distance), however the route winds or doubles back. The
 *   reflection keeps that true at the ends.
 * - **Exact and cheap:** the route's segments are taken as straight chords (a 0.5 km segment's chord is within
 *   millimetres of its arc), so the mean is a second difference of the route's twice-integrated position. There is
 *   no sampling grid to alias the route's wiggles. Building is one pass over the route, and each point costs three
 *   binary searches; the reflections come from the route's own integrals in closed form.
 * - **Smooth:** the twice-integrated position has a continuous second derivative, so the mean's position, speed,
 *   and acceleration along the route are continuous for any w, and in w.
 *
 * A pure function of the route, s, and w, so any moment can be evaluated in any order.
 */
import { type Vec3, normalize } from './vec';

export class SmoothPath {
  /** Length of the route, in radians of arc. */
  readonly length: number;
  /** Distance along the route of each vertex. */
  private readonly s: Float64Array;
  /** Each vertex's position, and the route's first and second running integrals from its start: three values each. */
  private readonly x: Float64Array;
  private readonly i1: Float64Array;
  private readonly i2: Float64Array;

  /** `points` are the route's vertices and `distances` how far along the route each lies (0 first, increasing). */
  constructor(points: readonly Vec3[], distances: readonly number[]) {
    const m = points.length;
    if (m < 2 || distances.length !== m) throw new RangeError('A smooth path needs two or more points');
    const s = new Float64Array(m);
    const x = new Float64Array(3 * m);
    const i1 = new Float64Array(3 * m);
    const i2 = new Float64Array(3 * m);
    for (let k = 0; k < m; k++) {
      const p = points[k]!;
      s[k] = distances[k]!;
      x[3 * k] = p[0];
      x[3 * k + 1] = p[1];
      x[3 * k + 2] = p[2];
    }
    for (let k = 0; k < m - 1; k++) {
      const l = s[k + 1]! - s[k]!;
      for (let c = 3 * k; c < 3 * k + 3; c++) {
        const a = x[c]!;
        const b = x[c + 3]!;
        i1[c + 3] = i1[c]! + (l * (a + b)) / 2;
        i2[c + 3] = i2[c]! + l * (i1[c]! + l * (a / 3 + b / 6));
      }
    }
    this.length = s[m - 1]!;
    this.s = s;
    this.x = x;
    this.i1 = i1;
    this.i2 = i2;
  }

  /** The route's second running integral at distance t in [0, length], times `weight`, added to `out`. */
  private within(t: number, weight: number, out: [number, number, number]): void {
    const s = this.s;
    let k = 0;
    let hi = s.length - 2;
    while (k < hi) {
      const mid = (k + hi + 1) >> 1;
      if (s[mid]! <= t) k = mid;
      else hi = mid - 1;
    }
    const u = t - s[k]!;
    const f = u / (6 * (s[k + 1]! - s[k]!));
    const x = this.x;
    const i1 = this.i1;
    const i2 = this.i2;
    const i = 3 * k;
    out[0] += weight * (i2[i]! + u * (i1[i]! + u * (x[i]! / 2 + (x[i + 3]! - x[i]!) * f)));
    out[1] += weight * (i2[i + 1]! + u * (i1[i + 1]! + u * (x[i + 1]! / 2 + (x[i + 4]! - x[i + 1]!) * f)));
    out[2] += weight * (i2[i + 2]! + u * (i1[i + 2]! + u * (x[i + 2]! / 2 + (x[i + 5]! - x[i + 2]!) * f)));
  }

  /**
   * Adds `weight` × the second running integral, at distance t from −length to 2 × length, of the route extended by
   * its reflections through either end, to `out`. With r̃(t) = 2·r(0) − r(−t) before the start, its integral is
   * r(0)·t² − J(−t); with r̃(t) = 2·r(L) − r(2L − t) after the end, it is 2·J(L) + r(L)·(t − L)² − J(2L − t).
   */
  private add(out: [number, number, number], t: number, weight: number): void {
    const L = this.length;
    const x = this.x;
    if (t < 0) {
      this.within(Math.min(-t, L), -weight, out);
      const q = weight * t * t;
      out[0] += q * x[0]!;
      out[1] += q * x[1]!;
      out[2] += q * x[2]!;
    } else if (t > L) {
      this.within(Math.max(2 * L - t, 0), -weight, out);
      const e = x.length - 3;
      const q = weight * (t - L) * (t - L);
      const j = this.i2;
      out[0] += 2 * weight * j[e]! + q * x[e]!;
      out[1] += 2 * weight * j[e + 1]! + q * x[e + 1]!;
      out[2] += 2 * weight * j[e + 2]! + q * x[e + 2]!;
    } else {
      this.within(t, weight, out);
    }
  }

  /**
   * The smoothed route at distance `at` along it, for a tent `window` wide on each side (both in radians of arc),
   * as a unit vector. The distance is clamped to the route and the window to (0, length].
   */
  at(at: number, window: number): Vec3 {
    const L = this.length;
    const s = Math.min(Math.max(at, 0), L);
    const w = Math.min(Math.max(window, 1e-9 * L), L);
    // The tent mean times w²: the second difference of the twice-integrated route.
    const sum: [number, number, number] = [0, 0, 0];
    this.add(sum, s + w, 1);
    this.add(sum, s, -2);
    this.add(sum, s - w, 1);
    return normalize(sum);
  }
}

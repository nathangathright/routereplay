/**
 * Routes as encoded polylines (Google's format at 1e-5 degrees, about a metre: what OSRM returns), and
 * Douglas–Peucker simplification to keep a looked-up route small enough to store in every record.
 */
import { EARTH_RADIUS_KM } from './greatCircle';

export type LatLon = [lat: number, lon: number];

const FACTOR = 1e5;

function encodeValue(v: number): string {
  let x = v < 0 ? ~(v << 1) : v << 1;
  let s = '';
  while (x >= 0x20) {
    s += String.fromCharCode((0x20 | (x & 0x1f)) + 63);
    x >>>= 5;
  }
  return s + String.fromCharCode(x + 63);
}

export function encodePolyline(points: readonly LatLon[]): string {
  let lat0 = 0;
  let lon0 = 0;
  let out = '';
  for (const [lat, lon] of points) {
    const lat1 = Math.round(lat * FACTOR);
    const lon1 = Math.round(lon * FACTOR);
    out += encodeValue(lat1 - lat0) + encodeValue(lon1 - lon0);
    lat0 = lat1;
    lon0 = lon1;
  }
  return out;
}

/** Decodes an encoded polyline. Throws on malformed input rather than returning stray points. */
export function decodePolyline(s: string): LatLon[] {
  const out: LatLon[] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      if (i >= s.length) throw new RangeError('Truncated polyline');
      b = s.charCodeAt(i++) - 63;
      if (b < 0 || b > 63 || shift > 30) throw new RangeError('Malformed polyline');
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < s.length) {
    lat += next();
    lon += next();
    out.push([lat / FACTOR, lon / FACTOR]);
  }
  return out;
}

/** Shifts longitudes by whole turns so consecutive points never jump across the antimeridian. */
export function unwrapLongitudes(points: readonly LatLon[]): LatLon[] {
  const out: LatLon[] = [];
  let prev: number | null = null;
  for (const [lat, lon] of points) {
    const l: number = prev === null ? lon : lon + 360 * Math.round((prev - lon) / 360);
    out.push([lat, l]);
    prev = l;
  }
  return out;
}

/** Length of a path along the ground, in kilometres (great-circle segments). */
export function pathLengthKm(points: readonly LatLon[]): number {
  const R = Math.PI / 180;
  let km = 0;
  for (let i = 1; i < points.length; i++) {
    const [la1, lo1] = points[i - 1]!;
    const [la2, lo2] = points[i]!;
    const h =
      Math.sin(((la2 - la1) * R) / 2) ** 2 + Math.cos(la1 * R) * Math.cos(la2 * R) * Math.sin(((lo2 - lo1) * R) / 2) ** 2;
    km += 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  return km;
}

/**
 * Douglas–Peucker simplification to `toleranceKm`, measured in a local equirectangular projection (accurate
 * enough for the tolerance; routes are regional). Endpoints are always kept.
 */
export function simplifyPath(input: readonly LatLon[], toleranceKm: number): LatLon[] {
  const all = unwrapLongitudes(input);
  if (all.length <= 2) return all;
  const R = Math.PI / 180;
  let latSum = 0;
  for (const p of all) latSum += p[0];
  const kx = EARTH_RADIUS_KM * R * Math.cos((latSum / all.length) * R);
  const ky = EARTH_RADIUS_KM * R;
  const tol2 = toleranceKm * toleranceKm;
  // A cheap first pass drops points within the tolerance of the last one kept, which is most of a detailed
  // route; Douglas–Peucker then runs on what is left. Plain arrays of numbers keep both loops fast.
  const xs: number[] = [];
  const ys: number[] = [];
  const points: LatLon[] = [];
  const last = all.length - 1;
  for (let i = 0; i <= last; i++) {
    const p = all[i]!;
    const x = p[1] * kx;
    const y = p[0] * ky;
    const n = xs.length;
    if (n > 0 && i < last && (x - xs[n - 1]!) ** 2 + (y - ys[n - 1]!) ** 2 < tol2) continue;
    xs.push(x);
    ys.push(y);
    points.push(p);
  }
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  // Iterative, so a route with thousands of points cannot overflow the stack.
  const stack: number[] = [0, points.length - 1];
  while (stack.length) {
    const i1 = stack.pop()!;
    const i0 = stack.pop()!;
    const ax = xs[i0]!;
    const ay = ys[i0]!;
    const dx = xs[i1]! - ax;
    const dy = ys[i1]! - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD2 = tol2;
    for (let i = i0 + 1; i < i1; i++) {
      const px = xs[i]! - ax;
      const py = ys[i]! - ay;
      const t = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const ex = t * dx - px;
      const ey = t * dy - py;
      const d2 = ex * ex + ey * ey;
      if (d2 > worstD2) {
        worstD2 = d2;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push(i0, worst, worst, i1);
    }
  }
  return points.filter((_, i) => keep[i]);
}

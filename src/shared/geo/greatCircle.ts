import { type Vec3, clamp, cross, dot, latLonToVec, length, normalize, scale, add } from './vec';

export const EARTH_RADIUS_KM = 6371.0088;

/** Central angle in radians between two unit vectors (numerically stable atan2 form). */
export function centralAngle(a: Vec3, b: Vec3): number {
  return Math.atan2(length(cross(a, b)), clamp(dot(a, b), -1, 1));
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return centralAngle(latLonToVec(lat1, lon1), latLonToVec(lat2, lon2)) * EARTH_RADIUS_KM;
}

/** Angular separation (radians) below which two points are treated as the same place. */
export const COINCIDENT_ANGLE = 1e-6;
/** Separation from exact antipodes (radians) below which the great circle is ambiguous. */
export const ANTIPODAL_MARGIN = 1e-3;

export class GreatCircle {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly angle: number;
  /** A great circle never turns (see Track). */
  readonly corners: readonly number[] = [];
  private readonly sinAngle: number;

  constructor(a: Vec3, b: Vec3) {
    this.a = normalize(a);
    this.b = normalize(b);
    this.angle = centralAngle(this.a, this.b);
    this.sinAngle = Math.sin(this.angle);
    if (this.angle < COINCIDENT_ANGLE) throw new RangeError('Great circle endpoints coincide');
    if (Math.PI - this.angle < ANTIPODAL_MARGIN) throw new RangeError('Great circle endpoints are antipodal');
  }

  static fromLatLon(lat1: number, lon1: number, lat2: number, lon2: number): GreatCircle {
    return new GreatCircle(latLonToVec(lat1, lon1), latLonToVec(lat2, lon2));
  }

  /** Spherical linear interpolation; f is clamped to [0, 1]. */
  at(f: number): Vec3 {
    const t = clamp(f, 0, 1);
    const wa = Math.sin((1 - t) * this.angle) / this.sinAngle;
    const wb = Math.sin(t * this.angle) / this.sinAngle;
    return normalize(add(scale(this.a, wa), scale(this.b, wb)));
  }

  /** Unit tangent (direction of travel) at fraction f. */
  tangent(f: number): Vec3 {
    const t = clamp(f, 0, 1);
    const k = this.angle / this.sinAngle;
    const da = -Math.cos((1 - t) * this.angle) * k;
    const db = Math.cos(t * this.angle) * k;
    const d = add(scale(this.a, da), scale(this.b, db));
    const p = this.at(t);
    // Remove any radial component introduced by rounding.
    return normalize(add(d, scale(p, -dot(d, p))));
  }
}

/**
 * Minimal immutable 3-vector helpers shared by the server, the timeline, and the renderer.
 *
 * World frame (matches three.js SphereGeometry texture mapping):
 *   +Y is the north pole, +X is (0°N, 0°E), -Z is (0°N, 90°E).
 */
export type Vec3 = readonly [number, number, number];

export const vec = (x: number, y: number, z: number): Vec3 => [x, y, z];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const normalize = (a: Vec3, fallback: Vec3 = [0, 1, 0]): Vec3 => {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l) : fallback;
};
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Zero speed and acceleration at both ends. */
export function smootherstep(x: number): number {
  const v = clamp(x, 0, 1);
  return v * v * v * (v * (v * 6 - 15) + 10);
}

const DEG = Math.PI / 180;

/** Unit vector for geodetic latitude/longitude in degrees (spherical Earth). */
export function latLonToVec(latDeg: number, lonDeg: number): Vec3 {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const c = Math.cos(lat);
  return [c * Math.cos(lon), Math.sin(lat), -c * Math.sin(lon)];
}

/** Inverse of latLonToVec. Longitude is normalized to (-180, 180]. */
export function vecToLatLon(v: Vec3): { lat: number; lon: number } {
  const n = normalize(v);
  const lat = Math.asin(clamp(n[1], -1, 1)) / DEG;
  let lon = Math.atan2(-n[2], n[0]) / DEG;
  if (lon <= -180) lon += 360;
  return { lat, lon };
}

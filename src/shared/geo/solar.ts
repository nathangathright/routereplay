import { type Vec3, latLonToVec, scale } from './vec';

const DEG = Math.PI / 180;

/** Days since J2000.0 (2000-01-01 12:00 TT, ignoring the TT-UTC offset). */
const daysSinceJ2000 = (utcMs: number) => utcMs / 86_400_000 + 2440587.5 - 2451545.0;

/** Greenwich mean sidereal time in degrees. */
const gmstDegrees = (n: number) => (280.46061837 + 360.98564736629 * n) % 360;

/** The point on the ground directly under a body at this right ascension and declination. */
function groundPoint(rightAscension: number, declination: number, n: number): { lat: number; lon: number } {
  let lon = rightAscension / DEG - gmstDegrees(n);
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: declination / DEG, lon };
}

/** Right ascension and declination for ecliptic longitude and latitude. */
function equatorial(lambda: number, beta: number, epsilon: number): { rightAscension: number; declination: number } {
  const x = Math.cos(beta) * Math.cos(lambda);
  const y = Math.cos(epsilon) * Math.cos(beta) * Math.sin(lambda) - Math.sin(epsilon) * Math.sin(beta);
  const z = Math.sin(epsilon) * Math.cos(beta) * Math.sin(lambda) + Math.cos(epsilon) * Math.sin(beta);
  return { rightAscension: Math.atan2(y, x), declination: Math.asin(z) };
}

/**
 * Subsolar point for a UTC instant using the low-precision almanac formulas
 * (Astronomical Almanac, "Low precision formulas for the Sun"), accurate to about 0.01°
 * between 1950 and 2050 and adequate for a terminator illustration.
 */
export function subsolarPoint(utcMs: number): { lat: number; lon: number } {
  const n = daysSinceJ2000(utcMs);
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const epsilon = (23.439 - 0.0000004 * n) * DEG;
  const { rightAscension, declination } = equatorial(lambda, 0, epsilon);
  return groundPoint(rightAscension, declination, n);
}

/** Unit vector from Earth's center toward the Sun in the world frame. */
export function sunDirection(utcMs: number): Vec3 {
  const p = subsolarPoint(utcMs);
  return latLonToVec(p.lat, p.lon);
}

/**
 * Sublunar point and distance (in Earth radii) for a UTC instant, from the low-precision
 * almanac formulas for the Moon (Astronomical Almanac, "Low precision formulas for the Moon"):
 * about 0.3° in position and 0.2 Earth radii in distance between 1950 and 2050.
 */
export function sublunarPoint(utcMs: number): { lat: number; lon: number; distance: number } {
  const n = daysSinceJ2000(utcMs);
  const T = n / 36525;
  const s = (deg: number) => Math.sin(deg * DEG);
  const c = (deg: number) => Math.cos(deg * DEG);
  const lambda =
    218.32 +
    481267.881 * T +
    6.29 * s(135.0 + 477198.87 * T) -
    1.27 * s(259.3 - 413335.36 * T) +
    0.66 * s(235.7 + 890534.22 * T) +
    0.21 * s(269.9 + 954397.74 * T) -
    0.19 * s(357.5 + 35999.05 * T) -
    0.11 * s(186.5 + 966404.03 * T);
  const beta =
    5.13 * s(93.3 + 483202.02 * T) +
    0.28 * s(228.2 + 960400.89 * T) -
    0.28 * s(318.3 + 6003.15 * T) -
    0.17 * s(217.6 - 407332.21 * T);
  const parallax =
    0.9508 +
    0.0518 * c(135.0 + 477198.87 * T) +
    0.0095 * c(259.3 - 413335.36 * T) +
    0.0078 * c(235.7 + 890534.22 * T) +
    0.0028 * c(269.9 + 954397.74 * T);
  const epsilon = (23.439 - 0.0000004 * n) * DEG;
  const { rightAscension, declination } = equatorial((lambda % 360) * DEG, beta * DEG, epsilon);
  return { ...groundPoint(rightAscension, declination, n), distance: 1 / Math.sin(parallax * DEG) };
}

/** The Moon's center in the world frame, in Earth radii from Earth's center. */
export function moonPosition(utcMs: number): Vec3 {
  const p = sublunarPoint(utcMs);
  return scale(latLonToVec(p.lat, p.lon), p.distance);
}

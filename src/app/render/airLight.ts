/**
 * The air's optics on the CPU, for light that is worked out once a frame rather than once a pixel: the aircraft's
 * and vehicles' sunlight, moonlight, and sky. Same constants and Chapman columns as AIR_GLSL (lighting.ts), so a
 * plane is reddened by the same air as the cloud tops below it. Lengths are in Earth radii, in the Earth's frame.
 */
import { type Vec3, dot, length, smoothstep } from '../../shared/geo/vec';
import { ATMOSPHERE_TOP, HAZE_BACKSCATTER } from './lighting';

/** Linear RGB. */
export type RGB = [number, number, number];

/** Heights of the drawn air are spread this much (routereplay atmosphere.py), with extinction divided by it. */
export const AIR_SPREAD = 7.2;
/** Scale heights of air (Rayleigh) and haze (Mie), Earth radii: 57.6 km and 8.64 km. */
export const H_R = (8.0 * AIR_SPREAD) / 6371.0;
export const H_M = (1.2 * AIR_SPREAD) / 6371.0;
/** Scattering at the ground, per Earth radius: air by colour, and haze (extinction is haze ÷ 0.9). */
export const BETA_R: RGB = [0.0058, 0.0135, 0.0331].map((b) => (b * 6371.0) / AIR_SPREAD) as RGB;
export const BETA_M = (0.003 * 6371.0) / AIR_SPREAD;
export const BETA_ME = BETA_M / 0.9;
/**
 * Sunlight above the air, relative to the light a high Sun gives at the ground (what paint and the ground's shading
 * take as white): the inverse of one vertical column's transmittance. Light worked out from above the air (the sky,
 * the cloud deck's light) is multiplied by it to be in those units, as in AIR_GLSL.
 */
export const SUN_ABOVE_AIR: RGB = BETA_R.map((b) => Math.exp(b * H_R + BETA_ME * H_M)) as RGB;
/** Angular radius of the Sun (and, near enough, the Moon). */
const SUN_RADIUS = ((0.533 / 2) * Math.PI) / 180;
/** The atmosphere's bounded secondary scattering (Earth.tsx): light scattered more than once, as a share of single. */
const SECONDARY = 0.38 / (1 - 0.38);

/** Chapman grazing-incidence function for x = r/H and zenith cosine mu ≥ 0 (within about 5 %). */
export function chapman(x: number, mu: number): number {
  const y = Math.sqrt(0.5 * x) * mu;
  return Math.sqrt(2 * x) / (y + Math.sqrt(y * y + 1.2732395));
}

/** Columns of air and haze from p toward d (pointing up, or level) out to space. */
export function columnUp(p: Vec3, d: Vec3): [air: number, haze: number] {
  const r = length(p);
  const mu = Math.max(dot(p, d) / r, 0);
  const h = Math.max(r - 1, -0.0005);
  return [chapman(r / H_R, mu) * Math.exp(-h / H_R) * H_R, chapman(r / H_M, mu) * Math.exp(-h / H_M) * H_M];
}

/** Columns from p toward the light s, which may point below p's horizontal but clears the planet. */
export function columnToLight(p: Vec3, s: Vec3): [air: number, haze: number] {
  const along = dot(p, s);
  if (along >= 0) return columnUp(p, s);
  // Past the lowest point: the whole path through it, less the part behind p.
  const low: Vec3 = [p[0] - s[0] * along, p[1] - s[1] * along, p[2] - s[2] * along];
  const through = columnUp(low, s);
  const behind = columnUp(p, [-s[0], -s[1], -s[2]]);
  return [2 * through[0] - behind[0], 2 * through[1] - behind[1]];
}

export function extinction([air, haze]: readonly [number, number]): RGB {
  return [BETA_R[0] * air + BETA_ME * haze, BETA_R[1] * air + BETA_ME * haze, BETA_R[2] * air + BETA_ME * haze];
}

/** Fraction of a Sun-sized disc in direction s that is above the Earth's limb, seen from p (solar_visibility.py). */
export function discVisible(p: Vec3, s: Vec3): number {
  const r = length(p);
  const altitude = Math.asin(Math.min(1, Math.max(-1, dot(p, s) / r)));
  const dip = Math.acos(Math.min(1, 1 / r));
  const u = Math.min(1, Math.max(-1, (altitude + dip) / SUN_RADIUS));
  return 0.5 + (Math.asin(u) + u * Math.sqrt(1 - u * u)) / Math.PI;
}

/**
 * Light from direction s reaching p, reddened by the air on its way and cut off by the planet, relative to the same
 * light from straight overhead at p. An object's paint is its colour under a high Sun, so only the extra air of a
 * low one is applied, as the ground's shading does: a craft on the ground gets exactly the ground's light.
 */
export function lightThroughAir(p: Vec3, s: Vec3): RGB {
  const visible = discVisible(p, s);
  if (visible <= 0) return [0, 0, 0];
  const tau = extinction(columnToLight(p, s));
  const r = length(p);
  const zenith = extinction(columnUp(p, [p[0] / r, p[1] / r, p[2] / r]));
  return [0, 1, 2].map((i) => Math.min(1, Math.exp(zenith[i]! - tau[i]!)) * visible) as RGB;
}

/**
 * Air and haze between two heights straight up at a place (radii r0 < r1): the share of light that crosses it
 * vertically.
 */
export function verticalTransmittance(r0: number, r1: number): RGB {
  const lo = columnUp([0, r0, 0], [0, 1, 0]);
  const hi = columnUp([0, r1, 0], [0, 1, 0]);
  const tau = extinction([Math.max(0, lo[0] - hi[0]), Math.max(0, lo[1] - hi[1])]);
  return tau.map((t) => Math.exp(-t)) as RGB;
}

/** E₃(x) = ∫₀¹ μ e^(−x/μ) dμ: half the share of an even (diffuse) light that crosses a layer of optical depth x unscattered. */
function expIntegral3(x: number): number {
  const n = 400;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const mu = (i + 0.5) / n;
    sum += mu * Math.exp(-x / mu);
  }
  return sum / n;
}

/**
 * The share of a lit surface's light that the clear air above radius r sends back down onto it (the column's
 * spherical albedo), by colour. Single scattering of an even upward light: the share that meets the air,
 * 1 − 2E₃(τ), times the share that is turned back down, half for air and HAZE_BACKSCATTER for haze. Above the cloud
 * deck it is about (0.03, 0.06, 0.13).
 */
export function airAboveAlbedo(r: number): RGB {
  const [air, haze] = columnUp([0, r, 0], [0, 1, 0]);
  return BETA_R.map((b) => {
    const tau = b * air + BETA_ME * haze;
    return (1 - 2 * expIntegral3(tau)) * (0.5 * b * air + HAZE_BACKSCATTER * BETA_M * haze) / tau;
  }) as RGB;
}

const airPhase = (c: number) => (3 / (16 * Math.PI)) * (1 + c * c);
function hazePhase(c: number): number {
  const g = 0.76;
  return (1 - g * g) / (4 * Math.PI * Math.max(1 + g * g - 2 * g * c, 1e-4) ** 1.5);
}

/** Rings of zenith angle and azimuths (over half the sky: it is symmetric about the Sun's vertical plane), and steps along each ray. */
const SKY_RINGS = 5;
const SKY_AZIMUTHS = 6;
const SKY_STEPS = 8;

/**
 * Skylight on the ground for a Sun `elevation` radians above the horizon: the clear sky's radiance averaged over the
 * upper hemisphere with a cosine weight, which is what a white surface facing straight up reads (scene units, a
 * white surface facing the Sun reads 1). Single scattering by air and haze with the atmosphere's constants and phase
 * functions, sunlight reddened along its own path and cut off by the planet, plus the atmosphere's bounded secondary
 * term, so it fades through twilight as the drawn air does (Earth.tsx).
 */
function skyAt(elevation: number): RGB {
  const p: Vec3 = [0, 1, 0];
  const s: Vec3 = [Math.cos(elevation), Math.sin(elevation), 0];
  const sum: RGB = [0, 0, 0];
  for (let i = 0; i < SKY_RINGS; i++) {
    // Rings at even steps of cos², so each carries the same cosine-weighted share of the sky.
    const mu = Math.sqrt(1 - (i + 0.5) / SKY_RINGS);
    const sin = Math.sqrt(1 - mu * mu);
    for (let j = 0; j < SKY_AZIMUTHS; j++) {
      const phi = (Math.PI * (j + 0.5)) / SKY_AZIMUTHS;
      const d: Vec3 = [sin * Math.cos(phi), mu, sin * Math.sin(phi)];
      // Out to the top of the drawn air, in steps that crowd toward the ground where the air is dense.
      const b = dot(p, d);
      const far = -b + Math.sqrt(b * b - 1 + ATMOSPHERE_TOP * ATMOSPHERE_TOP);
      const c = dot(d, s);
      const phaseR = airPhase(c);
      const phaseM = hazePhase(c);
      const tau: RGB = [0, 0, 0];
      for (let k = 0; k < SKY_STEPS; k++) {
        const t0 = far * (k / SKY_STEPS) ** 2;
        const t1 = far * ((k + 1) / SKY_STEPS) ** 2;
        const t = 0.5 * (t0 + t1);
        const x: Vec3 = [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
        const r = length(x);
        const ds = t1 - t0;
        const air = Math.exp(-(r - 1) / H_R) * ds;
        const haze = Math.exp(-(r - 1) / H_M) * ds;
        const visible = discVisible(x, s);
        const sunTau = visible > 0 ? extinction(columnToLight(x, s)) : ([8, 8, 8] as RGB);
        const hemisphere = smoothstep(0, 1, (dot(x, s) / r + 0.18) / 0.3);
        for (const ch of [0, 1, 2] as const) {
          const segment = BETA_R[ch] * air + BETA_ME * haze;
          const viewed = Math.exp(-(tau[ch] + 0.5 * segment));
          const single = Math.exp(-sunTau[ch]) * visible * (BETA_R[ch] * air * phaseR + BETA_M * haze * phaseM);
          const secondary = ((BETA_R[ch] * air + BETA_M * haze) / (4 * Math.PI)) * SECONDARY * (1 - Math.exp(-Math.min(sunTau[ch], 8))) * hemisphere;
          sum[ch] += viewed * (single + secondary);
          tau[ch] += segment;
        }
      }
    }
  }
  // Radiance is the solar irradiance above the air (π × SUN_ABOVE_AIR in these units) × the integral; the average
  // over the rays is E/π.
  const n = SKY_RINGS * SKY_AZIMUTHS;
  return sum.map((v, i) => (Math.PI * SUN_ABOVE_AIR[i]! * v) / n) as RGB;
}

/** Skylight is worked out at these steps of solar elevation and interpolated between them. */
const SKY_STEP = 0.5 * (Math.PI / 180);
const skyCache = new Map<number, RGB>();
function skyEntry(k: number): RGB {
  let v = skyCache.get(k);
  if (!v) {
    v = skyAt(k * SKY_STEP);
    skyCache.set(k, v);
  }
  return v;
}

/**
 * Clear skylight on the ground for a Sun `elevation` radians above the horizon (see skyAt): about (0.021, 0.043,
 * 0.086) by day, warmer and dimmer through twilight, and gone 12° after sunset. Interpolated from values cached at
 * half-degree steps (about 0.6 ms each, at most two new ones a frame), so it costs nothing after the first frames and never depends on which frames came before.
 */
export function clearSkyLight(elevation: number): RGB {
  const e = Math.max(-20 * (Math.PI / 180), Math.min(Math.PI / 2, elevation));
  const k = Math.floor(e / SKY_STEP);
  const f = e / SKY_STEP - k;
  const a = skyEntry(k);
  const b = skyEntry(k + 1);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

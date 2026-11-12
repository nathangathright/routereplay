/**
 * Light shared by the globe's shaders: the Sun, the Moon, and city lights, ported from the offline renderer
 * (routereplay moonlighting.py, citylight_model.py, citypopulations.py, nightlighting.py, atmosphere.py).
 *
 * Units are scene-linear radiance in which a white surface facing the full Sun reads 1. The renderer's
 * tone mapping (Reinhard, with exposure from the timeline) turns them into display values.
 */
import * as THREE from 'three';
import { EARTH_RADIUS_KM } from '../../shared/geo/greatCircle';
import { moonPosition, sunDirection } from '../../shared/geo/solar';
import { type Vec3, dot, latLonToVec, length, normalize, scale, sub } from '../../shared/geo/vec';

/** Top of the drawn air (Earth radii): density there is e^-8 of the ground's, invisible even along the limb. */
export const ATMOSPHERE_TOP = 1.072;

/** Moonlight relative to sunlight at full Moon and mean distance: the real 2.5 × 10⁻⁶, raised 4000× to be seen. */
const FULL_MOON = 2.5e-6 * 4000;
const MEAN_MOON_KM = 384_400;

/**
 * Relative brightness of the Moon at a phase angle (radians, 0 full, π new): the Krisciunas & Schaefer (1991)
 * V-band curve, tapered to zero over the last 30° as the offline renderer does (no earthshine).
 */
export function moonPhaseBrightness(phaseAngle: number): number {
  const deg = (phaseAngle * 180) / Math.PI;
  const value = 10 ** (-0.4 * (0.026 * deg + 4e-9 * deg ** 4));
  const taper = Math.min(1, Math.max(0, (180 - deg) / 30));
  return value * taper * taper * (3 - 2 * taper);
}

export interface SkyLights {
  /** Unit vector toward the Sun, Earth frame. */
  sun: Vec3;
  /** How fast `sun` turns, per second. */
  sunRate: Vec3;
  /** Unit vector toward the Moon from the Earth's centre, Earth frame. */
  moon: Vec3;
  /** Moonlight above the air, as a fraction of full sunlight (phase and distance included). */
  moonlight: number;
  /** Hours since 00:00 UTC. */
  utcHours: number;
}

export function skyLights(utcMs: number): SkyLights {
  const sun = sunDirection(utcMs);
  const later = sunDirection(utcMs + 60_000);
  const earlier = sunDirection(utcMs - 60_000);
  const moonAt = moonPosition(utcMs);
  const moon = normalize(moonAt);
  // The phase angle is the Sun–Moon–Earth angle; the Sun is far enough to treat as a direction.
  const phase = Math.acos(Math.min(1, Math.max(-1, dot(scale(moon, -1), sun))));
  const distanceKm = length(moonAt) * EARTH_RADIUS_KM;
  return {
    sun,
    sunRate: scale(sub(later, earlier), 1 / 120),
    moon,
    moonlight: FULL_MOON * moonPhaseBrightness(phase) * (MEAN_MOON_KM / distanceKm) ** 2,
    utcHours: (((utcMs / 3_600_000) % 24) + 24) % 24,
  };
}

/** Uniforms for AIR_GLSL and CITY_GLSL; keep them current with setLightUniforms. */
export function lightUniforms(): Record<string, THREE.IUniform> {
  return {
    sunDir: { value: new THREE.Vector3(1, 0, 0) },
    sunRate: { value: new THREE.Vector3() },
    moonDir: { value: new THREE.Vector3(-1, 0, 0) },
    moonlight: { value: 0 },
    utcHours: { value: 0 },
  };
}

export function setLightUniforms(u: Record<string, THREE.IUniform>, l: SkyLights): void {
  (u.sunDir!.value as THREE.Vector3).set(...l.sun);
  (u.sunRate!.value as THREE.Vector3).set(...l.sunRate);
  (u.moonDir!.value as THREE.Vector3).set(...l.moon);
  u.moonlight!.value = l.moonlight;
  u.utcHours!.value = l.utcHours;
}

/** The uniforms from lightUniforms(), declared once per shader. */
export const LIGHT_GLSL = /* glsl */ `
uniform vec3 sunDir;
uniform vec3 sunRate;
uniform vec3 moonDir;
uniform float moonlight;
uniform float utcHours;
`;

const f = (x: number, digits = 6) => x.toFixed(digits);
const v3 = (v: readonly number[], digits = 6) => `vec3(${v.map((x) => f(x, digits)).join(', ')})`;

/**
 * Air optics (routereplay atmosphere.py constants): heights spread 7.2× with extinction divided by 7.2, so
 * vertical optical depth stays physical. Lengths in Earth radii, in the Earth's own frame. Each column of
 * air is exact from the Chapman function, so a handful of evaluations per pixel suffice.
 */
export const AIR_GLSL = /* glsl */ `
const float PI = 3.14159265;
const float TOP = ${f(ATMOSPHERE_TOP, 4)};
const float H_R = ${f((8.0 * 7.2) / 6371.0, 7)};   // 57.6 km
const float H_M = ${f((1.2 * 7.2) / 6371.0, 7)};   // 8.64 km
const vec3 BETA_R = vec3(0.0058, 0.0135, 0.0331) * ${f(6371.0 / 7.2, 4)};
const float BETA_M = 0.0030 * ${f(6371.0 / 7.2, 4)};
const float BETA_ME = BETA_M / 0.9;
const float SUN_RADIUS = ${f(((0.533 / 2) * Math.PI) / 180)};

// Near and far distances along a ray to a sphere at the origin; y < x when it misses.
vec2 sphere(vec3 o, vec3 d, float r) {
  float b = dot(o, d);
  float c = dot(o, o) - r * r;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(1.0, -1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

// Chapman grazing-incidence function for x = r/H and zenith cosine mu >= 0 (within about 5 %).
float chapman(float x, float mu) {
  float y = sqrt(0.5 * x) * mu;
  return sqrt(2.0 * x) / (y + sqrt(y * y + 1.2732395));
}

// Columns of air (x) and haze (y) from p toward d (pointing up, or level) out to space.
vec2 columnUp(vec3 p, vec3 d) {
  float r = length(p);
  float mu = max(dot(p, d) / r, 0.0);
  float h = max(r - 1.0, -0.0005);
  return vec2(chapman(r / H_R, mu) * exp(-h / H_R) * H_R, chapman(r / H_M, mu) * exp(-h / H_M) * H_M);
}

// Columns from p toward the light s, which may point below p's horizontal but clears the planet.
vec2 columnToLight(vec3 p, vec3 s) {
  float along = dot(p, s);
  if (along >= 0.0) return columnUp(p, s);
  // Past the lowest point: the whole path through it, less the part behind p.
  vec3 low = p - s * along;
  return 2.0 * columnUp(low, s) - columnUp(p, -s);
}

// Fraction of a sun-sized disc above the Earth's limb seen from p (routereplay solar_visibility.py).
float discVisible(vec3 p, vec3 s) {
  float r = length(p);
  float altitude = asin(clamp(dot(p, s) / r, -1.0, 1.0));
  float dip = acos(clamp(1.0 / r, -1.0, 1.0));
  float u = clamp((altitude + dip) / SUN_RADIUS, -1.0, 1.0);
  return 0.5 + (asin(u) + u * sqrt(1.0 - u * u)) / PI;
}

vec3 extinction(vec2 col) {
  return BETA_R * col.x + BETA_ME * col.y;
}

// Light from direction s reaching p: reddened by the air on its way and cut off by the planet.
vec3 lightThroughAir(vec3 p, vec3 s) {
  float visible = discVisible(p, s);
  if (visible <= 0.0) return vec3(0.0);
  return exp(-extinction(columnToLight(p, s))) * visible;
}

// The same at the ground, relative to the Sun overhead: the surface maps already show surface colour under a
// high Sun, so only the extra air of a low Sun is applied.
vec3 groundLight(vec3 g, vec3 s) {
  return min(lightThroughAir(g, s) * exp(BETA_R * H_R + BETA_ME * H_M), vec3(1.0));
}
`;

// City lights ------------------------------------------------------------------------------------------

/** Lamp colours: blackbody chromaticities in linear sRGB, scaled to unit luminance (our derivation). */
const LAMP = {
  sodium: [2.4778, 0.6597, 0.019], // ~2000 K, high-pressure sodium
  warm: [1.7548, 0.8492, 0.2711], // 3000 K LED
  neutral: [1.4061, 0.9265, 0.5326], // 4000 K LED
  cool: [1.2094, 0.9618, 0.7616], // 5000 K LED and signs
};

/**
 * Broad regional priors from the offline renderer (routereplay citypopulations.py): centre, width, shares of
 * light from street lights, buildings, signs and always-on sources, the street-light mix (sodium, warm,
 * neutral), and the local mean solar hour buildings and signs go dark. Overlapping soft weights, not borders.
 */
const REGIONS: [lat: number, lon: number, width: number, shares: number[], mix: number[], building: number, sign: number][] = [
  [40, -100, 29, [0.5, 0.29, 0.12, 0.09], [0.25, 0.43, 0.32], 23.5, 1.0],
  [50, 15, 24, [0.53, 0.28, 0.1, 0.09], [0.31, 0.42, 0.27], 23.0, 0.0],
  [34, 120, 25, [0.43, 0.33, 0.16, 0.08], [0.18, 0.36, 0.46], 0.0, 1.5],
  [20, 78, 23, [0.49, 0.28, 0.14, 0.09], [0.35, 0.4, 0.25], 0.0, 1.0],
  [2, 21, 32, [0.57, 0.25, 0.09, 0.09], [0.4, 0.38, 0.22], 23.0, 0.0],
  [-18, -59, 30, [0.53, 0.27, 0.11, 0.09], [0.36, 0.4, 0.24], 0.5, 1.0],
  [-27, 140, 25, [0.53, 0.28, 0.1, 0.09], [0.25, 0.44, 0.31], 23.0, 0.0],
];
const hourAfterNoon = (h: number) => (h >= 12 ? h : h + 24);

/** Clear-sky illuminance on the ground by solar altitude (Hulburt's measurements at 0° to −9°, extended). */
const SKY_ALTITUDE = [-90, -18, -12, -9, -6, -3, 0, 6, 15, 45, 90];
const SKY_LUX = [0.0001, 0.0001, 0.001, 0.054, 1.35, 43, 430, 8000, 25000, 80000, 120000];

/** Brightest city light, in scene units (routereplay nightlighting.py EMISSION_LUMINANCE). */
const CITY_EMISSION = 0.45;

const glslArray = (type: string, items: string[]) => `${type}[${items.length}](${items.join(', ')})`;

/**
 * cityLights(n, texel): light from cities at the ground point n (unit vector, Earth frame), given the night
 * map's texel there. The map gives only where lights are and how bright; the model decides their colour,
 * when they switch on at dusk (later) and off at dawn, and how buildings and signs go dark late at night.
 * Needs LIGHT_GLSL first.
 */
export const CITY_GLSL = /* glsl */ `
const vec3 SODIUM = ${v3(LAMP.sodium, 4)};
const vec3 WARM = ${v3(LAMP.warm, 4)};
const vec3 NEUTRAL = ${v3(LAMP.neutral, 4)};
const vec3 COOL = ${v3(LAMP.cool, 4)};
const vec3 REGION_CENTRE[${REGIONS.length}] = ${glslArray('vec3', REGIONS.map(([lat, lon]) => v3(latLonToVec(lat, lon))))};
const float REGION_SHARPNESS[${REGIONS.length}] = ${glslArray('float', REGIONS.map(([, , w]) => f(1 / (1 - Math.cos((w * Math.PI) / 180)), 4)))};
const vec4 REGION_SHARES[${REGIONS.length}] = ${glslArray('vec4', REGIONS.map(([, , , s]) => `vec4(${s.map((x) => f(x, 3)).join(', ')})`))};
const vec3 REGION_MIX[${REGIONS.length}] = ${glslArray('vec3', REGIONS.map(([, , , , m]) => v3(m, 3)))};
const vec2 REGION_CURFEW[${REGIONS.length}] = ${glslArray('vec2', REGIONS.map(([, , , , , b, s]) => `vec2(${f(hourAfterNoon(b), 2)}, ${f(hourAfterNoon(s), 2)})`))};
const float SKY_ALTITUDE[${SKY_ALTITUDE.length}] = ${glslArray('float', SKY_ALTITUDE.map((x) => f(x, 1)))};
const float SKY_LOG_LUX[${SKY_LUX.length}] = ${glslArray('float', SKY_LUX.map((x) => f(Math.log10(x), 5)))};
const float LN10 = 2.302585;

// A smooth value-noise field over the globe with cells of scaleKm, identical to routereplay's
// geographic_noise (same lattice, hash, and seeds) so lamps vary in the same places.
float geoNoise(vec3 n, float scaleKm, uint seed) {
  vec3 xyz = vec3(n.x, -n.z, n.y) * (6371.0 / scaleKm);
  vec3 base = floor(xyz);
  vec3 t = xyz - base;
  vec3 fade = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  ivec3 b = ivec3(base);
  float result = 0.0;
  for (int c = 0; c < 8; c++) {
    ivec3 o = ivec3(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    uvec3 cell = uvec3(b + o);
    uint h = (cell.x * 73856093u) ^ (cell.y * 19349663u) ^ (cell.z * 83492791u) ^ seed;
    h ^= h >> 16u;
    h *= 0x7FEB352Du;
    h ^= h >> 15u;
    h *= 0x846CA68Bu;
    h ^= h >> 16u;
    vec3 w = mix(1.0 - fade, fade, vec3(o));
    result += float(h >> 8u) / 16777215.0 * w.x * w.y * w.z;
  }
  return result;
}

float skyLogLux(float altitude) {
  float v = SKY_LOG_LUX[0];
  for (int i = 0; i < ${SKY_ALTITUDE.length - 1}; i++) {
    if (altitude >= SKY_ALTITUDE[i]) {
      v = mix(SKY_LOG_LUX[i], SKY_LOG_LUX[i + 1], clamp((altitude - SKY_ALTITUDE[i]) / (SKY_ALTITUDE[i + 1] - SKY_ALTITUDE[i]), 0.0, 1.0));
    }
  }
  return v;
}

float wrapHours(float h) { return mod(h + 12.0, 24.0) - 12.0; }
float occupied(float hour, float start, float end, float width) {
  float distance = abs(wrapHours(hour - 0.5 * (start + end)));
  return 1.0 / (1.0 + exp(-((end - start) * 0.5 - distance) / width));
}

vec3 cityLights(vec3 n, vec3 texel) {
  // The night map shows lights warm or white over a faint bluish moonlit land (deserts a little warmer);
  // keep only the lights.
  vec3 e = pow(max(texel, vec3(0.0)), vec3(1.0 / 2.2));
  float level = clamp((e.r - 0.55 * e.b - 0.06) / 0.39, 0.0, 1.0);
  if (level <= 0.0) return vec3(0.0);
  level = pow(level, 0.82);

  float region = geoNoise(n, 60.0, 20161017u) - 0.5;
  float district = geoNoise(n, 18.0, 20261017u) - 0.5;
  float total = 0.35;
  vec4 shares = vec4(0.50, 0.29, 0.11, 0.10) * 0.35;
  vec3 lampMix = vec3(0.30, 0.42, 0.28) * 0.35;
  vec2 curfew = vec2(24.0, 25.0) * 0.35;
  for (int i = 0; i < ${REGIONS.length}; i++) {
    float w = exp((dot(n, REGION_CENTRE[i]) - 1.0) * REGION_SHARPNESS[i]);
    shares += w * REGION_SHARES[i];
    lampMix += w * REGION_MIX[i];
    curfew += w * REGION_CURFEW[i];
    total += w;
  }
  shares /= total;
  lampMix /= total;
  curfew /= total;
  shares.xy += vec2(0.06, -0.06) * district;
  lampMix.xz += vec2(0.12, -0.12) * region;

  // Switching: street lights come on as the sky darkens past about 16 lux and go off at dawn at about three
  // times that; building lights follow 100 lux. Thresholds vary from place to place.
  float mu = dot(n, sunDir);
  float logLux = skyLogLux(degrees(asin(clamp(mu, -1.0, 1.0))));
  float rising = degrees(dot(n, sunRate) / sqrt(max(1.0 - mu * mu, 1e-8))) * 3600.0; // degrees per hour
  float dawn = 0.5 + 0.5 * tanh(rising / 1.5);
  float onLog = log(16.1) / LN10 + 0.8 * (0.6 * region + 0.4 * district) + dawn * log(3.0) / LN10;
  float street = 1.0 / (1.0 + exp(clamp((logLux - onLog) / 0.16, -60.0, 60.0)));
  float indoors = 1.0 / (1.0 + exp(clamp((logLux - 2.0 - 0.45 * district) / 0.32, -60.0, 60.0)));

  // Schedules by local mean solar time: buildings and signs go dark late at night, streets dim a little
  // around 3 am, and offices light up again early in the morning.
  float hour = mod(utcHours + degrees(atan(-n.z, n.x)) / 15.0, 24.0);
  float building = clamp(0.12 + 0.88 * occupied(hour, 16.5, curfew.x, 0.65) + 0.33 * exp(-0.5 * pow(wrapHours(hour - 6.5) / 0.8, 2.0)), 0.0, 1.0);
  float signs = 0.08 + 0.92 * occupied(hour, 16.0, curfew.y, 0.45);
  float outdoor = 1.0 - 0.12 * exp(-0.5 * pow(wrapHours(hour - 3.0) / 1.7, 2.0));
  vec4 schedule = mix(vec4(0.979, 0.39, 0.37, 1.0), vec4(outdoor, building, signs, 1.0), 1.0 - n.y * n.y);

  // The always-on share follows daylight too (the offline renderer keeps it lit by day), so no specks of
  // city light show on sunlit ground.
  vec4 on = shares * schedule * vec4(street, indoors, indoors, indoors);
  vec3 streetColour = (lampMix.x * SODIUM + lampMix.y * WARM + lampMix.z * NEUTRAL) / (lampMix.x + lampMix.y + lampMix.z);
  vec3 rgb = (on.x + on.w) * streetColour + on.y * WARM + on.z * mix(NEUTRAL, COOL, 0.5);
  return ${f(CITY_EMISSION, 3)} * level * rgb;
}
`;

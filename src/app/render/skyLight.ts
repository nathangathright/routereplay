/**
 * Light from the clear sky above a cloud layer, from the same air the atmosphere draws (AIR_GLSL in lighting.ts:
 * the offline renderer's Rayleigh and Mie constants, heights spread 7.2×, exact Chapman columns, and its bounded
 * secondary scattering). The offline renderer samples its atmosphere the same way (routereplay cloudlighting.py):
 * radiance toward the zenith and at 45° toward and away from the Sun's bearing, by solar elevation.
 *
 * The table is computed once, in JavaScript, and uploaded as a small half-float texture: one row per direction
 * and cloud layer, one column per solar elevation. Units are those of the atmosphere, where a white surface facing
 * the full Sun above the air reads 1; skyLight() puts them in the ground's (SUN_ABOVE_AIR). Everything is a function
 * of the constants below, so every device builds the same table.
 */
import * as THREE from 'three';

type V = [number, number, number];

/** Air optics, as in AIR_GLSL (lengths in Earth radii). tests/skyLight.test.ts checks that the two agree. */
const SPREAD = 7.2;
const H_R = (8.0 * SPREAD) / 6371.0;
const H_M = (1.2 * SPREAD) / 6371.0;
const BETA_R: V = [(0.0058 * 6371.0) / SPREAD, (0.0135 * 6371.0) / SPREAD, (0.0331 * 6371.0) / SPREAD];
const BETA_M = (0.003 * 6371.0) / SPREAD;
const BETA_ME = BETA_M / 0.9;
const TOP = 1.072;
const SUN_RADIUS = ((0.533 / 2) * Math.PI) / 180;
/** Sunlight above the air, as an irradiance; the shader puts it in the ground's units (SUN_ABOVE_AIR in AIR_GLSL). */
const SOLAR_RADIANCE = Math.PI;
const SECONDARY = 0.38 / (1 - 0.38);
export const SKY_AIR = { H_R, H_M, BETA_R, BETA_M, TOP } as const;

/** Columns of the table: sin(solar elevation) from SKY_MU0 (about −17°) to 1, evenly, so finest near the horizon. */
export const SKY_MU0 = -0.3;
export const SKY_COLUMNS = 64;
/** Rows per cloud layer: zenith, 45° toward the Sun's bearing, 45° away from it. */
export const SKY_DIRECTIONS = 3;

const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V, b: V, k = 1): V => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const len = (a: V) => Math.sqrt(dot(a, a));
const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function chapman(x: number, mu: number): number {
  const y = Math.sqrt(0.5 * x) * mu;
  return Math.sqrt(2 * x) / (y + Math.sqrt(y * y + 1.2732395));
}

/** Columns of air and haze from p toward d (pointing up, or level) out to space. */
function columnUp(p: V, d: V): [number, number] {
  const r = len(p);
  const mu = Math.max(dot(p, d) / r, 0);
  const h = Math.max(r - 1, -0.0005);
  return [chapman(r / H_R, mu) * Math.exp(-h / H_R) * H_R, chapman(r / H_M, mu) * Math.exp(-h / H_M) * H_M];
}

/** Columns from p toward the light s, which may point below p's horizontal but clears the planet. */
function columnToLight(p: V, s: V): [number, number] {
  const along = dot(p, s);
  if (along >= 0) return columnUp(p, s);
  const low = add(p, s, -along);
  const a = columnUp(low, s);
  const b = columnUp(p, [-s[0], -s[1], -s[2]]);
  return [2 * a[0] - b[0], 2 * a[1] - b[1]];
}

function discVisible(p: V, s: V): number {
  const r = len(p);
  const altitude = Math.asin(clamp(dot(p, s) / r, -1, 1));
  const dip = Math.acos(clamp(1 / r, -1, 1));
  const u = clamp((altitude + dip) / SUN_RADIUS, -1, 1);
  return 0.5 + (Math.asin(u) + u * Math.sqrt(1 - u * u)) / Math.PI;
}

const extinction = (col: [number, number]): V => [
  BETA_R[0] * col[0] + BETA_ME * col[1],
  BETA_R[1] * col[0] + BETA_ME * col[1],
  BETA_R[2] * col[0] + BETA_ME * col[1],
];
const airPhase = (c: number) => (3 / (16 * Math.PI)) * (1 + c * c);
function hazePhase(c: number): number {
  const g = 0.76;
  return (1 - g * g) / (4 * Math.PI * Math.max(1 + g * g - 2 * g * c, 1e-4) ** 1.5);
}

/**
 * Sky radiance arriving at p from direction d (pointing up), with the Sun toward s: the atmosphere shader's
 * single and secondary scattering along the ray from p to the top of the air, in 96 segments spaced finely
 * near p where the air is densest. Each segment's optical depth is exact (a difference of two columns).
 */
export function skyRadiance(p: V, d: V, s: V): V {
  // The ray rises from p (d points up), so it leaves through the top of the air.
  const b = dot(p, d);
  const far = -b + Math.sqrt(b * b - (dot(p, p) - TOP * TOP));
  const c = dot(d, s);
  const phaseR = airPhase(c);
  const phaseM = hazePhase(c);
  const light: V = [0, 0, 0];
  const tau: V = [0, 0, 0];
  const steps = 96;
  const at = (i: number) => far * (Math.expm1((4 * i) / steps) / Math.expm1(4));
  for (let i = 0; i < steps; i++) {
    const ta = at(i);
    const tb = at(i + 1);
    const pa = add(p, d, ta);
    const pb = add(p, d, tb);
    const ca = columnUp(pa, d);
    const cb = columnUp(pb, d);
    const col: [number, number] = [Math.max(ca[0] - cb[0], 0), Math.max(ca[1] - cb[1], 0)];
    const segment = extinction(col);
    const pm = add(p, d, 0.5 * (ta + tb));
    const visible = discVisible(pm, s);
    const sunTau: V = visible > 0 ? extinction(columnToLight(pm, s)) : [8, 8, 8];
    const cosine = dot(pm, s) / len(pm);
    const hemisphere = smooth(clamp((cosine + 0.18) / 0.3, 0, 1));
    for (const k of [0, 1, 2] as const) {
      const viewed = Math.exp(-(tau[k] + 0.5 * segment[k]));
      const sun = Math.exp(-sunTau[k]) * visible;
      const single = sun * (BETA_R[k] * col[0] * phaseR + BETA_M * col[1] * phaseM);
      const secondary = ((BETA_R[k] * col[0] + BETA_M * col[1]) / (4 * Math.PI)) * SECONDARY * (1 - Math.exp(-Math.min(sunTau[k], 8))) * hemisphere;
      light[k] += viewed * (single + secondary);
      tau[k] += segment[k];
    }
  }
  return [light[0] * SOLAR_RADIANCE, light[1] * SOLAR_RADIANCE, light[2] * SOLAR_RADIANCE];
}

/**
 * The table for cloud layers at the given radii (Earth radii): for each layer, rows of zenith, toward-Sun and
 * away-from-Sun radiance (RGB, A unused), with columns at sin(solar elevation) = SKY_MU0 … 1.
 */
export function skyTable(radii: readonly number[]): Float32Array {
  const data = new Float32Array(SKY_COLUMNS * SKY_DIRECTIONS * radii.length * 4);
  const h = Math.SQRT1_2;
  const directions: V[] = [
    [0, 1, 0],
    [h, h, 0],
    [-h, h, 0],
  ];
  radii.forEach((radius, layer) => {
    const p: V = [0, radius, 0];
    for (let i = 0; i < SKY_COLUMNS; i++) {
      const mu = SKY_MU0 + ((1 - SKY_MU0) * i) / (SKY_COLUMNS - 1);
      const s: V = [Math.sqrt(Math.max(0, 1 - mu * mu)), mu, 0];
      directions.forEach((d, row) => {
        const rgb = skyRadiance(p, d, s);
        const o = (((layer * SKY_DIRECTIONS + row) * SKY_COLUMNS) + i) * 4;
        data.set([rgb[0], rgb[1], rgb[2], 1], o);
      });
    }
  });
  return data;
}

const textures = new Map<string, THREE.DataTexture>();

/** The table as a half-float texture (linear filtering of half floats is core in WebGL 2). Built once per set of radii. */
export function skyTexture(radii: readonly number[]): THREE.DataTexture {
  const key = radii.join(',');
  let t = textures.get(key);
  if (!t) {
    const values = skyTable(radii);
    const half = new Uint16Array(values.length);
    for (let i = 0; i < values.length; i++) half[i] = THREE.DataUtils.toHalfFloat(values[i]!);
    t = new THREE.DataTexture(half, SKY_COLUMNS, SKY_DIRECTIONS * radii.length, THREE.RGBAFormat, THREE.HalfFloatType);
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    textures.set(key, t);
  }
  return t;
}

/**
 * skyLight(n, s, layer, N, k): sky light on a cloud top at the unit vector n, in layer `layer` of the table, with
 * its tilted normal N and the slope shading k, as for the Sun (see Clouds.tsx deckLight): each of the three sky
 * directions brightens slopes facing it and dims those turned away. `thinning` (0–1 per direction) is how much of
 * each direction's light the cloud lets reach the layer where it scatters. The light is in the ground's units
 * (SUN_ABOVE_AIR). Needs a sampler2D named skyTable, and AIR_GLSL first.
 */
export function skyLightGlsl(layers: number): string {
  return /* glsl */ `
uniform sampler2D skyTable;
vec3 skyTexel(float mu, float row) {
  float u = clamp((mu - ${SKY_MU0.toFixed(4)}) / ${(1 - SKY_MU0).toFixed(4)}, 0.0, 1.0);
  return texture(skyTable, vec2((u * ${(SKY_COLUMNS - 1).toFixed(1)} + 0.5) / ${SKY_COLUMNS.toFixed(1)}, (row + 0.5) / ${(SKY_DIRECTIONS * layers).toFixed(1)})).rgb;
}

// The three sky directions at n for a light toward s: up, and 45° up toward and away from the light's bearing.
// Where the bearing is undefined (light near the zenith or nadir), the side directions and their light fold into
// the zenith's over the last 8.6°, as in the offline renderer.
void skyDirections(vec3 n, vec3 s, out vec3 toward, out vec3 away, out float fold) {
  vec3 t = s - n * dot(n, s);
  float l = length(t);
  fold = smoothstep(0.0, 0.15, l);
  t *= fold / max(l, 1e-6);
  toward = normalize(n + t);
  away = normalize(n - t);
}

vec3 skyLight(vec3 n, vec3 s, float layer, vec3 N, float k, vec3 thinning) {
  vec3 toward;
  vec3 away;
  float fold;
  skyDirections(n, s, toward, away, fold);
  float mu = dot(n, s);
  float row = layer * ${SKY_DIRECTIONS.toFixed(1)};
  vec3 zenith = skyTexel(mu, row);
  vec3 side1 = mix(zenith, skyTexel(mu, row + 1.0), fold);
  vec3 side2 = mix(zenith, skyTexel(mu, row + 2.0), fold);
  float rise = dot(N, n) - 1.0;
  float facing1 = exp(k * (dot(N, toward) - dot(n, toward)));
  float facing2 = exp(k * (dot(N, away) - dot(n, away)));
  // Cosine weights of equal solid angles (1 at the zenith, 0.707 at 45°), so an even sky L gives a level top L.
  vec3 sky = (zenith * exp(k * rise) * thinning.x + 0.7071 * (side1 * facing1 * thinning.y + side2 * facing2 * thinning.z)) / 2.4142;
  return sky * SUN_ABOVE_AIR;
}
`;
}

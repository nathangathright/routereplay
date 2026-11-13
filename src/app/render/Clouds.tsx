import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { NormalizedSceneV1 } from '../../shared/scene/types';
import { CLOUD_GRID, type CloudField, cloudBlendAt, cloudFieldsFor } from '../../shared/weather/gfs';
import { decodeGrib2 } from '../../shared/weather/grib2';
import { HOLD_MINUTES } from '../../shared/scene/constants';
import { AIR_GLSL, CITY_GLSL, LIGHT_GLSL, type SkyLights, lightUniforms, setLightUniforms } from './lighting';
import { PLANE_SHADOW_GLSL, type ShadowCaster, planeShadowUniforms, setPlaneShadowUniforms } from './planeShadow';
import { mulberry32 } from './Stars';

/** Cloud tops sit this far out (Earth radii): exaggerated about 10× so they read above the ground at globe scale. */
export const CLOUD_RADIUS = 1.004;
/** How bright a sunlit deck is, in scene units (a white surface facing the Sun reads 1): clouds outshine the ground. */
const CLOUD_BRIGHTNESS = 2.4;
/** Opacity per kg/m² of cloud water: about 37 % of the globe then looks solid, as it does from space. */
const OPACITY_PER_KG = 30;
/** Wind is stored in 8 bits per component at this many m/s per step (±77 m/s). */
const WIND_STEP = 0.6;
/** Clouds are carried by the wind for at most this long from each field (routereplay caps wind history at 4 h). */
const MAX_ADVECTION_S = 3 * 3600;
/** The procedural detail is carried by the wind and renewed on this cycle, so it never stretches out. */
const DETAIL_PERIOD_S = 3 * 3600;
/**
 * Cloud-top relief for lighting only (the shell stays a sphere): tops rise this many Earth radii per unit of
 * cloud thickness (cloud water × billow noise), about 320 km. Like the shell's height, it is exaggerated far
 * beyond real cloud tops so billows read at globe scale.
 */
const CLOUD_RELIEF = 0.05;
/** Steepest cloud-top slope (rise over run), so the steepest billows in thick cloud never turn edge-on. */
const MAX_CLOUD_SLOPE = 1.5;
/**
 * How strongly a billow's slope brightens or dims it: light × e^(k (N·l − n·l)), N the tilted normal and n the
 * shell's. For a tilt θ toward the light that is about e^(k θ cos(elevation)), strongest at sunrise and sunset.
 */
const CLOUD_SHADING = 2.5;

/** One model time step: cloud opacity (R) and the 700 hPa wind (RG, east and north), both on the 1° grid. */
export interface WeatherStep {
  cloud: THREE.DataTexture;
  wind: THREE.DataTexture;
}

function gridTexture(data: Uint8Array, format: THREE.PixelFormat): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, CLOUD_GRID.nx, CLOUD_GRID.ny, format, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

const stepCache = new Map<string, Promise<WeatherStep | null>>();

/**
 * The cloud water and wind for one model time step, as textures (rows from 90°N to 90°S, columns from 0°
 * eastward). Resolves to null when the fields aren't available, so the scene draws without them.
 */
export function loadWeatherStep(field: CloudField): Promise<WeatherStep | null> {
  const key = `${field.cycle}/${field.hour}`;
  let p = stepCache.get(key);
  if (!p) {
    p = fetch(`/api/v1/weather/gfs/${key}`)
      .then(async (res) => {
        if (!res.ok) return null;
        const fields = decodeGrib2(new Uint8Array(await res.arrayBuffer()));
        // GRIB2 parameters: cloud water is meteorological 6/6, wind east 2/2 and north 2/3.
        const find = (category: number, parameter: number) =>
          fields.find((f) => f.discipline === 0 && f.category === category && f.parameter === parameter && f.nx === CLOUD_GRID.nx && f.ny === CLOUD_GRID.ny);
        const water = find(6, 6);
        const u = find(2, 2);
        const v = find(2, 3);
        if (!water || !u || !v) return null;
        const n = CLOUD_GRID.nx * CLOUD_GRID.ny;
        const cloud = new Uint8Array(n);
        const wind = new Uint8Array(n * 2);
        const quantize = (x: number) => Math.min(255, Math.max(0, Math.round(128 + (Number.isFinite(x) ? x : 0) / WIND_STEP)));
        for (let i = 0; i < n; i++) {
          const w = water.values[i]!;
          cloud[i] = Number.isFinite(w) ? Math.round(255 * (1 - Math.exp(-OPACITY_PER_KG * Math.max(0, w)))) : 0;
          wind[2 * i] = quantize(u.values[i]!);
          wind[2 * i + 1] = quantize(v.values[i]!);
        }
        return { cloud: gridTexture(cloud, THREE.RedFormat), wind: gridTexture(wind, THREE.RGFormat) };
      })
      .catch(() => null);
    // A missing step may be published later; only keep successes.
    p.then((s) => s ?? stepCache.delete(key));
    stepCache.set(key, p);
  }
  return p;
}

/**
 * Free a step's GPU textures once nothing will draw it again. The homepage's clock never stops, so it lets
 * go of each step it has passed; journeys keep theirs for replay.
 */
export function releaseWeatherStep(field: CloudField): void {
  const key = `${field.cycle}/${field.hour}`;
  const p = stepCache.get(key);
  stepCache.delete(key);
  void p?.then((s) => {
    s?.cloud.dispose();
    s?.wind.dispose();
  });
}

let noise: THREE.Data3DTexture | null = null;

/** Lattice points along each side of the noise texture. */
const NOISE_SIZE = 32;

/**
 * Seeded value noise on a 32³ lattice that tiles; trilinear filtering smooths it. Same on every device. R holds
 * the noise; G, B, and A its gradient along x, y, and z, so the cloud shader shapes billow tops without reading
 * the noise again. The gradient is a central difference smoothed across the other two axes (a 3D Sobel filter,
 * in noise units per lattice step, 128 = flat): plain differences turn the lattice's cells into facets under a
 * low Sun.
 */
function noiseTexture(): THREE.Data3DTexture {
  if (!noise) {
    const size = NOISE_SIZE;
    const rand = mulberry32(0xc10d);
    const value = new Uint8Array(size * size * size).map(() => Math.floor(rand() * 256));
    const at = (x: number, y: number, z: number) => value[(((z + size) % size) * size + ((y + size) % size)) * size + ((x + size) % size)]!;
    const weight = [0.25, 0.5, 0.25];
    // Along `step` (one lattice step) at x, y, z: (ahead − behind) / 2, averaged [1, 2, 1] / 4 along u and v.
    type Step = [number, number, number];
    const slope = (x: number, y: number, z: number, [sx, sy, sz]: Step, [ux, uy, uz]: Step, [vx, vy, vz]: Step) => {
      let sum = 0;
      for (let j = -1; j <= 1; j++) {
        for (let k = -1; k <= 1; k++) {
          const [cx, cy, cz] = [x + j * ux + k * vx, y + j * uy + k * vy, z + j * uz + k * vz];
          sum += (weight[j + 1]! * weight[k + 1]! * (at(cx + sx, cy + sy, cz + sz) - at(cx - sx, cy - sy, cz - sz))) / 2;
        }
      }
      return Math.round(128 + sum * (254 / 255));
    };
    const X: Step = [1, 0, 0];
    const Y: Step = [0, 1, 0];
    const Z: Step = [0, 0, 1];
    const data = new Uint8Array(size * size * size * 4);
    for (let z = 0, i = 0; z < size; z++) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++, i++) {
          data[4 * i] = value[i]!;
          data[4 * i + 1] = slope(x, y, z, X, Y, Z);
          data[4 * i + 2] = slope(x, y, z, Y, X, Z);
          data[4 * i + 3] = slope(x, y, z, Z, X, Y);
        }
      }
    }
    noise = new THREE.Data3DTexture(data, size, size, size);
    noise.format = THREE.RGBAFormat;
    noise.wrapS = noise.wrapT = noise.wrapR = THREE.RepeatWrapping;
    noise.magFilter = noise.minFilter = THREE.LinearFilter;
    noise.needsUpdate = true;
  }
  return noise;
}

let blank: THREE.DataTexture | null = null;
/** Stand-in for missing fields: no cloud, no wind. */
function blankTexture(): THREE.DataTexture {
  if (!blank) {
    blank = new THREE.DataTexture(new Uint8Array([0, 128, 128, 255]), 1, 1, THREE.RGBAFormat);
    blank.needsUpdate = true;
  }
  return blank;
}

/**
 * Shared GLSL for anything that reads the clouds (the cloud layer and the ground's cloud shadows). Positions are
 * unit vectors in the Earth frame. Between two model times, each field is carried along its own wind: field A
 * forward from its time, field B back from its time, as in routereplay's wind-advected cloud volume.
 */
export const CLOUD_GLSL = /* glsl */ `
uniform sampler2D cloudA;
uniform sampler2D cloudB;
uniform sampler2D windA;
uniform sampler2D windB;
uniform float cloudBlend;
uniform float cloudPresence;
uniform float cloudAgeA; // seconds since field A's time (capped)
uniform float cloudAgeB; // seconds until field B's time (capped)

// The model grid: columns every 1° east from 0°, rows every 1° south from 90°N (texel centres).
vec2 gridUv(vec3 n) {
  float lat = degrees(asin(clamp(n.y, -1.0, 1.0)));
  float lon = degrees(atan(-n.z, n.x));
  return vec2(fract(lon / 360.0) + 0.5 / 360.0, (90.0 - lat + 0.5) / 181.0);
}

// Wind in m/s toward the east (x) and north (y).
vec2 windAt(sampler2D w, vec2 uv) {
  return (texture2D(w, uv).rg * 255.0 - 128.0) * ${WIND_STEP.toFixed(2)};
}

// Where air at n would be after drifting with the wind for the given seconds (negative: where it came from).
vec3 drift(vec3 n, vec2 wind, float seconds) {
  vec3 e = cross(vec3(0.0, 1.0, 0.0), n);
  float l = length(e);
  if (l < 1e-4) return n;
  vec3 east = e / l;
  vec3 north = cross(n, east);
  return normalize(n + (east * wind.x + north * wind.y) * (seconds / 6.371e6));
}

// Smooth (cubic B-spline) sampling from four bilinear taps, so the 1° grid never shows as blocks.
vec4 bspline(float t) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - t;
  vec4 c = n * n * n;
  float x = c.x;
  float y = c.y - 4.0 * c.x;
  float z = c.z - 4.0 * c.y + 6.0 * c.x;
  return vec4(x, y, z, 6.0 - x - y - z) / 6.0;
}

// The same at mip level lod, which is size texels.
vec4 cubicSample(sampler2D tex, vec2 uv, vec2 size, float lod) {
  vec2 p = uv * size - 0.5;
  vec2 f = fract(p);
  p -= f;
  vec4 wx = bspline(f.x);
  vec4 wy = bspline(f.y);
  vec4 c = p.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(wx.xz + wx.yw, wy.xz + wy.yw);
  vec4 o = (c + vec4(wx.yw, wy.yw) / s) / size.xxyy;
  vec4 a = textureLod(tex, o.xz, lod);
  vec4 b = textureLod(tex, o.yz, lod);
  vec4 d = textureLod(tex, o.xw, lod);
  vec4 e = textureLod(tex, o.yw, lod);
  float sx = s.x / (s.x + s.y);
  float sy = s.z / (s.z + s.w);
  return mix(mix(e, d, sx), mix(b, a, sx), sy);
}

float smoothSample(sampler2D tex, vec2 uv) {
  return cubicSample(tex, uv, vec2(360.0, 181.0), 0.0).r;
}

// Model cloud opacity at n, carried by the wind between the two fields. 'smoothly' picks cubic sampling.
float cloudOpacity(vec3 n, bool smoothly) {
  vec2 uv = gridUv(n);
  vec2 a = gridUv(drift(n, windAt(windA, uv), -cloudAgeA));
  vec2 b = gridUv(drift(n, windAt(windB, uv), cloudAgeB));
  float oa = smoothly ? smoothSample(cloudA, a) : texture2D(cloudA, a).r;
  float ob = smoothly ? smoothSample(cloudB, b) : texture2D(cloudB, b).r;
  return mix(oa, ob, cloudBlend) * cloudPresence;
}
`;

/** Uniforms for CLOUD_GLSL; merge them into a material's uniforms and keep them current with setCloudUniforms. */
export function cloudUniforms(): Record<string, THREE.IUniform> {
  const t = blankTexture();
  return {
    cloudA: { value: t },
    cloudB: { value: t },
    windA: { value: t },
    windB: { value: t },
    cloudBlend: { value: 0 },
    cloudPresence: { value: 0 },
    cloudAgeA: { value: 0 },
    cloudAgeB: { value: 0 },
  };
}

export function setCloudUniforms(u: Record<string, THREE.IUniform>, frame: CloudFrame | null): void {
  const t = blankTexture();
  u.cloudA!.value = frame?.a.cloud ?? t;
  u.cloudB!.value = frame?.b.cloud ?? t;
  u.windA!.value = frame?.a.wind ?? t;
  u.windB!.value = frame?.b.wind ?? t;
  u.cloudBlend!.value = frame?.blend ?? 0;
  u.cloudPresence!.value = frame?.presence ?? 0;
  u.cloudAgeA!.value = frame?.ageA ?? 0;
  u.cloudAgeB!.value = frame?.ageB ?? 0;
}

const cloudVertex = /* glsl */ `
varying vec3 vEarth;
void main() {
  vEarth = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const cloudFragment = /* glsl */ `
precision highp sampler3D;
const float CLOUD_BRIGHTNESS = ${CLOUD_BRIGHTNESS.toFixed(3)};
uniform sampler3D noise;
uniform sampler2D nightMap;
uniform vec4 detail; // x: phase of layer 1 (0–1), y: its cycle, z: cycle of layer 2 (half a period behind)
varying vec3 vEarth;
${LIGHT_GLSL}
${AIR_GLSL}
${CITY_GLSL}
${CLOUD_GLSL}
${PLANE_SHADOW_GLSL}

// The noise texture's gradient, per unit of texture coordinate.
vec3 noiseSlope(vec4 texel) {
  return (texel.gba * 255.0 - 128.0) * ${(NOISE_SIZE / 254).toFixed(6)};
}

// Two octaves of seeded noise (cells of roughly 100 km and 40 km) at a position (x), and their gradient (yzw).
vec4 billows(vec3 p) {
  vec4 a = texture(noise, p);
  vec4 b = texture(noise, p * 2.6 + 0.37);
  return vec4(0.6 * a.r + 0.4 * b.r, 0.6 * noiseSlope(a) + 1.04 * noiseSlope(b));
}

// Brightness of a cloud top with normal N on the shell at n, lit from direction l. A level deck catches light a
// little past its horizon, as volumes do. Slopes facing the light brighten it and slopes turned away dim it,
// smoothly and never to black (light scatters through the cloud), most when the light is low.
float deckLight(vec3 N, vec3 n, vec3 l) {
  float level = clamp((dot(n, l) + 0.15) / 1.15, 0.0, 1.0);
  return level * exp(${CLOUD_SHADING.toFixed(2)} * (dot(N, l) - dot(n, l)));
}

// Light reaching the deck from direction l, reddened by the air on its way. The deck has depth: its lowest
// cloud loses the light at the ground's terminator and its top a few degrees later (where the planet's limb
// hides the light from it), so the deck dims gradually instead of all at once.
vec3 deckSunlight(vec3 n, vec3 l) {
  vec3 top = n * ${CLOUD_RADIUS.toFixed(4)};
  float altitude = asin(clamp(dot(n, l), -1.0, 1.0));
  float lit = smoothstep(-${Math.acos(1 / CLOUD_RADIUS).toFixed(5)}, 0.01, altitude);
  return exp(-extinction(columnToLight(top, l))) * lit;
}

void main() {
  vec3 n = normalize(vEarth);
  // The noise detail drifts with the wind too. Two copies, half a cycle apart, each restart from a fresh
  // seed when unseen, so the texture moves without ever smearing out.
  vec2 wind = mix(windAt(windA, gridUv(n)), windAt(windB, gridUv(n)), cloudBlend);
  float phase2 = fract(detail.x + 0.5);
  vec3 seed1 = fract(vec3(0.173, 0.311, 0.457) * detail.y);
  vec3 seed2 = fract(vec3(0.173, 0.311, 0.457) * detail.z);
  vec4 b1 = billows(drift(n, wind, -detail.x * ${DETAIL_PERIOD_S.toFixed(1)}) * 2.0 + seed1);
  vec4 b2 = billows(drift(n, wind, -phase2 * ${DETAIL_PERIOD_S.toFixed(1)}) * 2.0 + seed2);
  float w1 = 1.0 - abs(2.0 * detail.x - 1.0);
  vec4 body = mix(b2, b1, w1);

  // The model's cloud water sets where clouds are and how opaque; the noise breaks the 1° grid into texture.
  float water = cloudOpacity(n, true);
  float thickness = water * (0.6 + 0.8 * body.x);
  float density = smoothstep(0.04, 0.9, thickness);
  float alpha = density * 0.95;

  // Cloud tops stand as high as the cloud is thick, so they rise into billows where the noise peaks, and taller
  // ones where there is more cloud water. Only the billows tilt the normal: the noise's gradient comes with it
  // (its space is twice the Earth frame's), while the water's would need more reads of the cubic field.
  vec3 rise = water * 1.6 * body.yzw;
  rise = (rise - n * dot(rise, n)) * ${CLOUD_RELIEF.toFixed(4)};
  vec3 N = normalize(n - rise * min(1.0, ${MAX_CLOUD_SLOPE.toFixed(2)} / max(length(rise), 1e-6)));

  // Sunlight reaching the cloud tops, reddened by the air and cut off by the planet: tops stay lit, in sunset
  // colours, a little past the ground's terminator. Thicker cloud reflects more. Aircraft shade the tops below.
  float reflectance = CLOUD_BRIGHTNESS * (0.55 + 0.45 * density);
  vec3 sun = normalize(sunDir);
  vec3 color = deckSunlight(n, sun) * deckLight(N, n, sun) * reflectance * planeShadow(n);
  if (moonlight > 0.0) color += moonlight * deckSunlight(n, moonDir) * deckLight(N, n, moonDir) * reflectance;

  // City light scattered up through the cloud from below (routereplay cityglow.py): spread a little, and
  // strongest through moderate cloud; thick cloud swallows it. The spread is the lights map two mip levels
  // down, sampled cubically: bilinear sampling there turns every town into a soft square.
  vec2 uv = vec2(atan(-n.z, n.x) / (2.0 * PI) + 0.5, asin(clamp(n.y, -1.0, 1.0)) / PI + 0.5);
  float tau = -log(1.0 - min(alpha, 0.98));
  float penetration = 0.7 * exp(-tau) + 0.3 * exp(-0.4 * tau);
  float spread = cubicSample(nightMap, uv, vec2(textureSize(nightMap, 2)), 2.0).r;
  color += cityLights(n, spread) * 0.5 * penetration;

  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Every weather step a journey needs, keyed by valid time, `stepHours` apart. */
export interface CloudSet {
  stepHours: number;
  steps: Map<number, WeatherStep>;
  /** Physical time the detail noise counts from, so it never runs into float precision limits. */
  originMs: number;
}

/** Load the steps covering a journey's physical time. Missing steps are left out; the layer fades there. */
export async function loadJourneyClouds(scene: NormalizedSceneV1): Promise<CloudSet | null> {
  const run = scene.environment.cloudRun;
  if (scene.environment.weather !== 'clouds' || !run || !scene.legs.length) return null;
  // The holds run 20 minutes either side of the flights.
  const start = Date.parse(scene.legs[0]!.departureUtc) - HOLD_MINUTES * 60_000;
  const end = Date.parse(scene.legs[scene.legs.length - 1]!.arrivalUtc) + HOLD_MINUTES * 60_000;
  const plan = cloudFieldsFor(start, end, run);
  const loaded = await Promise.all(plan.fields.map(async (f) => [f.validMs, await loadWeatherStep(f)] as const));
  const steps = new Map<number, WeatherStep>();
  for (const [validMs, step] of loaded) if (step) steps.set(validMs, step);
  return steps.size ? { stepHours: plan.stepHours, steps, originMs: start } : null;
}

/** What to draw at a physical time from steps `stepHours` apart, or null where there is no data. */
export function cloudFrameAt(set: CloudSet, utcMs: number): CloudFrame | null {
  const b = cloudBlendAt(utcMs, set.stepHours, (v) => set.steps.has(v));
  if (!b) return null;
  return {
    a: set.steps.get(b.a)!,
    b: set.steps.get(b.b)!,
    blend: b.mix,
    presence: b.presence,
    ageA: Math.min((utcMs - b.a) / 1000, MAX_ADVECTION_S),
    ageB: b.b > utcMs ? Math.min((b.b - utcMs) / 1000, MAX_ADVECTION_S) : 0,
    seconds: (utcMs - set.originMs) / 1000,
  };
}

export interface CloudFrame {
  a: WeatherStep;
  b: WeatherStep;
  /** 0 shows step a, 1 step b. */
  blend: number;
  /** Fades the whole layer at the edge of the model data. */
  presence: number;
  /** Seconds the wind carries step a forward, and step b back. */
  ageA: number;
  ageB: number;
  /** Seconds since the set's origin, for the drifting detail. */
  seconds: number;
}

/**
 * Real clouds from NOAA's GFS model on a shell just above the ground (Earth frame), carried by the model's
 * wind between time steps. Drawn after the ground and before planes, routes, and labels, which stay on top.
 * `shadows`: the aircraft that shade the cloud tops (see planeShadow.ts).
 */
export function Clouds({
  frame,
  lights,
  night,
  segments,
  shadows = [],
}: {
  frame: CloudFrame;
  lights: SkyLights;
  night: THREE.Texture;
  segments: number;
  shadows?: readonly ShadowCaster[];
}) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          ...cloudUniforms(),
          ...lightUniforms(),
          ...planeShadowUniforms(),
          noise: { value: noiseTexture() },
          nightMap: { value: night },
          detail: { value: new THREE.Vector4() },
        },
        vertexShader: cloudVertex,
        fragmentShader: cloudFragment,
        // Blended but kept in the opaque pass, so planes (drawn after it) always stay visible above the clouds.
        blending: THREE.CustomBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        depthWrite: false,
      }),
    [night],
  );
  useEffect(() => () => material.dispose(), [material]);
  const u = material.uniforms;
  setCloudUniforms(u, frame);
  setLightUniforms(u, lights);
  setPlaneShadowUniforms(u, shadows, lights.sun);
  const cycles = frame.seconds / DETAIL_PERIOD_S;
  (u.detail!.value as THREE.Vector4).set(cycles - Math.floor(cycles), Math.floor(cycles), Math.floor(cycles + 0.5), 0);
  return (
    <mesh material={material} renderOrder={0.5}>
      <sphereGeometry args={[CLOUD_RADIUS, segments, Math.round(segments / 2)]} />
    </mesh>
  );
}

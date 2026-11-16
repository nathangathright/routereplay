import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { NormalizedSceneV1 } from '../../shared/scene/types';
import { CLOUD_GRID, type CloudField, cloudBlendAt, cloudFieldsFor } from '../../shared/weather/gfs';
import { decodeGrib2 } from '../../shared/weather/grib2';
import { HOLD_MINUTES } from '../../shared/scene/constants';
import { AIR_GLSL, CITY_GLSL, LIGHT_GLSL, type SkyLights, lightUniforms, setLightUniforms } from './lighting';
import { PLANE_SHADOW_GLSL, type ShadowCaster, planeShadowUniforms, setPlaneShadowUniforms } from './planeShadow';
import { COVER_LEVELS, EROSION, EROSION_OFFSET, EROSION_SCALE, LOBE_CORE, LOBE_EDGE, SHAPE_CELLS, SHAPE_SIZE, SHAPE_SLOPE_RANGE, cellularShapes, coverTables } from './cloudShapes';
import { skyLightGlsl, skyTexture } from './skyLight';
import { airAboveAlbedo } from './airLight';
import { sceneDefines, useLinearScene } from './display';

/** Cloud tops sit this far out (Earth radii): exaggerated about 10× so they read above the ground at globe scale. */
export const CLOUD_RADIUS = 1.004;
/**
 * How bright a sunlit deck is, in scene units (a white surface facing the Sun reads 1): clouds outshine the ground.
 * Composited in linear light a deck has to carry its own brightness, with no air added over it in display values to
 * lift it toward white, so it is brighter there than in the frame drawn the old way, each layer tone mapped.
 */
const CLOUD_BRIGHTNESS = { linear: 3.2, displayReferred: 2.4 };
const CLOUD_BRIGHTNESS_GLSL = /* glsl */ `
#ifdef LINEAR_SCENE
const float CLOUD_BRIGHTNESS = ${CLOUD_BRIGHTNESS.linear.toFixed(3)};
#else
const float CLOUD_BRIGHTNESS = ${CLOUD_BRIGHTNESS.displayReferred.toFixed(3)};
#endif
`;
/**
 * The share of the deck's light that the clear air above it sends back down onto it, by colour (airAboveAlbedo):
 * about (0.03, 0.06, 0.13). The deck reflects it again, so a bright deck under clear air comes out a little bluer
 * than the light falling on it, as a white surface under air that only scatters returns all the light it gets.
 */
const DECK_RETURN = airAboveAlbedo(CLOUD_RADIUS);
/** Opacity per kg/m² of cloud water: about 37 % of the globe then looks solid, as it does from space. */
const OPACITY_PER_KG = 30;
/** Wind is stored in 8 bits per component at this many m/s per step (±77 m/s). */
const WIND_STEP = 0.6;
/** The 250 hPa wind, near the jet stream, is stored at this many m/s per step (±152 m/s). */
const JET_STEP = 1.2;
/**
 * The high layer (cirrus) sits this far out, 10.5 km up (the offline renderer's high layer) at the scene's 12×
 * height exaggeration, as for the aircraft: just under a plane at cruise, and 95 km over the main deck.
 */
export const CIRRUS_RADIUS = 1 + (10_500 * 12) / 6_371_000;
/**
 * The same height in the air's own convention (heights spread 7.2×, lighting.ts AIR_GLSL), for the light that
 * reaches the layer: at the drawn height it would sit above 89 % of the air and stay white through sunset.
 */
const CIRRUS_AIR_RADIUS = 1 + (10_500 * 7.2) / 6_371_000;
/** The share of the high layer's light that the air above it sends back down onto it, as for the deck (DECK_RETURN). */
const CIRRUS_RETURN = airAboveAlbedo(CIRRUS_AIR_RADIUS);
/**
 * Ice above the deck: GFS's ice mixing ratio at 200, 300 and 400 hPa, each standing for a 100 hPa slab (150–450
 * hPa, about 6.5–13.5 km), gives the ice water path, Σ q × 10⁴ Pa / g. Optical depth is 3 IWP / (2 ρ r) for ice
 * of density 917 kg/m³ and effective radius 30 µm, the offline renderer's assumption: 54.5 per kg/m².
 */
const ICE_LEVELS_PA = [20_000, 30_000, 40_000];
const ICE_SLAB_KG = 10_000 / 9.81;
const ICE_TAU_PER_KG = 1.5 / (917 * 30e-6);
/**
 * Ice scatters mostly forward, so a layer of optical depth τ turns back far less light than a water cloud of the
 * same depth, and hides little of what lies below. The high layer's opacity is 1 − e^(−0.25 τ): thin cirrus
 * (τ ≈ 0.3) a faint 7 % veil, τ ≈ 3 a half, thick anvils (τ ≈ 10 and more) opaque. Single scattering gives about
 * (1 − g) / 2 ≈ 0.15 for ice's asymmetry g ≈ 0.75; 0.25 lets thin cirrus read at globe scale.
 */
const ICE_OPACITY_PER_TAU = 0.25;
/** The high layer's texture repeats this many times per Earth radius: lobes about 130 km across. */
const CIRRUS_SCALE = 3;
/** Streaks: the texture averaged over three points this many seconds of 250 hPa wind apart. */
const STREAK_S = 2400;
/** Share of direct light that opaque cirrus takes away from what lies below it (the deck and the ground). */
const CIRRUS_SHADOW = 0.5;
/** Clouds are carried by the wind for at most this long from each field (routereplay caps wind history at 4 h). */
const MAX_ADVECTION_S = 3 * 3600;
/** The procedural detail is carried by the wind and renewed on this cycle, so it never stretches out. */
const DETAIL_PERIOD_S = 3 * 3600;
/**
 * Cloud-top relief for lighting only (the shell stays a sphere): tops rise this many Earth radii per unit of the
 * billow shape, times the lobes' thickness (their opacity before carving), about 38 km. A lobe stands about half a unit above its surroundings,
 * some 19 km: 1.6 km of real cloud at the scene's 12× height exaggeration.
 */
const CLOUD_RELIEF = 0.006;
/** The billows' texture repeats this many times per Earth radius, so its lobes are about 100 km across. */
const SHAPE_SCALE = 4;
/**
 * How the model's cloud opacity (water) splits into cover and thickness: lobes cover a fraction water^0.3 of the
 * sky, each as opaque as water^0.7, so the area's mean opacity stays about the model's. Thin cloud breaks into
 * faint, scattered lobes with clear sky between; thick cloud closes into a deck.
 */
const COVER_EXPONENT = 0.3;
/**
 * The billows' texture is turned by a fixed rotation (and its finer octave by another), so its texel grid lines up
 * with neither north nor east, nor with each other: facets that survive filtering don't read as a grid.
 */
const SHAPE_ROTATION = rotation([0.36, 0.48, 0.8], 0.9);
const EROSION_ROTATION = rotation([-0.62, 0.3, 0.72], 2.1);
/**
 * Detail fades toward its mean as it shrinks on screen, measured in pixels per lobe: the finer octave's over 3–8
 * pixels per finer lobe, the lobes over 4–16. A whole-globe view (about 9 pixels per lobe) shows a soft deck where
 * the lobes would otherwise alias into speckle.
 */
const FINE_PIXELS = [3, 8] as const;
const LOBE_PIXELS = [4, 16] as const;

/** Rotation by `angle` radians about `axis` (Rodrigues), as a GLSL mat3 literal (columns) and its transpose. */
function rotation(axis: [number, number, number], angle: number): { glsl: string; inverse: string } {
  const l = Math.hypot(...axis);
  const [x, y, z] = axis.map((v) => v / l) as [number, number, number];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const m = [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
  const mat = (col: (j: number) => number[]) => `mat3(${[0, 1, 2].map((j) => col(j).map((v) => v.toFixed(6)).join(', ')).join(', ')})`;
  return { glsl: mat((j) => m.map((row) => row[j]!)), inverse: mat((j) => m[j]!) };
}
/** Steepest cloud-top slope (rise over run), so the steepest billows in thick cloud never turn edge-on. */
const MAX_CLOUD_SLOPE = 1.5;
/**
 * How strongly a billow's slope brightens or dims it: light × e^(k (N·l − n·l)), N the tilted normal and n the
 * shell's. For a tilt θ toward the light that is about e^(k θ cos(elevation)), strongest at sunrise and sunset.
 */
const CLOUD_SHADING = 2.5;

/**
 * One model time step on the 1° grid (rows from 90°N to 90°S, columns from 0° eastward):
 * - `cloud`, RG8: R the main deck's opacity, from cloud water less the ice drawn in the high layer; G the high
 *   layer's opacity, 1 − e^(−0.25 τ) for the optical depth τ of the ice above 450 hPa (ICE_OPACITY_PER_TAU).
 * - `wind`, RGBA8: RG the 700 hPa wind that moves the deck, BA the 250 hPa wind that moves the high layer (east,
 *   north). Two fields in each texture keep the ground's shader within the texture units a phone guarantees.
 * Steps whose file lacks the ice or the 250 hPa wind have no high layer (G = 0, BA = calm).
 */
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
  if (!shapes) setTimeout(cloudShapes, 0);
  const key = `${field.cycle}/${field.hour}`;
  let p = stepCache.get(key);
  if (!p) {
    p = fetch(`/api/v1/weather/gfs-layers/${key}`)
      .then(async (res) => {
        if (!res.ok) return null;
        const fields = decodeGrib2(new Uint8Array(await res.arrayBuffer()));
        // GRIB2 parameters: cloud water is meteorological 6/6, ice mixing ratio 1/23, wind east 2/2 and north
        // 2/3; isobaric levels (surface type 100) in Pa.
        const find = (category: number, parameter: number, pa?: number) =>
          fields.find(
            (f) =>
              f.discipline === 0 && f.category === category && f.parameter === parameter && f.nx === CLOUD_GRID.nx && f.ny === CLOUD_GRID.ny &&
              (pa === undefined || (f.surfaceType === 100 && f.surfaceValue === pa)),
          );
        const water = find(6, 6);
        const u = find(2, 2, 70_000);
        const v = find(2, 3, 70_000);
        if (!water || !u || !v) return null;
        const ice = ICE_LEVELS_PA.map((pa) => find(1, 23, pa));
        const ju = find(2, 2, 25_000);
        const jv = find(2, 3, 25_000);
        const high = ice.every(Boolean) && ju && jv;
        const n = CLOUD_GRID.nx * CLOUD_GRID.ny;
        const cloud = new Uint8Array(n * 2);
        const wind = new Uint8Array(n * 4);
        const finite = (x: number | undefined) => (x !== undefined && Number.isFinite(x) ? x : 0);
        const quantize = (x: number | undefined, step: number) => Math.min(255, Math.max(0, Math.round(128 + finite(x) / step)));
        const opacity = (x: number) => Math.round(255 * (1 - Math.exp(-Math.max(0, x))));
        for (let i = 0; i < n; i++) {
          // Ice water path above 450 hPa (kg/m²); cloud water counts it too, so the deck keeps the rest.
          const iwp = high ? ice.reduce((sum, f) => sum + Math.max(0, finite(f!.values[i])), 0) * ICE_SLAB_KG : 0;
          cloud[2 * i] = opacity(OPACITY_PER_KG * (finite(water.values[i]) - iwp));
          cloud[2 * i + 1] = opacity(ICE_OPACITY_PER_TAU * ICE_TAU_PER_KG * iwp);
          wind[4 * i] = quantize(u.values[i], WIND_STEP);
          wind[4 * i + 1] = quantize(v.values[i], WIND_STEP);
          wind[4 * i + 2] = high ? quantize(ju.values[i], JET_STEP) : 128;
          wind[4 * i + 3] = high ? quantize(jv.values[i], JET_STEP) : 128;
        }
        return { cloud: gridTexture(cloud, THREE.RGFormat), wind: gridTexture(wind, THREE.RGBAFormat) };
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

interface Shapes {
  texture: THREE.Data3DTexture;
  /** Per level of cover (cloudShapes.ts coverTables): the cut-off with and without the finer octave, and the mean of each. */
  levels: THREE.Vector4[];
}
let shapes: Shapes | null = null;

/**
 * The billows' cellular texture (cloudShapes.ts) and the levels that carve it to a given cover. Built once per
 * page, the first time anything asks; loadWeatherStep asks early, so the work overlaps the download.
 */
function cloudShapes(): Shapes {
  if (!shapes) {
    const { rgba } = cellularShapes();
    const t = coverTables(rgba);
    const texture = new THREE.Data3DTexture(rgba, SHAPE_SIZE, SHAPE_SIZE, SHAPE_SIZE);
    texture.format = THREE.RGBAFormat;
    texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
    texture.magFilter = texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    const levels = t.full.map((cut, i) => new THREE.Vector4(cut, t.coarse[i]!, t.meanFull[i]!, t.meanCoarse[i]!));
    shapes = { texture, levels };
  }
  return shapes;
}

const blanks = new Map<number, THREE.DataTexture>();
/** Stand-ins for missing fields, every channel `value`: 0 for no cloud, 128 for calm. */
function blankTexture(value: 0 | 128): THREE.DataTexture {
  let t = blanks.get(value);
  if (!t) {
    t = new THREE.DataTexture(new Uint8Array([value, value, value, value]), 1, 1, THREE.RGBAFormat);
    t.needsUpdate = true;
    blanks.set(value, t);
  }
  return t;
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

// Wind in m/s toward the east (x) and north (y): at 700 hPa, which moves the deck, and at 250 hPa, which moves the
// high layer.
vec2 windAt(sampler2D w, vec2 uv) {
  return (texture2D(w, uv).rg * 255.0 - 128.0) * ${WIND_STEP.toFixed(2)};
}
vec2 jetAt(sampler2D w, vec2 uv) {
  return (texture2D(w, uv).ba * 255.0 - 128.0) * ${JET_STEP.toFixed(2)};
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

// The high layer's opacity at n, carried by the 250 hPa wind between the two fields.
float cirrusOpacity(vec3 n, bool smoothly) {
  vec2 uv = gridUv(n);
  vec2 a = gridUv(drift(n, jetAt(windA, uv), -cloudAgeA));
  vec2 b = gridUv(drift(n, jetAt(windB, uv), cloudAgeB));
  float oa = smoothly ? cubicSample(cloudA, a, vec2(360.0, 181.0), 0.0).g : texture2D(cloudA, a).g;
  float ob = smoothly ? cubicSample(cloudB, b, vec2(360.0, 181.0), 0.0).g : texture2D(cloudB, b).g;
  return mix(oa, ob, cloudBlend) * cloudPresence;
}

// Direct light the high layer lets through to a point p below it (Earth radii), toward the light s: where the
// beam crosses the layer. Even an opaque layer passes ${Math.round(100 * (1 - CIRRUS_SHADOW))} % of it, scattered forward.
float cirrusShadow(vec3 p, vec3 s) {
  float ps = dot(p, s);
  vec3 crossing = normalize(p + s * (-ps + sqrt(ps * ps - dot(p, p) + ${(CIRRUS_RADIUS * CIRRUS_RADIUS).toFixed(6)})));
  return 1.0 - ${CIRRUS_SHADOW.toFixed(2)} * cirrusOpacity(crossing, false);
}
`;

/** Uniforms for CLOUD_GLSL; merge them into a material's uniforms and keep them current with setCloudUniforms. */
export function cloudUniforms(): Record<string, THREE.IUniform> {
  const none = blankTexture(0);
  const calm = blankTexture(128);
  return {
    cloudA: { value: none },
    cloudB: { value: none },
    windA: { value: calm },
    windB: { value: calm },
    cloudBlend: { value: 0 },
    cloudPresence: { value: 0 },
    cloudAgeA: { value: 0 },
    cloudAgeB: { value: 0 },
  };
}

export function setCloudUniforms(u: Record<string, THREE.IUniform>, frame: CloudFrame | null): void {
  const none = blankTexture(0);
  const calm = blankTexture(128);
  u.cloudA!.value = frame?.a.cloud ?? none;
  u.cloudB!.value = frame?.b.cloud ?? none;
  u.windA!.value = frame?.a.wind ?? calm;
  u.windB!.value = frame?.b.wind ?? calm;
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

/**
 * The deck at a point on its shell, `deck(n)`: its light and its opacity, carved into lobes and gaps. The deck draws it
 * at every point of its sphere; its veil draws it over a craft under it, at the point where each of the craft's pixels
 * looks through the shell (veilMaterial). One source, so the veil is the same cloud in the same light, lobe for lobe.
 */
export const DECK_GLSL = /* glsl */ `
precision highp sampler3D;
${CLOUD_BRIGHTNESS_GLSL}
uniform sampler3D noise;
uniform vec4 coverLevels[${COVER_LEVELS + 1}]; // cut-off with the finer octave, without it, and the mean of each
uniform sampler2D nightMap;
uniform vec4 detail; // x: phase of layer 1 (0–1), y: its cycle, z: cycle of layer 2 (half a period behind)
${LIGHT_GLSL}
${AIR_GLSL}
${CITY_GLSL}
${CLOUD_GLSL}
${PLANE_SHADOW_GLSL}
${skyLightGlsl(2)}

// The shape texture's gradient, per unit of texture coordinate.
vec3 shapeSlope(vec4 texel) {
  return (texel.gba * 255.0 - 128.0) * ${(SHAPE_SLOPE_RANGE / 127).toFixed(6)};
}

const mat3 SHAPE_ROTATION = ${SHAPE_ROTATION.glsl};
const mat3 SHAPE_UNROTATION = ${SHAPE_ROTATION.inverse};
const mat3 EROSION_ROTATION = ${EROSION_ROTATION.glsl};
const mat3 EROSION_UNROTATION = ${EROSION_ROTATION.inverse};

// The two texels that shape the billows at p (Earth frame, drifted) for a copy with this seed: rounded lobes about
// 100 km across (a), and the same lobes ${EROSION_SCALE}× finer (about 38 km) that erode their edges (b). Each octave is
// turned its own way, so neither texel grid lines up with north, east, or the other.
void shapeTexels(vec3 p, vec3 seed, out vec4 a, out vec4 b) {
  a = texture(noise, SHAPE_ROTATION * p * ${SHAPE_SCALE.toFixed(1)} + seed);
  b = texture(noise, EROSION_ROTATION * p * ${(SHAPE_SCALE * EROSION_SCALE).toFixed(2)} + seed + ${EROSION_OFFSET.toFixed(2)});
}

// How much of a lobe is at shape s, carved at cut: soft at the rim, opaque in the core. The rim's softness includes
// what one pixel spans of the carved shape, so edges stay about a pixel soft at any distance.
float lobe(float s, float cut, float edge) {
  return smoothstep(cut - edge, cut + edge, s) * (0.6 + 0.4 * smoothstep(cut, cut + ${LOBE_CORE.toFixed(2)}, s));
}

// The cover's levels (cloudShapes.ts coverTables) at x = (1 − cover) × ${COVER_LEVELS}, between table entries.
vec4 coverLevel(float x) {
  int i = min(int(x), ${COVER_LEVELS - 1});
  return mix(coverLevels[i], coverLevels[i + 1], x - float(i));
}

// Brightness of a cloud top with normal N on the shell at n, lit from direction l. A level deck catches light a
// little past its horizon, as volumes do. Slopes facing the light brighten it and slopes turned away dim it,
// smoothly and never to black (light scatters through the cloud), most when the light is low.
float deckLight(vec3 N, vec3 n, vec3 l) {
  float level = clamp((dot(n, l) + 0.15) / 1.15, 0.0, 1.0);
  return level * exp(${CLOUD_SHADING.toFixed(2)} * (dot(N, l) - dot(n, l)));
}

// Light reaching the deck from direction l, reddened by the air on its way, in the ground's units (SUN_ABOVE_AIR):
// the deck sits above part of the air, so a high Sun is a little bluer there than on the ground. The deck has depth:
// its lowest cloud loses the light at the ground's terminator and its top a few degrees later (where the planet's
// limb hides the light from it), so the deck dims gradually instead of all at once.
vec3 deckSunlight(vec3 n, vec3 l) {
  vec3 top = n * ${CLOUD_RADIUS.toFixed(4)};
  float altitude = asin(clamp(dot(n, l), -1.0, 1.0));
  float lit = smoothstep(-${Math.acos(1 / CLOUD_RADIUS).toFixed(5)}, 0.01, altitude);
  return exp(-extinction(columnToLight(top, l))) * SUN_ABOVE_AIR * lit;
}

// How much of the light from one sky direction (at cosine mu from the vertical) a cloud of optical depth tau
// scatters back, per unit of its opacity: all of it in thin cloud, less in thick, where light from the sky is
// lost on its way down to the depth the view reaches. The offline renderer's blend of direct penetration (80 %)
// and a more diffuse one (20 %, at 0.35 of the optical depth). Thick cloud keeps about half from the zenith and
// 45 % from the sides.
float thinning(float tau, float mu, float k) {
  float a = 1.0 + k / mu;
  return tau < 1e-3 ? 1.0 : (1.0 - exp(-tau * a)) / (a * (1.0 - exp(-tau)));
}
vec3 skyThinning(float tau) {
  float zenith = 0.8 * thinning(tau, 1.0, 1.0) + 0.2 * thinning(tau, 1.0, 0.35);
  float side = 0.8 * thinning(tau, 0.7071, 1.0) + 0.2 * thinning(tau, 0.7071, 0.35);
  return vec3(zenith, side, side);
}

// The deck at n (unit vector, Earth frame, on its shell): its light, and its opacity (at most 0.95) in alpha. It takes
// screen-space derivatives, to antialias its lobes, so it must be called in uniform control flow.
vec4 deck(vec3 n) {
  // The noise detail drifts with the wind too. Two copies, half a cycle apart, each restart from a fresh
  // seed when unseen, so the texture moves without ever smearing out.
  vec2 wind = mix(windAt(windA, gridUv(n)), windAt(windB, gridUv(n)), cloudBlend);
  float phase2 = fract(detail.x + 0.5);
  vec3 seed1 = fract(vec3(0.173, 0.311, 0.457) * detail.y);
  vec3 seed2 = fract(vec3(0.173, 0.311, 0.457) * detail.z);
  vec3 p1 = drift(n, wind, -detail.x * ${DETAIL_PERIOD_S.toFixed(1)});
  vec3 p2 = drift(n, wind, -phase2 * ${DETAIL_PERIOD_S.toFixed(1)});
  vec4 a1, b1, a2, b2;
  shapeTexels(p1, seed1, a1, b1);
  shapeTexels(p2, seed2, a2, b2);
  float w1 = 1.0 - abs(2.0 * detail.x - 1.0);

  // How many pixels a lobe spans here. Detail too small to draw fades toward its mean instead of aliasing: the finer
  // octave first, then the lobes themselves, so a whole-globe view shows a soft deck rather than speckle.
  vec3 q = SHAPE_ROTATION * p1 * ${SHAPE_SCALE.toFixed(1)};
  float lobePixels = ${(1 / SHAPE_CELLS).toFixed(5)} / max(max(length(dFdx(q)), length(dFdy(q))), 1e-7);
  float fine = smoothstep(${FINE_PIXELS[0].toFixed(1)}, ${FINE_PIXELS[1].toFixed(1)}, lobePixels / ${EROSION_SCALE.toFixed(2)});
  float lobes = smoothstep(${LOBE_PIXELS[0].toFixed(1)}, ${LOBE_PIXELS[1].toFixed(1)}, lobePixels);

  // The model's cloud opacity sets where clouds are; the billows carve it into lobes. They cover a fraction
  // water^${COVER_EXPONENT} of the sky, so thin cloud breaks into puffs with clear sky between and thick cloud closes up. Each
  // copy is carved before the two are blended, so cover never dips while one copy hands over to the other. Lobes
  // are as opaque as keeps the area's mean opacity the model's, however much of their detail is drawn.
  float water = cloudOpacity(n, true);
  float cover = pow(water, ${COVER_EXPONENT.toFixed(2)});
  vec4 cut = coverLevel(clamp(1.0 - cover, 0.0, 1.0) * ${COVER_LEVELS.toFixed(1)});
  // Each copy: the lobes eroded by the finer octave, or, where that octave is too small to draw, the lobes alone
  // at their own levels. Rims widen by a pixel's span of the shape (the copies' spans match; one is measured).
  float eroded1 = a1.r - ${EROSION.toFixed(2)} * (1.0 - b1.r);
  float eroded2 = a2.r - ${EROSION.toFixed(2)} * (1.0 - b2.r);
  float edgeEroded = ${LOBE_EDGE.toFixed(3)} + fwidth(eroded1);
  float edgeLobes = ${LOBE_EDGE.toFixed(3)} + fwidth(a1.r);
  float o1 = mix(lobe(a1.r, cut.y, edgeLobes), lobe(eroded1, cut.x, edgeEroded), fine);
  float o2 = mix(lobe(a2.r, cut.y, edgeLobes), lobe(eroded2, cut.x, edgeEroded), fine);
  float mean = mix(cut.w, cut.z, fine);
  float occupied = mix(mean, mix(o2, o1, w1), lobes);
  float density = min(1.0, occupied * water / max(mean, 1e-3));
  float alpha = density * 0.95;

  // Cloud tops stand as high as the billow shape, scaled by the lobes' thickness, and flatten with the lobes as
  // they fade. Only the billows tilt the normal: their gradient comes with the texture reads, while the water's
  // would need more reads of the cubic field.
  float thickness = water / max(cover, 1e-3);
  vec3 lobeSlope = SHAPE_UNROTATION * mix(shapeSlope(a2), shapeSlope(a1), w1);
  vec3 fineSlope = EROSION_UNROTATION * mix(shapeSlope(b2), shapeSlope(b1), w1);
  vec3 rise = thickness * lobes * ${SHAPE_SCALE.toFixed(1)} * (lobeSlope + fine * ${(EROSION * EROSION_SCALE).toFixed(3)} * fineSlope);
  rise = (rise - n * dot(rise, n)) * ${CLOUD_RELIEF.toFixed(4)};
  vec3 N = normalize(n - rise * min(1.0, ${MAX_CLOUD_SLOPE.toFixed(2)} / max(length(rise), 1e-6)));

  // Sunlight reaching the cloud tops, reddened by the air and cut off by the planet: tops stay lit, in sunset
  // colours, a little past the ground's terminator. Thicker cloud reflects more. Aircraft shade the tops below.
  float albedo = 0.55 + 0.45 * density;
  float reflectance = CLOUD_BRIGHTNESS * albedo;
  vec3 sun = normalize(sunDir);
  // The high layer shades the deck where the light crosses it on the way down.
  vec3 top = n * ${CLOUD_RADIUS.toFixed(4)};
  vec3 color = deckSunlight(n, sun) * deckLight(N, n, sun) * reflectance * planeShadow(n) * cirrusShadow(top, sun);

  // Light from the clear sky above (skyLight.ts): blue, and lit for a while after the Sun has set on the deck.
  // Slopes take more of the sky they face, so billow sides turned from the Sun take on its blue-grey. Thick cloud
  // scatters back less of it per unit of opacity than thin cloud. It is reflected at the cloud's own albedo, not
  // the sunlit deck's gain (CLOUD_BRIGHTNESS), which would turn the gold band along the terminator blue-grey. The
  // Moon lights the same sky, scaled like its direct light.
  float tau = -log(1.0 - min(alpha, 0.98));
  vec3 thin = skyThinning(tau);
  color += skyLight(n, sun, 0.0, N, ${CLOUD_SHADING.toFixed(2)}, thin) * albedo;
  if (moonlight > 0.0) {
    color += moonlight * (deckSunlight(n, moonDir) * deckLight(N, n, moonDir) * reflectance * cirrusShadow(top, moonDir) + skyLight(n, moonDir, 0.0, N, ${CLOUD_SHADING.toFixed(2)}, thin) * albedo);
  }

  // The clear air above sends part of the deck's light back down onto it, and the deck reflects that too.
  #ifdef LINEAR_SCENE
  color /= 1.0 - vec3(${DECK_RETURN.map((x) => x.toFixed(5)).join(', ')}) * albedo;
  #endif

  // City light scattered up through the cloud from below (routereplay cityglow.py): spread a little, and
  // strongest through moderate cloud; thick cloud swallows it. The spread is the lights map two mip levels
  // down, sampled cubically: bilinear sampling there turns every town into a soft square.
  vec2 uv = vec2(atan(-n.z, n.x) / (2.0 * PI) + 0.5, asin(clamp(n.y, -1.0, 1.0)) / PI + 0.5);
  float penetration = 0.7 * exp(-tau) + 0.3 * exp(-0.4 * tau);
  float spread = cubicSample(nightMap, uv, vec2(textureSize(nightMap, 2)), 2.0).r;
  color += cityLights(n, spread) * 0.5 * penetration;
  return vec4(color, alpha);
}
`;

const cloudFragment = /* glsl */ `
varying vec3 vEarth;
${DECK_GLSL}
void main() {
  gl_FragColor = deck(normalize(vEarth));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * The deck again, over a craft's own pixels: where each pixel's view ray meets the deck's shell, the cloud the deck
 * draws there, at its density × `veilStrength` (cloudCrossing.ts). The craft's geometry only says which pixels to cover;
 * how far under the deck it is comes from its altitude. Pixels whose ray misses the shell (past the limb) stay clear.
 * Hashed alpha discards the same pixels as the craft's paint while it dissolves into the next craft.
 */
const veilVertex = /* glsl */ `
invariant gl_Position;
uniform mat4 earthFromWorld;
varying vec3 vEarthPoint;
varying vec3 vPosition;
void main() {
  vPosition = position;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vEarthPoint = (earthFromWorld * world).xyz;
  // Exactly as the craft's paint places it (craftPaint.ts), so the veil's depth equals the paint's at every pixel.
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const veilFragment = /* glsl */ `
uniform vec3 veilEye; // the camera, Earth frame
uniform float veilStrength;
uniform float opacity;
varying vec3 vEarthPoint;
varying vec3 vPosition;
${DECK_GLSL}
#include <alphahash_pars_fragment>
void main() {
  vec3 ray = normalize(vEarthPoint - veilEye);
  float b = dot(veilEye, ray);
  float h = b * b - dot(veilEye, veilEye) + ${(CLOUD_RADIUS * CLOUD_RADIUS).toFixed(6)};
  vec3 n = normalize(veilEye + ray * (-b - sqrt(max(h, 0.0))));
  vec4 cloud = deck(n);
  vec4 diffuseColor = vec4(1.0, 1.0, 1.0, opacity);
  #include <alphahash_fragment>
  gl_FragColor = vec4(cloud.rgb, h > 0.0 ? cloud.a / 0.95 * veilStrength : 0.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** The sky table's layers (skyLight.ts): the deck, then the high layer. */
const SKY_LAYERS = [CLOUD_RADIUS, CIRRUS_AIR_RADIUS];

/**
 * The high layer: thin ice clouds on their own shell, 10.5 km up (×12), moved by the 250 hPa wind. Its texture is
 * the billows' lobes averaged along the wind (three points STREAK_S apart, a short line integral), which draws them
 * out into streaks as long as the wind is fast: about 130 km wide and 300–500 km long under a 40–70 m/s jet,
 * round where the air is still. Two copies drift and renew like the deck's.
 */
const cirrusFragment = /* glsl */ `
precision highp sampler3D;
uniform sampler3D noise;
uniform vec4 detail;
varying vec3 vEarth;
${LIGHT_GLSL}
${AIR_GLSL}
${CLOUD_GLSL}
${skyLightGlsl(2)}
${CLOUD_BRIGHTNESS_GLSL}

// Streaks at n: the lobes where the air at n was age seconds ago, averaged with where it was ${STREAK_S / 60} and ${(2 * STREAK_S) / 60}
// minutes before that.
float streaks(vec3 n, vec2 jet, float age, vec3 seed) {
  float s = 0.0;
  for (int k = 0; k < 3; k++) {
    s += texture(noise, drift(n, jet, -(age + float(k) * ${STREAK_S.toFixed(1)})) * ${CIRRUS_SCALE.toFixed(1)} + seed).r;
  }
  return s / 3.0;
}

// Light reaching the layer from direction l, reddened by the air above it (in the ground's units, as for the deck),
// and cut off by the planet a little later than for the deck below. Heights here are the air's (CIRRUS_AIR_RADIUS).
vec3 layerLight(vec3 n, vec3 l) {
  float altitude = asin(clamp(dot(n, l), -1.0, 1.0));
  float lit = smoothstep(-${Math.acos(1 / CIRRUS_AIR_RADIUS).toFixed(5)}, 0.01, altitude);
  float level = clamp((dot(n, l) + 0.15) / 1.15, 0.0, 1.0);
  return exp(-extinction(columnToLight(n * ${CIRRUS_AIR_RADIUS.toFixed(5)}, l))) * SUN_ABOVE_AIR * lit * level;
}

void main() {
  vec3 n = normalize(vEarth);
  float ice = cirrusOpacity(n, true);
  if (ice < 0.004) discard;
  vec2 jet = mix(jetAt(windA, gridUv(n)), jetAt(windB, gridUv(n)), cloudBlend);
  float phase2 = fract(detail.x + 0.5);
  vec3 seed1 = fract(vec3(0.291, 0.137, 0.613) * detail.y);
  vec3 seed2 = fract(vec3(0.291, 0.137, 0.613) * detail.z);
  float s1 = streaks(n, jet, detail.x * ${DETAIL_PERIOD_S.toFixed(1)}, seed1);
  float s2 = streaks(n, jet, phase2 * ${DETAIL_PERIOD_S.toFixed(1)}, seed2);
  float w1 = 1.0 - abs(2.0 * detail.x - 1.0);
  // Streaks thin the ice between them and gather it along them, keeping about the area's mean opacity.
  float streak = mix(s2, s1, w1);
  float alpha = clamp(ice * (0.15 + 1.7 * smoothstep(0.42, 0.68, streak)), 0.0, 0.95);

  // Lit like the deck, without billows: sunlight reddened by the air above the layer, the sky above it (its own
  // row of the table), and the Moon. Ice is white: it reflects like a thick deck, per unit of opacity.
  vec3 sun = normalize(sunDir);
  vec3 color = layerLight(n, sun) * CLOUD_BRIGHTNESS;
  color += skyLight(n, sun, 1.0, n, 0.0, vec3(1.0));
  if (moonlight > 0.0) color += moonlight * (layerLight(n, moonDir) * CLOUD_BRIGHTNESS + skyLight(n, moonDir, 1.0, n, 0.0, vec3(1.0)));
  #ifdef LINEAR_SCENE
  color /= 1.0 - vec3(${CIRRUS_RETURN.map((x) => x.toFixed(5)).join(', ')});
  #endif

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

/** How the deck looks this frame: everything its shader reads besides the point on its shell (DECK_GLSL). */
export interface DeckLook {
  frame: CloudFrame;
  lights: SkyLights;
  /** The global night map, for the city light the deck lets up through it. */
  night: THREE.Texture;
  /** The aircraft that shade its tops (planeShadow.ts); each is left off while it is under the deck. */
  shadows: readonly ShadowCaster[];
}

/** Uniforms for DECK_GLSL; keep them current with setDeckUniforms. */
function deckUniforms(night: THREE.Texture): Record<string, THREE.IUniform> {
  return {
    ...cloudUniforms(),
    ...lightUniforms(),
    ...planeShadowUniforms(),
    noise: { value: cloudShapes().texture },
    coverLevels: { value: cloudShapes().levels },
    nightMap: { value: night },
    skyTable: { value: skyTexture(SKY_LAYERS) },
    detail: { value: new THREE.Vector4() },
  };
}

/** The drifting detail's phase and cycles (the deck's and the high layer's `detail`). */
function setDetailUniform(u: Record<string, THREE.IUniform>, frame: CloudFrame): void {
  const cycles = frame.seconds / DETAIL_PERIOD_S;
  (u.detail!.value as THREE.Vector4).set(cycles - Math.floor(cycles), Math.floor(cycles), Math.floor(cycles + 0.5), 0);
}

/** Keep a deck shader (the deck itself, or a veil over a craft) on this frame's look. */
function setDeckUniforms(u: Record<string, THREE.IUniform>, look: DeckLook): void {
  setCloudUniforms(u, look.frame);
  setLightUniforms(u, look.lights);
  setDetailUniform(u, look.frame);
  setPlaneShadowUniforms(u, look.shadows, look.lights.sun, 'deck');
  u.nightMap!.value = look.night;
}

/**
 * The deck's veil over a craft (veilVertex, veilFragment): drawn with the same geometry and placement as the craft's
 * paint, right after it, and only where that paint is the front-most surface (its depth, equal). Point it at the frame
 * with setVeil, and call aimVeil as it draws.
 *
 * `graphics`: for a craft drawn with the graphics after the tone-map pass (the train, bus, car, and ferry; display.tsx),
 * so its veil draws among them, tone mapped as it draws, as the deck would be on its own. Otherwise the veil is scene
 * light, drawn into the linear target right after the aircraft, as the deck is before it.
 */
export function veilMaterial(linear: boolean, graphics: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: sceneDefines(linear),
    uniforms: {
      ...deckUniforms(blankTexture(0)),
      earthFromWorld: { value: new THREE.Matrix4() },
      veilEye: { value: new THREE.Vector3() },
      veilStrength: { value: 0 },
      opacity: { value: 1 },
    },
    vertexShader: veilVertex,
    fragmentShader: veilFragment,
    alphaHash: true,
    transparent: graphics,
    // Cloud over the craft; the frame's alpha is left alone.
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    depthFunc: THREE.LessEqualDepth,
    depthWrite: false,
  });
}

/**
 * This frame's veil: the deck's look, its strength (veilStrength in cloudCrossing.ts: 0 above the deck), and the
 * craft's own opacity while it dissolves into the next craft (the paint's hashed alpha).
 */
export function setVeil(material: THREE.ShaderMaterial, look: DeckLook, strength: number, opacity: number): void {
  const u = material.uniforms;
  setDeckUniforms(u, look);
  u.veilStrength!.value = strength;
  u.opacity!.value = opacity;
}

/**
 * As a veil draws: the Earth frame it looks through the deck in (`earth`, the object whose world matrix is the Earth
 * frame's: the craft's parent) and the camera there. Call it from the veil mesh's onBeforeRender.
 */
export function aimVeil(material: THREE.ShaderMaterial, earth: THREE.Object3D, camera: THREE.Camera): void {
  const u = material.uniforms;
  const inverse = (u.earthFromWorld!.value as THREE.Matrix4).copy(earth.matrixWorld).invert();
  (u.veilEye!.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverse);
}

/**
 * Real clouds from NOAA's GFS model on a shell just above the ground (Earth frame), carried by the model's
 * wind between time steps. Drawn after the ground and before planes, routes, and labels. An aircraft or vehicle under
 * the deck is drawn over it, then veiled by the deck again (veilMaterial).
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
  const linear = useLinearScene();
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        defines: sceneDefines(linear),
        uniforms: deckUniforms(night),
        vertexShader: cloudVertex,
        fragmentShader: cloudFragment,
        // Blended but kept in the opaque pass, before the aircraft. One under the deck is veiled by veilMaterial.
        blending: THREE.CustomBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        depthWrite: false,
      }),
    [night, linear],
  );
  const high = useMemo(
    () =>
      new THREE.ShaderMaterial({
        defines: sceneDefines(linear),
        uniforms: {
          ...cloudUniforms(),
          ...lightUniforms(),
          noise: { value: cloudShapes().texture },
          skyTable: { value: skyTexture(SKY_LAYERS) },
          detail: { value: new THREE.Vector4() },
        },
        vertexShader: cloudVertex,
        fragmentShader: cirrusFragment,
        blending: THREE.CustomBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        depthWrite: false,
      }),
    [linear],
  );
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => high.dispose(), [high]);
  setDeckUniforms(material.uniforms, { frame, lights, night, shadows });
  setCloudUniforms(high.uniforms, frame);
  setLightUniforms(high.uniforms, lights);
  setDetailUniform(high.uniforms, frame);
  return (
    <>
      <mesh material={material} renderOrder={0.5}>
        <sphereGeometry args={[CLOUD_RADIUS, segments, Math.round(segments / 2)]} />
      </mesh>
      <mesh material={high} renderOrder={0.55}>
        <sphereGeometry args={[CIRRUS_RADIUS, segments, Math.round(segments / 2)]} />
      </mesh>
    </>
  );
}

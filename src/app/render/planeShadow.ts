/**
 * The aircraft's shadow on the clouds and the ground: a soft silhouette of the airframe seen from above, cast
 * along the Sun onto each surface by the ground and cloud shaders, where it takes away direct sunlight only. So
 * it fades with the direct light (low Sun, night, under cloud) and the cloud layer's opacity weighs the shadow on
 * the cloud tops against the one on the ground below.
 *
 * The aircraft is an icon hundreds of kilometres long at an exaggerated height that is small beside its length
 * on long legs and large on short ones, so a physically placed shadow would hide under it or land far away.
 * Instead the shadow is cast as if the aircraft flew SHADOW_HEIGHT of its own lengths up at cruise (in
 * proportion while climbing and descending; on the ground it touches the wheels), along a Sun at least
 * SHADOW_LOWEST_SUN high: the plane's own size and shape, never more than about a length away. The higher the
 * aircraft, the softer the shadow: crisp on the ground, more diffuse as it climbs, softest at cruise.
 */
import * as THREE from 'three';
import { type Vec3, cross, dot, length, normalize, scale, smoothstep, sub } from '../../shared/geo/vec';
import type { AircraftType } from '../../shared/scene/aircraft';
import { SLOT, aircraftRadius, airframeModel } from './airframe';

const DEG = Math.PI / 180;

/** Aircraft whose shadows can show at once: two while a connection dissolves types, three on the homepage. */
export const MAX_CASTERS = 3;
/** Share of direct sunlight the shadow takes away at its darkest. */
const SHADOW_DEPTH = 0.75;
/** At cruise, the shadow is cast as if the aircraft flew this many of its own lengths above its parked height. */
const SHADOW_HEIGHT = 0.3;
/** The shadow is cast along a Sun at least this high (radians), so it never strays far from the aircraft. */
const SHADOW_LOWEST_SUN = 27 * DEG;
/** The shadow fades in as the Sun climbs from the horizon to this height (radians), where the light is direct. */
const SHADOW_FULL_SUN = 20 * DEG;
/**
 * The silhouette covers this many aircraft lengths square, centred on the model's origin: spans reach 1.16, and the
 * softest shadow spreads about 0.3 lengths beyond the airframe.
 */
const MASK_EXTENT = 2;
const MASK_SIZE = 160;
/** Samples per texel along each side when rasterizing the silhouette. */
const SUPERSAMPLE = 4;
/**
 * The shadow's three levels of softness, as box blurs (radius in texels, passes): on the ground (a Gaussian of
 * about 0.025 lengths), part way up (0.056), and at cruise (0.11). The shader blends between them by height.
 */
const LEVELS: readonly (readonly [radius: number, passes: number])[] = [
  [2, 2],
  [4, 3],
  [8, 3],
];

/** An aircraft casting a shadow: where it is drawn (as in Aircraft.tsx) and how much of it there is (0–1). */
export interface ShadowCaster {
  type: AircraftType;
  ground: Vec3;
  heading: Vec3;
  altitude: number;
  size: number;
  /** How high it flies, as a share of cruise height: 0 on the ground, 1 at cruise. */
  aloft: number;
  weight: number;
}

/** Separable box blur of a square image, in place. */
function boxBlur(image: Float32Array, size: number, radius: number): void {
  const line = new Float32Array(size);
  for (const [stride, step] of [
    [size, 1],
    [1, size],
  ] as const) {
    for (let row = 0; row < size; row++) {
      for (let i = 0; i < size; i++) line[i] = image[row * stride + i * step]!;
      for (let i = 0; i < size; i++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += line[Math.min(size - 1, Math.max(0, i + k))]!;
        image[row * stride + i * step] = sum / (2 * radius + 1);
      }
    }
  }
}

/**
 * The airframe seen from straight above, as coverage from 0 to 1 on a MASK_SIZE square, unblurred: columns run
 * along the right wing (model x), rows along the nose (model z). Rasterized here rather than by the GPU, so it is
 * the same on every device. Propeller discs are left out: they are faint even on the aircraft.
 */
function coverageOf(type: AircraftType): Float32Array {
  const { geometry } = airframeModel(type);
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex()!;
  const n = MASK_SIZE * SUPERSAMPLE;
  const hit = new Uint8Array(n * n);
  const grid = (v: number) => (v / MASK_EXTENT + 0.5) * n;
  for (const group of geometry.groups) {
    if (group.materialIndex === SLOT.prop) continue;
    for (let k = group.start; k < group.start + group.count; k += 3) {
      const [a, b, c] = [index.getX(k), index.getX(k + 1), index.getX(k + 2)];
      const ax = grid(position.getX(a));
      const ay = grid(position.getZ(a));
      const bx = grid(position.getX(b));
      const by = grid(position.getZ(b));
      const cx = grid(position.getX(c));
      const cy = grid(position.getZ(c));
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-9) continue;
      const s = Math.sign(area);
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const x1 = Math.min(n - 1, Math.ceil(Math.max(ax, bx, cx)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const y1 = Math.min(n - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let y = y0; y <= y1; y++) {
        const py = y + 0.5;
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          if (
            s * ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) >= 0 &&
            s * ((cx - bx) * (py - by) - (cy - by) * (px - bx)) >= 0 &&
            s * ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) >= 0
          ) {
            hit[y * n + x] = 1;
          }
        }
      }
    }
  }
  const coverage = new Float32Array(MASK_SIZE * MASK_SIZE);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (hit[y * n + x]) coverage[Math.floor(y / SUPERSAMPLE) * MASK_SIZE + Math.floor(x / SUPERSAMPLE)]! += 1 / SUPERSAMPLE ** 2;
    }
  }
  return coverage;
}

/** The coverage blurred to one level of softness, from 0 to 255. */
function level(coverage: Float32Array, [radius, passes]: readonly [number, number]): Uint8Array {
  const image = coverage.slice();
  for (let p = 0; p < passes; p++) boxBlur(image, MASK_SIZE, radius);
  return Uint8Array.from(image, (c) => Math.round(255 * Math.min(1, c)));
}

/** The silhouette at its sharpest, as cast on the ground. */
export function silhouette(type: AircraftType): Uint8Array {
  return level(coverageOf(type), LEVELS[0]!);
}

/** All three levels in one image, red the sharpest and blue the softest, so the shader blends them with one read. */
export function shadowLevels(type: AircraftType): Uint8Array {
  const coverage = coverageOf(type);
  const levels = LEVELS.map((l) => level(coverage, l));
  const out = new Uint8Array(MASK_SIZE * MASK_SIZE * 4);
  for (let i = 0; i < MASK_SIZE * MASK_SIZE; i++) {
    out[4 * i] = levels[0]![i]!;
    out[4 * i + 1] = levels[1]![i]!;
    out[4 * i + 2] = levels[2]![i]!;
    out[4 * i + 3] = 255;
  }
  return out;
}

const masks = new Map<AircraftType, THREE.DataTexture>();

/** The silhouette as a texture, made on first use and kept for the life of the page, like the airframe. */
function shadowMask(type: AircraftType): THREE.DataTexture {
  let texture = masks.get(type);
  if (!texture) {
    texture = new THREE.DataTexture(shadowLevels(type), MASK_SIZE, MASK_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.magFilter = texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    masks.set(type, texture);
  }
  return texture;
}

let blank: THREE.DataTexture | null = null;
function blankMask(): THREE.DataTexture {
  if (!blank) {
    blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    blank.needsUpdate = true;
  }
  return blank;
}

const casterSlots = Array.from({ length: MAX_CASTERS }, (_, i) => i);

/** Uniforms for PLANE_SHADOW_GLSL; keep them current with setPlaneShadowUniforms. */
export function planeShadowUniforms(): Record<string, THREE.IUniform> {
  const vectors = () => ({ value: casterSlots.map(() => new THREE.Vector4()) });
  return {
    ...Object.fromEntries(casterSlots.map((i) => [`shadowMask${i}`, { value: blankMask() }])),
    casterUp: vectors(),
    casterRight: vectors(),
    casterForward: vectors(),
    casterLight: vectors(),
    casterBlur: { value: casterSlots.map(() => 0) },
  };
}

/** Point the shadow uniforms at up to MAX_CASTERS aircraft, lit by the Sun in direction `sun` (Earth frame). */
export function setPlaneShadowUniforms(u: Record<string, THREE.IUniform>, casters: readonly ShadowCaster[], sun: Vec3): void {
  const ups = u.casterUp!.value as THREE.Vector4[];
  const rights = u.casterRight!.value as THREE.Vector4[];
  const forwards = u.casterForward!.value as THREE.Vector4[];
  const lights = u.casterLight!.value as THREE.Vector4[];
  const blurs = u.casterBlur!.value as number[];
  for (const i of casterSlots) {
    const c = casters[i];
    const up = c ? normalize(c.ground) : sun;
    const sunHeight = dot(up, sun);
    const strength = c ? SHADOW_DEPTH * c.weight * smoothstep(0, SHADOW_FULL_SUN, Math.asin(sunHeight)) : 0;
    lights[i]!.w = strength;
    u[`shadowMask${i}`]!.value = c && strength > 0 ? shadowMask(c.type) : blankMask();
    if (!c || strength <= 0) continue;
    // Softer the higher it flies: 0 picks the sharpest level, 2 the softest.
    blurs[i] = 2 * Math.min(1, Math.max(0, c.aloft));
    const right = normalize(cross(up, normalize(c.heading)));
    const forward = cross(right, up);
    // Its parked height (as drawn) plus SHADOW_HEIGHT lengths at cruise.
    const height = aircraftRadius(c.type, 0, c.size) - 1 + SHADOW_HEIGHT * c.size * Math.min(1, Math.max(0, c.aloft));
    // Toward the Sun, raised to at least SHADOW_LOWEST_SUN.
    const across = sub(sun, scale(up, sunHeight));
    const away = length(across) > 1e-6 ? normalize(across) : forward;
    const elevation = Math.max(Math.asin(sunHeight), SHADOW_LOWEST_SUN);
    const light = normalize([
      away[0] * Math.cos(elevation) + up[0] * Math.sin(elevation),
      away[1] * Math.cos(elevation) + up[1] * Math.sin(elevation),
      away[2] * Math.cos(elevation) + up[2] * Math.sin(elevation),
    ]);
    // Nothing falls further from the point below the aircraft than its offset plus the silhouette's half diagonal.
    const reach = height / Math.tan(elevation) + (MASK_EXTENT / Math.SQRT2) * c.size;
    ups[i]!.set(up[0], up[1], up[2], height);
    rights[i]!.set(right[0], right[1], right[2], c.size);
    forwards[i]!.set(forward[0], forward[1], forward[2], Math.cos(Math.min(reach, Math.PI)));
    lights[i]!.set(light[0], light[1], light[2], strength);
  }
}

/**
 * planeShadow(n): the share of sunlight left at the ground point n (unit vector, Earth frame) under the aircraft's
 * shadows. Each aircraft's silhouette lies level at its shadow height above the point below it; the shadow is
 * where the ray from n toward the light crosses it. The ground, the cloud tops, and the air over them all take
 * the shadow from this one footprint, so it reads as one shadow wherever the cloud is thin or thick (the cloud
 * tops' own height is small beside the shadow's). One texture read per pixel inside a shadow's reach, none
 * elsewhere.
 */
export const PLANE_SHADOW_GLSL = /* glsl */ `
${casterSlots.map((i) => `uniform sampler2D shadowMask${i};`).join('\n')}
uniform vec4 casterUp[${MAX_CASTERS}];      // xyz: up at the aircraft; w: its shadow height above the ground
uniform vec4 casterRight[${MAX_CASTERS}];   // xyz: toward its right wingtip; w: its length
uniform vec4 casterForward[${MAX_CASTERS}]; // xyz: toward its nose, level; w: cosine of its shadow's reach from below it
uniform vec4 casterLight[${MAX_CASTERS}];   // xyz: toward the light the shadow is cast by; w: strength (0: none)
uniform float casterBlur[${MAX_CASTERS}];   // 0: the sharpest level (on the ground) to 2: the softest (at cruise)

// The silhouette at softness b, between the three levels packed into the mask's red, green and blue.
float casterCover(vec3 levels, float b) {
  return b < 1.0 ? mix(levels.r, levels.g, b) : mix(levels.g, levels.b, b - 1.0);
}

// Where the ground point n falls on aircraft i's silhouette (xy), and how strongly its shadow shows (z; 0: none).
vec3 casterUv(int i, vec3 n) {
  vec4 light = casterLight[i];
  vec4 up = casterUp[i];
  vec4 forward = casterForward[i];
  if (light.w <= 0.0 || dot(n, up.xyz) < forward.w) return vec3(0.0);
  vec3 level = up.xyz * (1.0 + up.w);
  vec3 d = n + light.xyz * (dot(level - n, up.xyz) / dot(light.xyz, up.xyz)) - level;
  vec2 uv = vec2(dot(d, casterRight[i].xyz), dot(d, forward.xyz)) / (casterRight[i].w * ${MASK_EXTENT.toFixed(3)}) + 0.5;
  return vec3(uv, light.w);
}

float planeShadow(vec3 n) {
  float shade = 0.0;
${casterSlots.map((i) => `  vec3 c${i} = casterUv(${i}, n);\n  if (c${i}.z > 0.0) shade += c${i}.z * casterCover(textureLod(shadowMask${i}, c${i}.xy, 0.0).rgb, casterBlur[${i}]);`).join('\n')}
  return 1.0 - min(shade, 1.0);
}
`;

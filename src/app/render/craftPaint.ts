/**
 * Paint for the aircraft and the train, bus, car, and ferry models, lit by craftLight.ts: the Sun, the Moon, the
 * night rig's key and fill, and a two-colour sky (above and below) that also shows in the paint's reflections. The
 * Sun, or after it has set the night key, shades the craft with its own shadow: a small shadow map fitted to the
 * airframe, which only the airframe draws into and only the airframe reads. The ground, clouds, and air keep their own stylized aircraft
 * shadow (planeShadow.ts).
 *
 * Shadow maps come from three.js directional lights of zero intensity, one per light per craft: three.js renders
 * them before the frame, and the paint reads them itself, so no material in the scene is lit by three.js lights.
 * Each craft draws into its own maps only (a layer of its own), so while one type dissolves into the next at a
 * connection, neither shades the other.
 */
import * as THREE from 'three';
import type { Vec3 } from '../../shared/geo/vec';
import { type CraftLight, luminance } from './craftLight';

/**
 * Shadow maps are this many texels square by default (the phone and laptop tiers; tier.ts may ask for more): the
 * airframe's bounding sphere spans them, about 400 texels per length.
 */
export const SHADOW_MAP_SIZE = 512;
/**
 * Soft-shadow radius in texels of a SHADOW_MAP_SIZE map: the Sun's disc gives sharp shadows; the night rig's key is a
 * broad light (12° in the offline renderer), so its shadows are soft. A larger map keeps the same radius on the
 * airframe, in more texels.
 */
const SUN_SHADOW_RADIUS = 1.2;
const KEY_SHADOW_RADIUS = 4;
/** A light this faint (luminance) neither casts nor needs its shadow map. */
const FAINTEST = 0.002;

const paintVertex = /* glsl */ `
// The cloud deck's veil over a craft under it (Clouds.tsx veilMaterial) is drawn where its depth equals this paint's,
// from the same expression: invariant, so the two can't differ.
invariant gl_Position;
uniform mat4 uSunShadowMatrix;
uniform mat4 uKeyShadowMatrix;
uniform float uNormalBias;
varying vec3 vPosition;
varying vec3 vNormalW;
varying vec3 vWorld;
varying vec4 vSunShadow;
varying vec4 vKeyShadow;
#ifdef USE_COLOR
varying vec3 vColor;
#endif
void main() {
  // Object-space position for hashed alpha, as three.js's own materials use.
  vPosition = position;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * normal);
  vNormalW = n;
  vWorld = world.xyz;
  // Looked up a little out along the normal, so lit faces don't shade themselves.
  vec4 offset = vec4(world.xyz + n * uNormalBias, 1.0);
  vSunShadow = uSunShadowMatrix * offset;
  vKeyShadow = uKeyShadowMatrix * offset;
#ifdef USE_COLOR
  vColor = color;
#endif
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const paintFragment = /* glsl */ `
const float PI = 3.14159265;
uniform vec3 diffuse;
uniform float roughness;
uniform float metalness;
uniform float opacity;
uniform vec3 uUp;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform vec3 uMoonDir;
uniform vec3 uMoon;
uniform vec3 uKeyDir;
uniform vec3 uKey;
uniform vec3 uFillDir;
uniform vec3 uFill;
uniform sampler2DShadow uSunShadowMap;
uniform sampler2DShadow uKeyShadowMap;
// x: strength (0 off), y: radius in texels, z: depth bias, w: one texel.
uniform vec4 uSunShadow;
uniform vec4 uKeyShadow;
varying vec3 vPosition;
varying vec3 vNormalW;
varying vec3 vWorld;
varying vec4 vSunShadow;
varying vec4 vKeyShadow;
#ifdef USE_COLOR
varying vec3 vColor;
#endif
#include <alphahash_pars_fragment>

// Eight taps on a disc, each filtered by the hardware's 2 × 2 depth comparison: soft edges with no noise, so the
// shadow is the same on every frame and every device.
const vec2 TAPS[8] = vec2[8](
  vec2(0.125, 0.0), vec2(-0.27, 0.27), vec2(0.0, -0.45), vec2(0.42, 0.42),
  vec2(-0.75, 0.0), vec2(0.0, 0.85), vec2(0.66, -0.66), vec2(-0.6, -0.72)
);

float craftShadow(sampler2DShadow map, vec4 coord, vec4 params) {
  if (params.x <= 0.0) return 1.0;
  vec3 c = coord.xyz / coord.w;
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  c.z += params.z;
  vec2 r = vec2(params.y * params.w);
  float lit = 0.0;
  for (int i = 0; i < 8; i++) lit += texture(map, vec3(c.xy + TAPS[i] * r, c.z));
  return mix(1.0, lit / 8.0, params.x);
}

// One directional light of strength light (what a white surface facing it reads): Lambert diffuse and a GGX lobe
// with Schlick's Fresnel and correlated Smith masking.
vec3 directional(vec3 N, vec3 V, vec3 L, vec3 light, vec3 albedo, vec3 F0, float a2) {
  float nl = dot(N, L);
  if (nl <= 0.0) return vec3(0.0);
  vec3 H = normalize(L + V);
  float nh = max(dot(N, H), 0.0);
  float vh = max(dot(V, H), 0.0);
  float nv = max(dot(N, V), 1e-4);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - vh, 5.0);
  float d = nh * nh * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * d * d);
  float vis = 0.5 / (nl * sqrt(nv * nv * (1.0 - a2) + a2) + nv * sqrt(nl * nl * (1.0 - a2) + a2));
  // Irradiance is pi x light; the diffuse lobe is albedo / pi.
  return light * nl * (albedo * (1.0 - F) + PI * F * D * vis);
}

void main() {
  vec4 diffuseColor = vec4(diffuse, opacity);
#ifdef USE_COLOR
  diffuseColor.rgb *= vColor;
#endif
  #include <alphahash_fragment>
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 albedo = diffuseColor.rgb * (1.0 - metalness);
  vec3 F0 = mix(vec3(0.04), diffuseColor.rgb, metalness);
  float a = roughness * roughness;
  float a2 = a * a;

  vec3 color = directional(N, V, uSunDir, uSun * craftShadow(uSunShadowMap, vSunShadow, uSunShadow), albedo, F0, a2);
  color += directional(N, V, uKeyDir, uKey * craftShadow(uKeyShadowMap, vKeyShadow, uKeyShadow), albedo, F0, a2);
  color += directional(N, V, uMoonDir, uMoon, albedo, F0, a2);
  color += directional(N, V, uFillDir, uFill, albedo, F0, a2);

  // The sky above and what lies below: a white surface reads uSky facing up and uGround facing down.
  float up = dot(N, uUp);
  color += albedo * mix(uGround, uSky, 0.5 + 0.5 * up);
  // ...and the paint reflects them, more toward its edges, blurred by its roughness.
  vec3 R = reflect(-V, N);
  float spread = 0.08 + 0.5 * roughness;
  vec3 seen = mix(uGround, uSky, smoothstep(-spread, spread, dot(R, uUp)));
  float nv = max(dot(N, V), 0.0);
  vec3 F = F0 + (max(vec3(1.0 - roughness), F0) - F0) * pow(1.0 - nv, 5.0);
  color += F * seen;

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Layers 1–31 mark which craft draws into which shadow maps; layer 0 is the camera's. */
const freeLayers = Array.from({ length: 31 }, (_, i) => 31 - i);

/** A zero-intensity directional light whose shadow map holds one craft as seen from one light. */
function shadowLight(layer: number, size: number): THREE.DirectionalLight {
  const light = new THREE.DirectionalLight(0xffffff, 0);
  light.castShadow = false;
  light.shadow.mapSize.set(size, size);
  light.shadow.camera.layers.set(layer);
  light.shadow.autoUpdate = true;
  return light;
}

export interface PaintOptions {
  /** Paint colour (sRGB hex); or white, to be multiplied by vertex colours. */
  color?: THREE.ColorRepresentation;
  vertexColors?: boolean;
  roughness: number;
  metalness: number;
}

/** Shared by every paint of one craft, and set once a frame. */
interface SharedUniforms {
  [name: string]: THREE.IUniform;
}

const v3 = () => ({ value: new THREE.Vector3() });

/**
 * The lights and shadows of one craft (an aircraft, or a vehicle's bodies), for every paint it is drawn with.
 * `root` holds the shadow lights; add it beside the craft, in the same Earth-frame parent.
 */
export class CraftLighting {
  readonly root = new THREE.Object3D();
  private readonly shared: SharedUniforms = {
    opacity: { value: 1 },
    uUp: v3(),
    uSky: v3(),
    uGround: v3(),
    uSunDir: v3(),
    uSun: v3(),
    uMoonDir: v3(),
    uMoon: v3(),
    uKeyDir: v3(),
    uKey: v3(),
    uFillDir: v3(),
    uFill: v3(),
    uSunShadowMap: { value: null },
    uKeyShadowMap: { value: null },
    uSunShadowMatrix: { value: new THREE.Matrix4() },
    uKeyShadowMatrix: { value: new THREE.Matrix4() },
    uSunShadow: { value: new THREE.Vector4() },
    uKeyShadow: { value: new THREE.Vector4() },
    uNormalBias: { value: 0 },
  };
  private readonly materials: THREE.ShaderMaterial[] = [];
  /** The light this frame, in the Earth's frame; turned into world directions as the craft draws. */
  private light: CraftLight | null = null;
  private layer: number | null = null;
  private sunLight: THREE.DirectionalLight | null = null;
  private keyLight: THREE.DirectionalLight | null = null;
  /** Meshes that cast into this craft's shadow maps, once it has them. */
  private readonly casters: THREE.Mesh[] = [];
  private readonly rotation = new THREE.Matrix3();

  /**
   * `shadows`: whether this craft shades itself (the aircraft do; the vehicles, at a few dozen pixels, don't).
   * `shadowMapSize`: texels across each of its shadow maps.
   */
  constructor(
    private readonly shadows: boolean,
    private readonly shadowMapSize: number = SHADOW_MAP_SIZE,
  ) {}

  /**
   * Take a layer and make the shadow lights on the first frame drawn, not when built: React may build a craft and
   * throw it away (twice-run memos in development), and a layer taken then would never come back.
   */
  private ensureShadows(): void {
    if (!this.shadows || this.layer !== null) return;
    const layer = freeLayers.pop();
    if (layer === undefined) return; // All 31 taken: this craft goes without its own shadow.
    this.layer = layer;
    this.sunLight = shadowLight(layer, this.shadowMapSize);
    this.keyLight = shadowLight(layer, this.shadowMapSize);
    this.root.add(this.sunLight, this.sunLight.target, this.keyLight, this.keyLight.target);
    for (const mesh of this.casters) mesh.layers.enable(layer);
  }

  /** A paint lit by this craft's light. Pass `blending` and the like in `extra`. */
  paint(options: PaintOptions, extra: THREE.ShaderMaterialParameters = {}): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...this.shared,
        diffuse: { value: new THREE.Color(options.color ?? 0xffffff) },
        roughness: { value: options.roughness },
        metalness: { value: options.metalness },
      },
      vertexShader: paintVertex,
      fragmentShader: paintFragment,
      vertexColors: options.vertexColors ?? false,
      // Hashed alpha dissolves one craft into the next at a connection without sorting the model's own faces.
      alphaHash: true,
      ...extra,
    });
    this.materials.push(material);
    return material;
  }

  /**
   * Draw `mesh` with this craft's light: it casts into the craft's shadow maps (if `casts`) and turns the light's
   * directions into world space as it draws, so the craft may sit in a rotated globe.
   */
  attach(mesh: THREE.Mesh, casts: boolean): void {
    if (casts && this.shadows) {
      mesh.castShadow = true;
      this.casters.push(mesh);
      if (this.layer !== null) mesh.layers.enable(this.layer);
    }
    mesh.onBeforeRender = () => this.toWorld();
  }

  /**
   * This frame's light, `opacity` (hashed alpha, 0–1), and, for a craft that shades itself, the sphere around it in
   * the Earth frame (centre and radius) that its shadow maps must cover.
   */
  update(light: CraftLight, opacity: number, bounds?: { center: Vec3; radius: number }): void {
    this.light = light;
    if (bounds) this.ensureShadows();
    this.shared.opacity!.value = opacity;
    // At most one shadow map a frame: the Sun's while it shows at all, then the night key's.
    const sunOn = luminance(light.sun) > FAINTEST;
    const keyOn = !sunOn && light.keyShadow > 0 && luminance(light.key) > FAINTEST;
    if (this.sunLight && bounds) this.aim(this.sunLight, light.sunDir, bounds, sunOn);
    if (this.keyLight && bounds) this.aim(this.keyLight, light.keyDir, bounds, keyOn);
    const r = bounds?.radius ?? 0;
    const size = this.shadowMapSize;
    const texel = 1 / size;
    const scale = size / SHADOW_MAP_SIZE;
    (this.shared.uSunShadow!.value as THREE.Vector4).set(sunOn && this.sunLight ? 1 : 0, SUN_SHADOW_RADIUS * scale, -0.0004, texel);
    (this.shared.uKeyShadow!.value as THREE.Vector4).set(keyOn && this.keyLight ? light.keyShadow : 0, KEY_SHADOW_RADIUS * scale, -0.0004, texel);
    // About one texel of the map, in world units.
    this.shared.uNormalBias!.value = (2 * r) / size;
  }

  /** Fit a light's shadow camera around the craft, looking along the light. */
  private aim(light: THREE.DirectionalLight, toward: Vec3, { center, radius }: { center: Vec3; radius: number }, on: boolean): void {
    light.castShadow = on;
    if (!on) return;
    const distance = 2 * radius;
    light.position.set(center[0] + toward[0] * distance, center[1] + toward[1] * distance, center[2] + toward[2] * distance);
    light.target.position.set(center[0], center[1], center[2]);
    const camera = light.shadow.camera;
    camera.left = camera.bottom = -radius;
    camera.right = camera.top = radius;
    camera.near = distance - 1.05 * radius;
    camera.far = distance + 1.05 * radius;
    camera.updateProjectionMatrix();
    // The camera's roll doesn't matter for a sphere; it only needs an up that isn't along the light.
    const world = new THREE.Vector3(toward[0], toward[1], toward[2]).applyMatrix3(this.rotation.setFromMatrix4(this.root.matrixWorld));
    camera.up.set(Math.abs(world.y) < 0.9 ? 0 : 1, Math.abs(world.y) < 0.9 ? 1 : 0, 0);
  }

  /** Set the light's world-space directions and the shadow maps three.js has just rendered. */
  private toWorld(): void {
    const light = this.light;
    if (!light) return;
    const m = this.rotation.setFromMatrix4(this.root.matrixWorld);
    const u = this.shared;
    const dir = (name: string, v: Vec3) => (u[name]!.value as THREE.Vector3).set(v[0], v[1], v[2]).applyMatrix3(m).normalize();
    const rgb = (name: string, c: readonly number[]) => (u[name]!.value as THREE.Vector3).set(c[0]!, c[1]!, c[2]!);
    dir('uUp', light.up);
    dir('uSunDir', light.sunDir);
    dir('uMoonDir', light.moonDir);
    dir('uKeyDir', light.keyDir);
    dir('uFillDir', light.fillDir);
    rgb('uSun', light.sun);
    rgb('uMoon', light.moon);
    rgb('uKey', light.key);
    rgb('uFill', light.fill);
    rgb('uSky', light.sky);
    rgb('uGround', light.ground);
    for (const [map, matrix, source] of [
      ['uSunShadowMap', 'uSunShadowMatrix', this.sunLight],
      ['uKeyShadowMap', 'uKeyShadowMatrix', this.keyLight],
    ] as const) {
      u[map]!.value = source?.castShadow ? (source.shadow.map?.depthTexture ?? null) : null;
      if (source) (u[matrix]!.value as THREE.Matrix4).copy(source.shadow.matrix);
    }
    const sunMap = u.uSunShadowMap!.value;
    const keyMap = u.uKeyShadowMap!.value;
    if (!sunMap) (u.uSunShadow!.value as THREE.Vector4).x = 0;
    if (!keyMap) (u.uKeyShadow!.value as THREE.Vector4).x = 0;
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    for (const l of [this.sunLight, this.keyLight]) l?.shadow.dispose();
    if (this.layer !== null) freeLayers.push(this.layer);
    this.layer = null;
  }
}

/** Shadow maps render only while the renderer allows it; React Three Fiber turns them off unless its Canvas asks. */
export function enableCraftShadows(gl: THREE.WebGLRenderer): void {
  if (!gl.shadowMap.enabled) gl.shadowMap.enabled = true;
  if (gl.shadowMap.type !== THREE.PCFShadowMap) gl.shadowMap.type = THREE.PCFShadowMap;
}

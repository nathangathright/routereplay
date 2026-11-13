import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { type Vec3, cross, dot, normalize, smoothstep } from '../../shared/geo/vec';
import { TOWER, towerModel } from './towerModel';

const DEG = Math.PI / 180;
/** Albedo at night and by day, as the vehicles' (drawn, like them, after the atmosphere). */
const NIGHT_TINT = new THREE.Color(0.16, 0.18, 0.24);
const DAY_TINT = new THREE.Color(1.2, 1.2, 1.2);
/** Where the tower stands: just above the ground, under the route ribbon (1.0015). */
const BASE = 1.0002;
/**
 * The tower is drawn at full height but takes its depth from a copy squashed into the shell from BASE to here: above
 * the ground, below a parked aircraft's lowest point (1.0015) and a vehicle's (1.0016). So the aircraft and vehicles
 * always cover it, as the offline renderer restores the aircraft over its airport markers, while the tower still
 * hides its own far side.
 */
const DEPTH_TOP = 1.0012;
/** Draw order: after the route (2–3) and the arrival rings (7), before the vehicles (10.35–10.6) and the panels (20). */
const ORDER = { shadow: 7.8, body: 8, lamps: 8.5 };
/**
 * The shadow is cast along a Sun between these heights, so it always reaches out from under the cab (at least one
 * tower height, as a cue to its height) and never strays far; it fades in as the Sun climbs to SHADOW_FULL_SUN.
 * Like the aircraft's shadow (planeShadow.ts), it is placed for legibility rather than physically.
 */
const SHADOW_LOWEST_SUN = 27 * DEG;
const SHADOW_HIGHEST_SUN = 45 * DEG;
const SHADOW_FULL_SUN = 20 * DEG;
const SHADOW_ALPHA = 0.7;
/** The shadow quad's half size: the longest shadow (height ÷ tan 27°) plus the cab's radius and the blur. */
const SHADOW_EXTENT = TOWER.height / Math.tan(SHADOW_LOWEST_SUN) + TOWER.gallery.r + 0.004;
/** The roof before the aircraft arrives, and after: the offline renderer's airport-marker colours. */
export const ROOF_AHEAD = new THREE.Color().setRGB(171 / 255, 200 / 255, 206 / 255, THREE.SRGBColorSpace);
export const ROOF_REACHED = new THREE.Color().setRGB(255 / 255, 169 / 255, 116 / 255, THREE.SRGBColorSpace);
const GLASS = new THREE.Color('#2b465c');
const CAB_LIGHT = new THREE.Color('#ffb873');

/** Take the depth of a squashed copy: `transformed` with its height scaled by uSquash. */
const SQUASH = /* glsl */ `
{
  vec4 squashed = projectionMatrix * viewMatrix * modelMatrix * vec4(transformed.x, transformed.y * uSquash, transformed.z, 1.0);
  gl_Position.z = squashed.z / squashed.w * gl_Position.w;
}
`;

function squashDepth(m: THREE.Material, squash: { value: number }) {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSquash = squash;
    shader.vertexShader = `uniform float uSquash;\n${shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>\n${SQUASH}`)}`;
  };
}

const lampVertex = /* glsl */ `
uniform float uNight;
uniform float uShortSide;
uniform float uTime;
uniform float uSquash;
attribute vec3 color;
attribute float aSize;
attribute float aKind;
varying vec3 vColor;
void main() {
  float intensity = 1.0;
  if (aKind > 0.5) {
    // The rotating airport beacon: a white flash, then a green one half a turn later, every 2 s.
    float p = fract(uTime / 2.0 + (aKind > 1.5 ? 0.5 : 0.0)) / 0.16;
    float s = sin(3.14159265 * min(p, 1.0));
    intensity = p < 1.0 ? s * s : 0.0;
  }
  vColor = color * intensity * uNight;
  gl_PointSize = aSize * uShortSide;
  vec3 transformed = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  ${SQUASH}
}
`;

const lampFragment = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  gl_FragColor = vec4(vColor * exp(-dot(p, p) * 24.0), 1.0);
  #include <colorspace_fragment>
}
`;

const f = (x: number) => x.toFixed(5);

/**
 * The tower's shadow on the ground, cast along the Sun: the union of the base building's footprint swept up its
 * height, and the shaft, cab, and mast, each displaced by `uLean` per unit of height. Soft-edged, in the model's
 * units (x east, z south).
 */
const shadowVertex = /* glsl */ `
varying vec2 vXZ;
void main() {
  vXZ = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const shadowFragment = /* glsl */ `
uniform vec2 uLean;
uniform float uAlpha;
uniform float uSoft;
varying vec2 vXZ;
float box(vec2 p, vec2 c, vec2 h) {
  vec2 d = abs(p - c) - h;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
float capsule(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
void main() {
  float baseH = ${f(TOWER.base.y1)};
  vec2 c = vec2(${f((TOWER.base.x0 + TOWER.base.x1) / 2)}, ${f((TOWER.base.z0 + TOWER.base.z1) / 2)});
  vec2 h = vec2(${f((TOWER.base.x1 - TOWER.base.x0) / 2)}, ${f((TOWER.base.z1 - TOWER.base.z0) / 2)});
  float d = box(vXZ, c + 0.5 * baseH * uLean, h + 0.5 * baseH * abs(uLean));
  d = min(d, capsule(vXZ, vec2(0.0), uLean * ${f(TOWER.shaft.y1)}, ${f(TOWER.shaft.r)}));
  d = min(d, capsule(vXZ, uLean * ${f(TOWER.gallery.y0)}, uLean * ${f(TOWER.roof.y1)}, ${f(TOWER.gallery.r)}));
  d = min(d, capsule(vXZ, uLean * ${f(TOWER.roof.y1)}, uLean * ${f(TOWER.beacon.y1)}, ${f(TOWER.beacon.r)}));
  float a = uAlpha * (1.0 - smoothstep(-uSoft, uSoft, d));
  if (a <= 0.002) discard;
  gl_FragColor = vec4(0.031, 0.047, 0.086, a);
  #include <colorspace_fragment>
}
`;

interface Kit {
  root: THREE.Object3D;
  body: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  lamps: THREE.ShaderMaterial;
  lampPoints: THREE.Points;
  shadow: THREE.ShaderMaterial;
  shadowGeometry: THREE.PlaneGeometry;
  squash: { value: number };
}

function buildKit(): Kit {
  const model = towerModel();
  const squash = { value: 1 };
  // Hashed alpha dissolves the tower in and out without sorting faces, as on the vehicles. `transparent` only to
  // draw in order with the labels; the blending writes colour opaquely.
  const paint = (opts: THREE.MeshStandardMaterialParameters) => {
    const m = new THREE.MeshStandardMaterial({
      flatShading: true,
      alphaHash: true,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      ...opts,
    });
    squashDepth(m, squash);
    return m;
  };
  const body = paint({ vertexColors: true, roughness: 0.75, metalness: 0 });
  const glass = paint({ color: GLASS, roughness: 0.2, metalness: 0.5 });
  const roof = paint({ roughness: 0.6, metalness: 0 });
  const lamps = new THREE.ShaderMaterial({
    uniforms: { uNight: { value: 0 }, uShortSide: { value: 1 }, uTime: { value: 0 }, uSquash: squash },
    vertexShader: lampVertex,
    fragmentShader: lampFragment,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const shadow = new THREE.ShaderMaterial({
    uniforms: { uLean: { value: new THREE.Vector2() }, uAlpha: { value: 0 }, uSoft: { value: 0.002 } },
    vertexShader: shadowVertex,
    fragmentShader: shadowFragment,
    transparent: true,
    depthWrite: false,
  });
  const root = new THREE.Object3D();
  root.matrixAutoUpdate = false;
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, order: number) => {
    const o = new THREE.Mesh(g, m);
    o.renderOrder = order;
    o.frustumCulled = false;
    root.add(o);
    return o;
  };
  const shadowGeometry = new THREE.PlaneGeometry(2 * SHADOW_EXTENT, 2 * SHADOW_EXTENT).rotateX(-Math.PI / 2);
  mesh(shadowGeometry, shadow, ORDER.shadow);
  mesh(model.body, body, ORDER.body);
  mesh(model.glass, glass, ORDER.body);
  mesh(model.roof, roof, ORDER.body);
  const lampPoints = new THREE.Points(model.lamps, lamps);
  lampPoints.renderOrder = ORDER.lamps;
  lampPoints.frustumCulled = false;
  root.add(lampPoints);
  return { root, body, glass, roof, lamps, lampPoints, shadow, shadowGeometry, squash };
}

/**
 * An air-traffic-control tower on an airport (`position`, a unit vector), a constant size on screen. Lit by the
 * Sun (`sun`), with a shadow cast away from it by day, and lamps after dusk: the cab's windows and the rotating
 * beacon, timed by `time` (presentation seconds). The roof turns from blue-grey to the accent when the aircraft
 * has `reached` the airport. `opacity` below 1 dissolves it.
 */
export function Tower({
  position,
  sun,
  reached,
  opacity,
  time,
}: {
  position: Vec3;
  sun: Vec3;
  reached: boolean;
  opacity: number;
  time: number;
}) {
  const kit = useMemo(buildKit, []);
  const camera = useThree((s) => s.camera);
  const shortSidePx = useThree((s) => Math.min(s.size.width, s.size.height) * s.gl.getPixelRatio());
  useEffect(
    () => () => {
      kit.body.dispose();
      kit.glass.dispose();
      kit.roof.dispose();
      kit.lamps.dispose();
      kit.shadow.dispose();
      kit.shadowGeometry.dispose();
    },
    [kit],
  );

  // Local axes: x east, y up, z south.
  const up = position;
  const east = normalize(cross([0, 1, 0], up), [0, 0, -1]);
  const south = cross(east, up);
  // One model unit is the frame's short side at the tower's distance along the view, so its size on screen holds.
  const eye = camera.position;
  const along = -(
    (up[0] * BASE - eye.x) * eye.x +
    (up[1] * BASE - eye.y) * eye.y +
    (up[2] * BASE - eye.z) * eye.z
  ) / eye.length();
  const size = Math.max(along, 1e-6) * 2 * Math.tan(35 * DEG);
  const m = kit.root.matrix;
  m.makeBasis(new THREE.Vector3(...east), new THREE.Vector3(...up), new THREE.Vector3(...south));
  m.scale(new THREE.Vector3(size, size, size));
  m.setPosition(up[0] * BASE, up[1] * BASE, up[2] * BASE);
  kit.root.matrixWorldNeedsUpdate = true;
  kit.squash.value = (DEPTH_TOP - BASE) / (TOWER.height * size);

  const sunHeight = dot(up, sun);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sunHeight)));
  const sunlit = smoothstep(-0.5 * DEG, 0.5 * DEG, elevation);
  const tint = NIGHT_TINT.clone().lerp(DAY_TINT, sunlit);
  const night = 1 - smoothstep(Math.sin(-12 * DEG), Math.sin(-2 * DEG), sunHeight);
  const state = reached ? ROOF_REACHED : ROOF_AHEAD;
  kit.body.color.copy(tint);
  kit.glass.color.copy(GLASS).multiply(tint);
  kit.glass.emissive.copy(CAB_LIGHT).multiplyScalar(0.55 * night);
  kit.roof.color.copy(state).multiply(tint);
  // The roof's colour stays readable at night, as if floodlit.
  kit.roof.emissive.copy(state).multiplyScalar(0.3 * night);
  for (const mat of [kit.body, kit.glass, kit.roof]) mat.opacity = opacity;

  const u = kit.lamps.uniforms;
  u.uNight!.value = night * opacity;
  u.uShortSide!.value = shortSidePx;
  u.uTime!.value = time;
  kit.lampPoints.visible = night * opacity > 0.002;

  // The shadow falls away from the Sun, as long as the tower is tall over tan(elevation), with the elevation held
  // between SHADOW_LOWEST_SUN and SHADOW_HIGHEST_SUN.
  const horizontal = new THREE.Vector2(dot(sun, east), dot(sun, south));
  const reach = 1 / Math.tan(Math.min(Math.max(elevation, SHADOW_LOWEST_SUN), SHADOW_HIGHEST_SUN));
  if (horizontal.lengthSq() > 1e-12) horizontal.normalize().multiplyScalar(-reach);
  kit.shadow.uniforms.uLean!.value.copy(horizontal);
  kit.shadow.uniforms.uAlpha!.value = SHADOW_ALPHA * smoothstep(0, SHADOW_FULL_SUN, elevation) * opacity;

  return <primitive object={kit.root} />;
}

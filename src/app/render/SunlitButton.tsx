import { useFrame, useThree } from '@react-three/fiber';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { moonPosition } from '../../shared/geo/solar';
import { type Vec3, normalize, scale, sub } from '../../shared/geo/vec';
import {
  EARTH_LIGHT,
  EARTH_WRAP,
  type LabelTone,
  MOON_LIGHT,
  PAINT_ALBEDO,
  STARLIGHT,
  earthPhase,
  faceLuminance,
  labelTone,
  moonPhase,
  sunlightAt,
} from './sunlight';

const glsl3 = (c: readonly number[]) => `vec3(${c.map((x) => x.toFixed(4)).join(', ')})`;

const vertex = /* glsl */ `
uniform vec4 uRect;
uniform vec2 uResolution;
varying vec2 vPx;
void main() {
  // A quad just larger than the button, in drawing-buffer pixels.
  vPx = mix(uRect.xy - 2.0, uRect.zw + 2.0, uv);
  gl_Position = vec4(vPx / uResolution * 2.0 - 1.0, 0.0, 1.0);
}
`;

const fragment = /* glsl */ `
uniform vec4 uRect;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform vec3 uEarthDir;
uniform vec3 uEarthColor;
uniform vec2 uTilt;
uniform float uPress;
uniform float uAlpha;
varying vec2 vPx;

const vec3 ALBEDO = vec3(${PAINT_ALBEDO.toFixed(4)});
const vec3 STARLIGHT = ${glsl3(STARLIGHT)};
const float EARTH_WRAP = ${EARTH_WRAP.toFixed(4)};

// Clear-coated paint: a GGX lobe with Schlick Fresnel and Kelemen's visibility approximation.
vec3 lit(vec3 N, vec3 V, vec3 L, vec3 color, float gloss) {
  float nl = dot(N, L);
  if (nl <= 0.0) return vec3(0.0);
  vec3 H = normalize(L + V);
  float nh = max(dot(N, H), 0.0);
  float vh = max(dot(V, H), 0.05);
  const float a2 = 0.0144; // roughness 0.12
  float d = nh * nh * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159265 * d * d);
  float F = 0.04 + 0.96 * pow(1.0 - vh, 5.0);
  float specular = F * D * 0.25 / (vh * vh);
  return color * nl * (ALBEDO * (1.0 - F) + specular * gloss);
}

void main() {
  vec2 centre = (uRect.xy + uRect.zw) * 0.5;
  vec2 halfSize = (uRect.zw - uRect.xy) * 0.5;
  float r = halfSize.y;
  vec2 p = vPx - centre;
  // Capsule: q runs from the nearest point on the core segment to this pixel.
  vec2 q = vec2(sign(p.x) * max(abs(p.x) - (halfSize.x - r), 0.0), p.y);
  float dist = length(q) - r; // negative inside
  float coverage = clamp(0.5 - dist, 0.0, 1.0);
  if (coverage <= 0.0) discard;

  // A flat face with a rounded (quarter-circle) bevel around it, flattened a little when pressed.
  float bevel = r * 0.62;
  float t = clamp(1.0 + dist / bevel, 0.0, 1.0) * (1.0 - 0.35 * uPress);
  vec2 outward = length(q) > 1e-3 ? q / length(q) : vec2(0.0, 1.0);
  vec3 N = normalize(vec3(outward * t, sqrt(max(1.0 - t * t, 0.0))) + vec3(uTilt * 0.12, 0.0));
  vec3 V = vec3(0.0, 0.0, 1.0);

  vec3 color = ALBEDO * STARLIGHT;
  color += lit(N, V, uSunDir, uSunColor, 1.0);
  color += lit(N, V, uMoonDir, uMoonColor, 3.0);
  // Earthlight, from the planet behind the button: it reaches the lower rim.
  color += ALBEDO * uEarthColor * max((dot(N, uEarthDir) + EARTH_WRAP) / (1.0 + EARTH_WRAP), 0.0);
  // A faint cool edge so the silhouette survives with no light at all.
  color += STARLIGHT * 1.5 * pow(t, 4.0);
  color *= 1.0 - 0.06 * uPress;

  gl_FragColor = vec4(min(color, vec3(1.0)), coverage * uAlpha);
  #include <colorspace_fragment>
}
`;

const toVec3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

/**
 * Paints the landing page's button as a physical object floating in front of the camera, lit by the scene:
 * the real Sun (dimmed and reddened as it sets behind the Earth, gone while the planet eclipses it), the Moon at
 * its real phase, and blue earthlight from below. The DOM button stays the real control and keeps its label;
 * this draws the body underneath it, and switches the label between dark and light to stay readable.
 *
 * `sun` is in the Earth's frame and `globe` is the group that turns the Earth's frame into the scene. The body fades
 * with the CSS opacity of `fade` (the hero around the button), which a transition can't apply to the canvas.
 */
export function SunlitButton({
  target,
  fade,
  globe,
  sun,
  utcMs,
  sunVisible,
}: {
  target: RefObject<HTMLElement | null>;
  fade?: RefObject<HTMLElement | null>;
  globe: RefObject<THREE.Group | null>;
  sun: Vec3;
  utcMs: number;
  sunVisible: number;
}) {
  const { camera, gl, invalidate } = useThree();
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uRect: { value: new THREE.Vector4() },
          uResolution: { value: new THREE.Vector2(1, 1) },
          uSunDir: { value: new THREE.Vector3() },
          uSunColor: { value: new THREE.Vector3() },
          uMoonDir: { value: new THREE.Vector3() },
          uMoonColor: { value: new THREE.Vector3() },
          uEarthDir: { value: new THREE.Vector3() },
          uEarthColor: { value: new THREE.Vector3() },
          uTilt: { value: new THREE.Vector2() },
          uPress: { value: 0 },
          uAlpha: { value: 1 },
        },
        vertexShader: vertex,
        fragmentShader: fragment,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    [],
  );
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  // The latest scene state, read in the frame loop.
  const latest = useRef({ sun, utcMs, sunVisible });
  latest.current = { sun, utcMs, sunVisible };
  const pointer = useRef({ x: 0, y: 0, over: false, down: false });
  const eased = useRef({ x: 0, y: 0, press: 0 });
  const tone = useRef<LabelTone | null>(null);

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const p = pointer.current;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      p.x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      p.y = Math.max(-1, Math.min(1, 1 - ((e.clientY - r.top) / r.height) * 2));
      p.over = true;
      invalidate();
    };
    const leave = () => {
      p.over = p.down = false;
      invalidate();
    };
    const down = () => {
      p.down = true;
      invalidate();
    };
    const up = () => {
      p.down = false;
      invalidate();
    };
    el.addEventListener('pointerenter', move);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', leave);
    return () => {
      el.removeEventListener('pointerenter', move);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', leave);
      delete el.dataset.sunlit;
      delete el.dataset.tone;
    };
  }, [target, invalidate]);

  const tmp = useMemo(() => ({ v: new THREE.Vector3(), cam: new THREE.Vector3() }), []);
  const mesh = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    const el = target.current;
    const g = globe.current;
    if (!el || !g) return;
    const u = material.uniforms;
    const alpha = fade?.current ? Number(getComputedStyle(fade.current).opacity) : 1;
    u.uAlpha!.value = alpha;
    if (mesh.current) mesh.current.visible = alpha > 0.001;

    // Where the button is, in the canvas's drawing-buffer pixels (origin bottom left).
    const canvas = gl.domElement;
    const c = canvas.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    if (c.width <= 0 || c.height <= 0 || b.width <= 0) return;
    const sx = canvas.width / c.width;
    const sy = canvas.height / c.height;
    (u.uRect!.value as THREE.Vector4).set((b.left - c.left) * sx, (c.bottom - b.bottom) * sy, (b.right - c.left) * sx, (c.bottom - b.top) * sy);
    (u.uResolution!.value as THREE.Vector2).set(canvas.width, canvas.height);

    // The lights, from the Earth's frame into view space (the button faces the viewer along +z).
    const { sun: s, utcMs: utc, sunVisible: visible } = latest.current;
    const observer = toVec3(g.worldToLocal(tmp.cam.copy(camera.position)));
    const toView = (out: THREE.Vector3, d: Vec3) =>
      out.set(d[0], d[1], d[2]).transformDirection(g.matrixWorld).transformDirection(camera.matrixWorldInverse);
    const moon = moonPosition(utc);
    const sunColor = sunlightAt(observer, s, visible);
    const moonColor = scale(MOON_LIGHT, moonPhase(observer, moon, s));
    const earthColor = scale(EARTH_LIGHT, earthPhase(observer, s));
    const sunDir = toView(u.uSunDir!.value as THREE.Vector3, s);
    const moonDir = toView(u.uMoonDir!.value as THREE.Vector3, normalize(sub(moon, observer)));
    const earthDir = toView(u.uEarthDir!.value as THREE.Vector3, normalize(scale(observer, -1)));
    (u.uSunColor!.value as THREE.Vector3).set(...sunColor);
    (u.uMoonColor!.value as THREE.Vector3).set(...moonColor);
    (u.uEarthColor!.value as THREE.Vector3).set(...earthColor);

    // Hovering tips the face toward the pointer; pressing flattens it.
    const p = pointer.current;
    const e = eased.current;
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * 14);
    e.x += ((p.over ? p.x : 0) - e.x) * k;
    e.y += ((p.over ? p.y : 0) - e.y) * k;
    e.press += ((p.down ? 1 : 0) - e.press) * k;
    (u.uTilt!.value as THREE.Vector2).set(e.x, e.y);
    u.uPress!.value = e.press;
    const settling = Math.abs((p.over ? p.x : 0) - e.x) + Math.abs((p.over ? p.y : 0) - e.y) + Math.abs((p.down ? 1 : 0) - e.press) > 0.002;
    if (settling) invalidate(); // keeps easing when the globe only renders on demand

    const face = faceLuminance({ sun: sunColor, sunZ: sunDir.z, moon: moonColor, moonZ: moonDir.z, earth: earthColor, earthZ: earthDir.z });
    const next = labelTone(face, tone.current);
    if (next !== tone.current) {
      tone.current = next;
      el.dataset.tone = next;
    }
    if (el.dataset.sunlit !== 'true') el.dataset.sunlit = 'true';
  });

  return <mesh ref={mesh} geometry={geometry} material={material} frustumCulled={false} renderOrder={1000} />;
}

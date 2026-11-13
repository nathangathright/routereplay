import { useThree } from '@react-three/fiber';
import { useMemo } from 'react';
import * as THREE from 'three';
import { normalize, scale, sub } from '../../shared/geo/vec';
import { type Timeline, displayAltitude } from '../../shared/timeline/evaluate';

/*
 * The flown route as the offline renderer draws it (routereplay `scene_overlays.route`): only the part already
 * travelled, a 5-pixel line in its accent colour over a 16-pixel line of 59 % opacity blurred by a Gaussian of
 * 11 pixels. Widths are pixels of a 1080-pixel short side, scaled to the screen's, so the line keeps its width at
 * every zoom. Train, bus, car, and ferry legs draw the line as dots, as storyboard sketches do.
 */

/** The accent, an electric blue (46, 140, 255); the offline renderer's is a peach, (255, 169, 116). */
const ROUTE_COLOR = '#2e8cff';
const CORE_HALF = 2.5;
const GLOW_HALF = 8;
const GLOW_SIGMA = 11;
const GLOW_ALPHA = 150 / 255;
/** Reach of the glow beyond the line's centre, where its profile has fallen under 0.2 %. */
const GLOW_EXTENT = GLOW_HALF + 3 * GLOW_SIGMA;
/** Ground legs: 6-pixel dots every 12 pixels at the airports' zoom (4742 pixels per radian). */
const DOT_RADIUS = 3;
const DOT_SPACING_RAD = 12 / 4742;
/** The glow's sample spacing: about 20 pixels at the airports' zoom. */
const GLOW_SAMPLE_RAD = 20 / 4742;

const vertex = /* glsl */ `
attribute vec3 tangent;
attribute float sideSign;
attribute float along;
attribute float alongRad;
attribute float cap;
uniform vec2 buffer;
uniform float halfWidth;
varying float vAlong;
varying float vAlongRad;
varying float vAcross;
varying float vBeyond;
varying float vPxPerRad;
void main() {
  vAlong = along;
  vAlongRad = alongRad;
  mat4 m = projectionMatrix * modelViewMatrix;
  vec4 c = m * vec4(position, 1.0);
  vec4 n = m * vec4(position + tangent * 1e-3, 1.0);
  vec2 s0 = c.xy / c.w * buffer * 0.5;
  vec2 s1 = n.xy / n.w * buffer * 0.5;
  vec2 d = s1 - s0;
  float len = max(length(d), 1e-6);
  vec2 dir = d / len;
  vPxPerRad = len / 1e-3;
  vAcross = sideSign * halfWidth;
  vBeyond = abs(cap) * halfWidth;
  vec2 offset = vec2(-dir.y, dir.x) * vAcross + dir * cap * halfWidth;
  c.xy += offset / (buffer * 0.5) * c.w;
  gl_Position = c;
}
`;

const fragment = /* glsl */ `
uniform float progress;
uniform float glow;
uniform float dotted;
uniform vec3 color;
uniform float pxPerRef;
varying float vAlong;
varying float vAlongRad;
varying float vAcross;
varying float vBeyond;
varying float vPxPerRad;

// Abramowitz and Stegun 7.1.26, within 1.5e-7.
float erf1(float x) {
  float s = sign(x);
  float a = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * a);
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
  return s * y;
}

void main() {
  if (vAlong > progress) discard;
  float a;
  vec3 rgb = color;
  if (glow > 0.5) {
    // A 16-pixel line blurred by a Gaussian: the box's profile across, and a soft round end.
    float k = 1.0 / (${GLOW_SIGMA.toFixed(1)} * pxPerRef * 1.41421356);
    float h = ${GLOW_HALF.toFixed(1)} * pxPerRef;
    float p = 0.5 * (erf1((vAcross + h) * k) - erf1((vAcross - h) * k));
    p *= 1.0 - erf1(vBeyond * k);
    // Pillow blurs colour and alpha separately, so the glow's colour dims with its alpha.
    rgb *= p;
    a = ${GLOW_ALPHA.toFixed(6)} * p;
  } else {
    if (vBeyond > 0.0) discard;
    float across = abs(vAcross);
    if (dotted > 0.5) {
      float spacing = ${DOT_SPACING_RAD.toExponential(6)};
      float along = (fract(vAlongRad / spacing) - 0.5) * spacing * vPxPerRad;
      a = clamp(${DOT_RADIUS.toFixed(1)} * pxPerRef + 0.5 - length(vec2(along, across)), 0.0, 1.0);
    } else {
      a = clamp(${CORE_HALF.toFixed(1)} * pxPerRef + 0.5 - across, 0.0, 1.0);
    }
  }
  if (a <= 0.002) discard;
  gl_FragColor = sRGBTransferEOTF(vec4(rgb, a));
  #include <colorspace_fragment>
}
`;

const evenFractions = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);

/** Evenly spaced fractions along a track, plus its corners so a looked-up route keeps its shape. */
function sampleFractions(angle: number, corners: readonly number[]): number[] {
  const even = evenFractions(Math.max(48, Math.ceil(angle * 160)));
  if (corners.length === 0) return even;
  const all = [...even, ...corners].sort((a, b) => a - b);
  return all.filter((f, i) => i === 0 || f - all[i - 1]! > 1e-9);
}

/**
 * A ribbon along a leg, widened on screen by the vertex shader, with a cap quad at each end for the glow. The line
 * follows every corner of a looked-up route. The glow, 80 pixels wide, follows it smoothly instead: evenly spaced
 * samples about 20 pixels apart at the airports' zoom, turned along the chord through their neighbours, so a winding
 * road doesn't fold the wide ribbon over itself.
 */
function legGeometry(tl: Timeline, index: number, glow: boolean): THREE.BufferGeometry {
  const leg = tl.legs[index]!;
  const track = leg.track;
  const fractions = glow ? evenFractions(Math.max(2, Math.ceil(track.angle / GLOW_SAMPLE_RAD))) : sampleFractions(track.angle, track.corners);
  const step = 1 / (fractions.length - 1);
  const direction = (f: number) =>
    glow ? normalize(sub(track.at(Math.min(1, f + step)), track.at(Math.max(0, f - step)))) : normalize(track.tangent(f));
  // Stations along the ribbon: the first and last repeat as the caps' outer edges.
  const stations = [{ f: 0, cap: -1 }, ...fractions.map((f) => ({ f, cap: 0 })), { f: 1, cap: 1 }];
  const count = stations.length * 2;
  const position = new Float32Array(count * 3);
  const tangent = new Float32Array(count * 3);
  const sideSign = new Float32Array(count);
  const along = new Float32Array(count);
  const alongRad = new Float32Array(count);
  const cap = new Float32Array(count);
  stations.forEach(({ f, cap: c }, i) => {
    const p = scale(track.at(f), 1.0015 + displayAltitude(leg.cruise, f));
    const t = direction(f);
    for (let k = 0; k < 2; k++) {
      const j = i * 2 + k;
      position.set(p, j * 3);
      tangent.set(t, j * 3);
      sideSign[j] = k === 0 ? -1 : 1;
      along[j] = f;
      alongRad[j] = f * track.angle;
      cap[j] = c;
    }
  });
  const indices: number[] = [];
  for (let i = 0; i < stations.length - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('tangent', new THREE.BufferAttribute(tangent, 3));
  g.setAttribute('sideSign', new THREE.BufferAttribute(sideSign, 1));
  g.setAttribute('along', new THREE.BufferAttribute(along, 1));
  g.setAttribute('alongRad', new THREE.BufferAttribute(alongRad, 1));
  g.setAttribute('cap', new THREE.BufferAttribute(cap, 1));
  g.setIndex(indices);
  g.computeBoundingSphere();
  return g;
}

function routeMaterial(glow: boolean, dotted: boolean, buffer: THREE.Vector2) {
  return new THREE.ShaderMaterial({
    uniforms: {
      progress: { value: 0 },
      glow: { value: glow ? 1 : 0 },
      dotted: { value: dotted ? 1 : 0 },
      color: { value: new THREE.Color(ROUTE_COLOR).convertLinearToSRGB() },
      halfWidth: { value: 1 },
      pxPerRef: { value: 1 },
      buffer: { value: buffer },
    },
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Each leg's flown part, up to the aircraft: a glow, then the line (dotted on the ground) over it. */
export function Routes({ timeline, trail }: { timeline: Timeline; trail: number[] }) {
  const gl = useThree((s) => s.gl);
  // Re-render on resize; the drawing buffer's size is read below.
  useThree((s) => s.size);
  const buffer = useMemo(() => new THREE.Vector2(), []);
  gl.getDrawingBufferSize(buffer);
  const pxPerRef = Math.min(buffer.x, buffer.y) / 1080;
  const legs = useMemo(
    () =>
      timeline.legs.map((leg, i) => ({
        glowGeometry: legGeometry(timeline, i, true),
        lineGeometry: legGeometry(timeline, i, false),
        glow: routeMaterial(true, false, buffer),
        line: routeMaterial(false, leg.mode !== null, buffer),
      })),
    [timeline, buffer],
  );
  return (
    <group>
      {legs.map((l, i) => {
        const progress = trail[i] ?? 0;
        if (progress <= 0) return null;
        for (const [m, half] of [
          [l.glow, GLOW_EXTENT],
          [l.line, Math.max(CORE_HALF, DOT_RADIUS) + 1],
        ] as const) {
          m.uniforms.progress!.value = progress;
          m.uniforms.pxPerRef!.value = pxPerRef;
          m.uniforms.halfWidth!.value = half * pxPerRef;
        }
        return (
          <group key={i}>
            <mesh geometry={l.glowGeometry} material={l.glow} renderOrder={2} frustumCulled={false} />
            <mesh geometry={l.lineGeometry} material={l.line} renderOrder={3} frustumCulled={false} />
          </group>
        );
      })}
    </group>
  );
}

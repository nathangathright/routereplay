import { useMemo } from 'react';
import * as THREE from 'three';
import { cross, normalize, scale } from '../../shared/geo/vec';
import { type Timeline, displayAltitude } from '../../shared/timeline/evaluate';

const vertex = /* glsl */ `
attribute vec3 center;
attribute vec3 side;
attribute float sideSign;
attribute float along;
uniform float halfWidth;
varying float vAlong;
varying float vSide;
void main() {
  vAlong = along;
  vSide = sideSign;
  vec3 p = center + side * sideSign * halfWidth;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const fragment = /* glsl */ `
uniform float progress;
uniform float planned;
uniform float dashCount;
uniform vec3 color;
uniform float opacity;
varying float vAlong;
varying float vSide;
void main() {
  float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
  float a;
  if (planned > 0.5) {
    if (vAlong < progress) discard;
    float dash = step(0.5, fract(vAlong * dashCount));
    a = dash * edge * opacity;
  } else {
    if (vAlong > progress) discard;
    a = edge * opacity;
  }
  if (a <= 0.001) discard;
  gl_FragColor = vec4(color, a);
  #include <colorspace_fragment>
}
`;

/** Evenly spaced fractions along a track, plus its corners so a looked-up route keeps its shape. */
function sampleFractions(angle: number, corners: readonly number[]): number[] {
  const n = Math.max(48, Math.ceil(angle * 160));
  const even = Array.from({ length: n + 1 }, (_, i) => i / n);
  if (corners.length === 0) return even;
  const all = [...even, ...corners].sort((a, b) => a - b);
  return all.filter((f, i) => i === 0 || f - all[i - 1]! > 1e-9);
}

function legGeometry(tl: Timeline, index: number): THREE.BufferGeometry {
  const leg = tl.legs[index]!;
  const track = leg.track;
  const fractions = sampleFractions(track.angle, track.corners);
  const n = fractions.length - 1;
  const center = new Float32Array((n + 1) * 2 * 3);
  const side = new Float32Array((n + 1) * 2 * 3);
  const sideSign = new Float32Array((n + 1) * 2);
  const along = new Float32Array((n + 1) * 2);
  for (let i = 0; i <= n; i++) {
    const f = fractions[i]!;
    const p = track.at(f);
    const t = track.tangent(f);
    const s = normalize(cross(t, p));
    const c = scale(p, 1.0015 + displayAltitude(leg.cruise, f));
    for (let k = 0; k < 2; k++) {
      const j = i * 2 + k;
      center.set(c, j * 3);
      side.set(s, j * 3);
      sideSign[j] = k === 0 ? -1 : 1;
      along[j] = f;
    }
  }
  const index32: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    index32.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  // `position` is required by three for bounds; the shader uses `center`.
  g.setAttribute('position', new THREE.BufferAttribute(center, 3));
  g.setAttribute('center', new THREE.BufferAttribute(center, 3));
  g.setAttribute('side', new THREE.BufferAttribute(side, 3));
  g.setAttribute('sideSign', new THREE.BufferAttribute(sideSign, 1));
  g.setAttribute('along', new THREE.BufferAttribute(along, 1));
  g.setIndex(index32);
  g.computeBoundingSphere();
  return g;
}

function routeMaterial(planned: boolean, color: string, opacity: number, dashCount: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      progress: { value: 0 },
      planned: { value: planned ? 1 : 0 },
      dashCount: { value: dashCount },
      color: { value: new THREE.Color(color) },
      opacity: { value: opacity },
      halfWidth: { value: 0.004 },
    },
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export const ROUTE_COLOR = '#ffc76b';

/** Flown trail for every leg plus a faint dashed path ahead on the current leg. */
export function Routes({
  timeline,
  trail,
  currentLeg,
  halfWidth,
}: {
  timeline: Timeline;
  trail: number[];
  currentLeg: number;
  halfWidth: number;
}) {
  const legs = useMemo(
    () =>
      timeline.legs.map((leg, i) => {
        const geometry = legGeometry(timeline, i);
        const dashes = Math.max(6, Math.round(leg.track.angle * 90));
        return {
          geometry,
          flown: routeMaterial(false, ROUTE_COLOR, 0.95, 1),
          ahead: routeMaterial(true, '#ffffff', 0.32, dashes),
        };
      }),
    [timeline],
  );
  return (
    <group renderOrder={2}>
      {legs.map((l, i) => {
        const progress = trail[i] ?? 0;
        l.flown.uniforms.progress!.value = progress;
        l.flown.uniforms.halfWidth!.value = halfWidth;
        l.ahead.uniforms.progress!.value = progress;
        l.ahead.uniforms.halfWidth!.value = halfWidth * 0.6;
        return (
          <group key={i}>
            {progress > 0 && <mesh geometry={l.geometry} material={l.flown} renderOrder={3} frustumCulled={false} />}
            {i === currentLeg && progress < 1 && (
              <mesh geometry={l.geometry} material={l.ahead} renderOrder={2} frustumCulled={false} />
            )}
          </group>
        );
      })}
    </group>
  );
}

import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { cross, dot, normalize, smoothstep, sub } from '../../shared/geo/vec';
import type { SurfaceMode } from '../../shared/scene/constants';
import type { SceneState, Timeline } from '../../shared/timeline/evaluate';
import { bodyOnPath, vehiclePlace } from '../../shared/timeline/journeyPath';
import { vehicleModel } from './vehicles';

const DEG = Math.PI / 180;
/** Albedo multiplier at night, as the aircraft's: a faint cool light instead of sunlight through the planet. */
const NIGHT_TINT = new THREE.Color(0.16, 0.18, 0.24);
/**
 * In daylight, a little brighter than the paint: the aircraft is drawn before the atmosphere, which adds sky
 * light over it, and the vehicles after it (to cover the airport dots), so this keeps white roofs as white.
 */
const DAY_TINT = new THREE.Color(1.2, 1.2, 1.2);
const FOAM = new THREE.Color(0.9, 0.94, 1);
/** Radius the vehicles stand at: on the route ribbon (1.0015). */
const GROUND = 1.0016;
/** Where they draw: over the airport dots (10), as the marker they replace did, and under the label panels (11). */
const ORDER = { shadow: 10.35, wake: 10.4, body: 10.5, lamps: 10.6 };

const lampVertex = /* glsl */ `
uniform float uNight;
uniform float uShortSide;
attribute vec3 color;
attribute float aSize;
varying vec3 vColor;
void main() {
  vColor = color * uNight;
  gl_PointSize = aSize * uShortSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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

/** Rows of the wake, from the stern back. */
const WAKE_ROWS = 14;
/** Wake length in hull lengths, at full speed. */
const WAKE_LENGTH = 1.4;
/**
 * Across the wake: offsets in half widths, and foam strength. Two bright arms spreading in a V, with churned
 * water between them; the route's gold trail runs down the middle.
 */
const WAKE_PROFILE: [number, number][] = [
  [-1, 0],
  [-0.72, 1],
  [-0.4, 0.3],
  [0, 0.5],
  [0.4, 0.3],
  [0.72, 1],
  [1, 0],
];

interface Kit {
  root: THREE.Object3D;
  bodies: THREE.Object3D[];
  lampPoints: THREE.Points[];
  paint: THREE.MeshStandardMaterial;
  lamps: THREE.ShaderMaterial;
  shadow: THREE.MeshBasicMaterial;
  wake: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null;
}

function buildKit(mode: SurfaceMode): Kit {
  const model = vehicleModel(mode);
  // Hashed alpha dissolves one craft into the next without sorting faces, as on the aircraft. The material is
  // `transparent` only to draw in the same pass as the label sprites, between the airport dots and the label
  // panels; its blending writes colour opaquely and leaves the frame's alpha alone.
  const paint = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.5,
    metalness: 0.1,
    alphaHash: true,
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.ZeroFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const lamps = new THREE.ShaderMaterial({
    uniforms: { uNight: { value: 0 }, uShortSide: { value: 1 } },
    vertexShader: lampVertex,
    fragmentShader: lampFragment,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const shadow = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false });
  // An Object3D rather than a Group, so the parts sort with the label sprites by their own render order.
  const root = new THREE.Object3D();
  const lampPoints: THREE.Points[] = [];
  const bodies = model.bodies.map((b) => {
    const o = new THREE.Object3D();
    o.matrixAutoUpdate = false;
    const mesh = new THREE.Mesh(b.geometry, paint);
    mesh.renderOrder = ORDER.body;
    mesh.frustumCulled = false;
    const points = new THREE.Points(b.lamps, lamps);
    points.renderOrder = ORDER.lamps;
    points.frustumCulled = false;
    lampPoints.push(points);
    const under = new THREE.Mesh(b.shadow, shadow);
    under.renderOrder = ORDER.shadow;
    under.frustumCulled = false;
    o.add(under, mesh, points);
    root.add(o);
    return o;
  });
  let wake: Kit['wake'] = null;
  if (mode === 'ferry') {
    const n = (WAKE_ROWS + 1) * WAKE_PROFILE.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    const k = WAKE_PROFILE.length;
    const index: number[] = [];
    for (let j = 0; j < WAKE_ROWS; j++) {
      for (let i = 0; i + 1 < k; i++) {
        const a = j * k + i;
        index.push(a, a + k, a + 1, a + 1, a + k, a + k + 1);
      }
    }
    g.setIndex(index);
    wake = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    wake.renderOrder = ORDER.wake;
    wake.frustumCulled = false;
    root.add(wake);
  }
  return { root, bodies, lampPoints, paint, lamps, shadow, wake };
}

/**
 * The traveller on a train, bus, car, or ferry leg: that mode's model at a constant size on screen. `shortSide`
 * is the frame's short side in world units at the ground, the unit the models are built in. Each body stands
 * with its front and rear on its own leg's route, so it points along the road, rail, or ferry line, and a
 * train's cars follow its locomotive; at a connection it carries straight on past the station rather than onto
 * the next leg's line. Lit by the Sun (`state.sun`) like the aircraft, with lamps after dusk.
 * `opacity` below 1 dissolves it into or out of the next craft at a connection.
 */
export function Vehicle({
  mode,
  timeline,
  state,
  shortSide,
  opacity = 1,
}: {
  mode: SurfaceMode;
  timeline: Timeline;
  state: SceneState;
  shortSide: number;
  opacity?: number;
}) {
  const kit = useMemo(() => buildKit(mode), [mode]);
  const shortSidePx = useThree((s) => Math.min(s.size.width, s.size.height) * s.gl.getPixelRatio());
  // A vehicle that leaves frees what it owns; the shared model geometry stays for the next one.
  useEffect(
    () => () => {
      kit.paint.dispose();
      kit.lamps.dispose();
      kit.shadow.dispose();
      kit.wake?.geometry.dispose();
      kit.wake?.material.dispose();
    },
    [kit],
  );

  const model = vehicleModel(mode);
  const sunHeight = dot(state.aircraft.ground, state.sun);
  const sunlit = smoothstep(-0.5 * DEG, 0.5 * DEG, Math.asin(Math.max(-1, Math.min(1, sunHeight))));
  const tint = NIGHT_TINT.clone().lerp(DAY_TINT, sunlit);
  kit.paint.color.copy(tint);
  kit.paint.opacity = opacity;
  kit.shadow.opacity = opacity;
  // Lamps show from civil dusk (Sun 2° below the horizon) and are full by 12° below, as the aircraft's.
  const night = (1 - smoothstep(Math.sin(-12 * DEG), Math.sin(-2 * DEG), sunHeight)) * opacity;
  kit.lamps.uniforms.uNight!.value = night;
  kit.lamps.uniforms.uShortSide!.value = shortSidePx;
  for (const p of kit.lampPoints) p.visible = night > 0.002;

  // The lead body is centred on the traveller's position; the rest follow it along the route.
  const { path, at } = vehiclePlace(timeline, state, mode);
  let front = at + (model.bodies[0]!.length * shortSide) / 2;
  model.bodies.forEach((b, k) => {
    const length = b.length * shortSide;
    const { ground, heading } = bodyOnPath(path, front, length);
    const left = normalize(cross(ground, heading));
    const m = kit.bodies[k]!.matrix;
    m.makeBasis(
      new THREE.Vector3(left[0], left[1], left[2]),
      new THREE.Vector3(ground[0], ground[1], ground[2]),
      new THREE.Vector3(heading[0], heading[1], heading[2]),
    );
    m.scale(new THREE.Vector3(shortSide, shortSide, shortSide));
    m.setPosition(ground[0] * GROUND, ground[1] * GROUND, ground[2] * GROUND);
    kit.bodies[k]!.matrixWorldNeedsUpdate = true;
    front -= length + model.gap * shortSide;
  });

  if (kit.wake) {
    // Foam trails behind the ferry while it is under way, fading as it slows into port. It stays on this leg's
    // water: on the way out it grows from the terminal rather than reaching back over the land (its line starts
    // there, at distance 0).
    const p = state.legProgress;
    const strength = state.phase === 'surface' ? smoothstep(0, 0.1, p) * smoothstep(0, 0.1, 1 - p) : 0;
    const hull = model.bodies[0]!.length * shortSide;
    const stern = at - 0.42 * hull;
    const reach = Math.min(WAKE_LENGTH * hull, stern);
    kit.wake.visible = strength * opacity > 0.002 && reach > 0;
    if (kit.wake.visible) {
      const beam = model.width * shortSide;
      const pos = kit.wake.geometry.getAttribute('position') as THREE.BufferAttribute;
      const col = kit.wake.geometry.getAttribute('color') as THREE.BufferAttribute;
      const rows = Array.from({ length: WAKE_ROWS + 1 }, (_, j) => path.at(stern - (j / WAKE_ROWS) * reach));
      const foam = FOAM.clone().multiply(tint);
      const k = WAKE_PROFILE.length;
      rows.forEach((c, j) => {
        const ahead = rows[Math.max(0, j - 1)]!;
        const behind = rows[Math.min(WAKE_ROWS, j + 1)]!;
        const side = normalize(cross(c, sub(ahead, behind)));
        // Measured from the stern in hull lengths: it spreads, and fades with distance.
        const f = (j / WAKE_ROWS) * (reach / (WAKE_LENGTH * hull));
        const w = beam * (0.45 + 1.05 * f);
        const fade = 0.85 * strength * opacity * (1 - f) ** 1.2;
        WAKE_PROFILE.forEach(([x, a], i) => {
          pos.setXYZ(
            j * k + i,
            (c[0] + side[0] * x * w) * GROUND,
            (c[1] + side[1] * x * w) * GROUND,
            (c[2] + side[2] * x * w) * GROUND,
          );
          col.setXYZW(j * k + i, foam.r, foam.g, foam.b, a * fade);
        });
      });
      pos.needsUpdate = true;
      col.needsUpdate = true;
    }
  }
  return <primitive object={kit.root} />;
}

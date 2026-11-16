import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { cross, normalize, smoothstep, sub } from '../../shared/geo/vec';
import type { SurfaceMode } from '../../shared/scene/constants';
import type { SceneState, Timeline } from '../../shared/timeline/evaluate';
import { bodyOnPath, vehiclePlace } from '../../shared/timeline/journeyPath';
import { type DeckLook, aimVeil, setVeil, veilMaterial } from './Clouds';
import { VEHICLE_VEIL_MAX, VEIL_MAX, veilStrength } from './cloudCrossing';
import { type CraftLight, levelLight } from './craftLight';
import { CraftLighting } from './craftPaint';
import { useLinearScene } from './display';
import { vehicleModel } from './vehicles';

const FOAM = new THREE.Color(0.9, 0.94, 1);
/** Radius the vehicles stand at: on the route ribbon (1.0015). */
const GROUND = 1.0016;
/**
 * Where they draw: over the airport dots (10), as the marker they replace did, and under the label panels (11). The
 * cloud deck's veil (Clouds.tsx veilMaterial) draws over the bodies, and the lamps over it.
 */
const ORDER = { shadow: 10.35, wake: 10.4, body: 10.5, veil: 10.55, lamps: 10.6 };

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
 * water between them; the route's trail runs down the middle.
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
  /** The cloud deck drawn again over each body while the vehicle is under it (Vehicle gives them their material). */
  veils: THREE.Mesh[];
  lampPoints: THREE.Points[];
  lighting: CraftLighting;
  lamps: THREE.ShaderMaterial;
  shadow: THREE.MeshBasicMaterial;
  wake: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null;
}

function buildKit(mode: SurfaceMode): Kit {
  const model = vehicleModel(mode);
  // Lit as the aircraft are (craftPaint.ts), without shadow maps: a vehicle is a few dozen pixels long. Hashed alpha
  // dissolves one craft into the next without sorting faces. The material is `transparent` only to draw in the same
  // pass as the label sprites, between the airport dots and the label panels; its blending writes colour opaquely and
  // leaves the frame's alpha alone.
  const lighting = new CraftLighting(false);
  const paint = lighting.paint(
    { vertexColors: true, roughness: 0.5, metalness: 0.1 },
    {
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    },
  );
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
  root.add(lighting.root);
  const lampPoints: THREE.Points[] = [];
  const veils: THREE.Mesh[] = [];
  const bodies = model.bodies.map((b) => {
    const o = new THREE.Object3D();
    o.matrixAutoUpdate = false;
    const mesh = new THREE.Mesh(b.geometry, paint);
    lighting.attach(mesh, false);
    mesh.renderOrder = ORDER.body;
    mesh.frustumCulled = false;
    const points = new THREE.Points(b.lamps, lamps);
    points.renderOrder = ORDER.lamps;
    points.frustumCulled = false;
    lampPoints.push(points);
    const under = new THREE.Mesh(b.shadow, shadow);
    under.renderOrder = ORDER.shadow;
    under.frustumCulled = false;
    const veil = new THREE.Mesh(b.geometry);
    veil.renderOrder = ORDER.veil;
    veil.frustumCulled = false;
    veil.visible = false;
    veils.push(veil);
    o.add(under, mesh, veil, points);
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
  return { root, bodies, veils, lampPoints, lighting, lamps, shadow, wake };
}

/**
 * The traveller on a train, bus, car, or ferry leg: that mode's model at a constant size on screen. `shortSide`
 * is the frame's short side in world units at the ground, the unit the models are built in. Each body stands
 * with its front and rear on its own leg's route, so it points along the road, rail, or ferry line, and a
 * train's cars follow its locomotive; at a connection it carries straight on past the station rather than onto
 * the next leg's line. Lit by `light` like the aircraft (craftLight.ts), with lamps after dusk.
 * `opacity` below 1 dissolves it into or out of the next craft at a connection.
 *
 * `deck`: the cloud deck drawn this frame, if any. A vehicle is always on the ground, under the deck, so wherever the
 * deck's lobes cover it, the deck is drawn over it again, as over an aircraft at the gate, but only up to
 * VEHICLE_VEIL_MAX (cloudCrossing.ts). Its lamps, shadow, and wake fade by the veil's average.
 */
export function Vehicle({
  mode,
  timeline,
  state,
  shortSide,
  light,
  opacity = 1,
  deck = null,
}: {
  mode: SurfaceMode;
  timeline: Timeline;
  state: SceneState;
  shortSide: number;
  light: CraftLight;
  opacity?: number;
  deck?: DeckLook | null;
}) {
  const kit = useMemo(() => buildKit(mode), [mode]);
  const linear = useLinearScene();
  const veil = useMemo(() => {
    // Graphics, like the vehicle: drawn after the tone-map pass, tone mapped as it draws (display.tsx).
    const material = veilMaterial(linear, true);
    for (const mesh of kit.veils) {
      (mesh.material as THREE.Material).dispose();
      mesh.material = material;
      mesh.onBeforeRender = (_renderer, _scene, camera) => aimVeil(material, kit.root, camera);
    }
    return material;
  }, [kit, linear]);
  useEffect(() => () => veil.dispose(), [veil]);
  const shortSidePx = useThree((s) => Math.min(s.size.width, s.size.height) * s.gl.getPixelRatio());
  // A vehicle that leaves frees what it owns; the shared model geometry stays for the next one.
  useEffect(
    () => () => {
      kit.lighting.dispose();
      kit.lamps.dispose();
      kit.shadow.dispose();
      kit.wake?.geometry.dispose();
      kit.wake?.material.dispose();
    },
    [kit],
  );

  const model = vehicleModel(mode);
  kit.lighting.update(light, opacity);
  const veiling = deck ? veilStrength(light.submersion, VEHICLE_VEIL_MAX) : 0;
  for (const mesh of kit.veils) mesh.visible = veiling > 0;
  if (deck && veiling > 0) setVeil(veil, deck, veiling, opacity);
  // Graphics the veil can't cover pixel by pixel fade by its average (light.veil is a plane's, up to VEIL_MAX).
  const shown = 1 - (deck ? (light.veil * VEHICLE_VEIL_MAX) / VEIL_MAX : 0);
  kit.shadow.opacity = opacity * shown;
  // Lamps show from civil dusk (Sun 2° below the horizon) and are full by 12° below, as the aircraft's.
  const night = light.lamps * opacity * shown;
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
    kit.wake.visible = strength * opacity * shown > 0.002 && reach > 0;
    if (kit.wake.visible) {
      const beam = model.width * shortSide;
      const pos = kit.wake.geometry.getAttribute('position') as THREE.BufferAttribute;
      const col = kit.wake.geometry.getAttribute('color') as THREE.BufferAttribute;
      const rows = Array.from({ length: WAKE_ROWS + 1 }, (_, j) => path.at(stern - (j / WAKE_ROWS) * reach));
      // Foam is lit as level white water: the light falling on it from above.
      const foam = FOAM.clone().multiply(new THREE.Color(...levelLight(light)));
      const k = WAKE_PROFILE.length;
      rows.forEach((c, j) => {
        const ahead = rows[Math.max(0, j - 1)]!;
        const behind = rows[Math.min(WAKE_ROWS, j + 1)]!;
        const side = normalize(cross(c, sub(ahead, behind)));
        // Measured from the stern in hull lengths: it spreads, and fades with distance.
        const f = (j / WAKE_ROWS) * (reach / (WAKE_LENGTH * hull));
        const w = beam * (0.45 + 1.05 * f);
        const fade = 0.85 * strength * opacity * shown * (1 - f) ** 1.2;
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

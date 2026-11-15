import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { type Vec3, cross, normalize } from '../../shared/geo/vec';
import type { AircraftType } from '../../shared/scene/aircraft';
import { aircraftRadius, airframeModel } from './airframe';
import type { CraftLight } from './craftLight';
import { CraftLighting, enableCraftShadows } from './craftPaint';

const lampVertex = /* glsl */ `
uniform float uPixelRatio;
uniform float uNight;
uniform float uTime;
attribute vec3 color;
attribute float aBeacon;
varying vec3 vColor;
void main() {
  float intensity = 1.0;
  if (aBeacon > 0.5) {
    // A short flash every 1.2 s, with a dim glow in between.
    float p = mod(uTime - 0.18, 1.2) / 0.22;
    float s = sin(3.14159265 * p);
    intensity = p < 1.0 ? 0.15 + 3.6 * s * s : 0.15;
  }
  vColor = color * min(intensity, 1.0) * uNight;
  gl_PointSize = 6.0 * uPixelRatio * (1.0 + 0.25 * max(intensity - 1.0, 0.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const lampFragment = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float glow = exp(-dot(p, p) * 28.0);
  gl_FragColor = vec4(vColor * glow, 1.0);
  #include <colorspace_fragment>
}
`;

/** Hides a slot of the shared airframe geometry from one of its meshes. */
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });

interface Plane {
  /** In the Earth's frame: the airframe, and the lights that cast its shadow on itself. */
  root: THREE.Object3D;
  group: THREE.Group;
  lighting: CraftLighting;
  prop: THREE.MeshBasicMaterial;
  lamps: THREE.ShaderMaterial;
  /** The airframe's bounding sphere, model units. */
  bounds: THREE.Sphere;
}

const PROP_OPACITY = 0.28;

function buildPlane(type: AircraftType): Plane {
  const model = airframeModel(type);
  const lighting = new CraftLighting(true);
  const materials = [
    lighting.paint({ color: '#f3f5f8', roughness: 0.45, metalness: 0.15 }),
    lighting.paint({ color: '#9aa4b2', roughness: 0.5, metalness: 0.3 }),
    lighting.paint({ color: '#2e8cff', roughness: 0.5, metalness: 0.1 }),
  ];
  // Spinning propellers read as a faint disc. They are their own mesh, so they cast no shadow on the airframe.
  const prop = new THREE.MeshBasicMaterial({
    color: '#1b1f26',
    transparent: true,
    opacity: PROP_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const body = new THREE.Mesh(model.geometry, [...materials, HIDDEN]);
  lighting.attach(body, true);
  const discs = new THREE.Mesh(model.geometry, [HIDDEN, HIDDEN, HIDDEN, prop]);
  const group = new THREE.Group();
  group.add(body, discs);
  const lamps = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: 1 }, uNight: { value: 0 }, uTime: { value: 0 } },
    vertexShader: lampVertex,
    fragmentShader: lampFragment,
    blending: THREE.AdditiveBlending,
    // Display values, not light: transparent, so they draw after tone mapping, with the graphics (display.tsx).
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(model.lampGeometry, lamps);
  points.renderOrder = 4;
  points.frustumCulled = false;
  group.add(points);
  // Drawn after the cloud layer, so a plane always shows above the clouds.
  group.renderOrder = 1;
  const root = new THREE.Object3D();
  root.add(group, lighting.root);
  if (!model.geometry.boundingSphere) model.geometry.computeBoundingSphere();
  return { root, group, lighting, prop, lamps, bounds: model.geometry.boundingSphere!.clone() };
}

/**
 * One aircraft of the given type, one unit long before `size` scales it, lit by `light` (craftLight.ts): the Sun
 * through the air, the Moon and the night rig after dark, the sky above and what lies below, and its own shadow.
 * Its navigation lights show after dusk. `clock` (seconds) times the beacon: pass presentation time where frames
 * must be reproducible. `opacity` below 1 dissolves the plane, for changing aircraft at a connection.
 */
export function Aircraft({
  type,
  ground,
  heading,
  altitude,
  size,
  light,
  clock = 0,
  opacity = 1,
}: {
  type: AircraftType;
  ground: Vec3;
  heading: Vec3;
  altitude: number;
  size: number;
  light: CraftLight;
  clock?: number;
  opacity?: number;
}) {
  const plane = useMemo(() => buildPlane(type), [type]);
  const { group: model, lighting, prop, lamps, bounds } = plane;
  const gl = useThree((state) => state.gl);
  const pixelRatio = gl.getPixelRatio();
  enableCraftShadows(gl);
  // A plane that leaves frees its own materials and shadow maps; the shared geometry stays for the next one.
  useEffect(
    () => () => {
      plane.lighting.dispose();
      plane.prop.dispose();
      plane.lamps.dispose();
    },
    [plane],
  );
  prop.opacity = PROP_OPACITY * opacity;
  const uniforms = lamps.uniforms;
  uniforms.uNight!.value = light.lamps * opacity;
  uniforms.uTime!.value = clock;
  uniforms.uPixelRatio!.value = pixelRatio;
  const matrix = model.matrix;
  model.matrixAutoUpdate = false;
  const up = ground;
  const forward = normalize(heading);
  const right = normalize(cross(up, forward));
  const r = aircraftRadius(type, altitude, size);
  matrix.makeBasis(
    new THREE.Vector3(right[0], right[1], right[2]),
    new THREE.Vector3(up[0], up[1], up[2]),
    new THREE.Vector3(forward[0], forward[1], forward[2]),
  );
  matrix.scale(new THREE.Vector3(size, size, size));
  matrix.setPosition(up[0] * r, up[1] * r, up[2] * r);
  model.matrixWorldNeedsUpdate = true;
  const center = bounds.center.clone().applyMatrix4(matrix);
  lighting.update(light, opacity, { center: [center.x, center.y, center.z], radius: bounds.radius * size * 1.02 });
  return <primitive object={plane.root} />;
}

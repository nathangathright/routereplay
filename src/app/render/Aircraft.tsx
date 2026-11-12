import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { type Vec3, cross, dot, normalize, smoothstep } from '../../shared/geo/vec';
import type { AircraftType } from '../../shared/scene/aircraft';
import { airframeModel } from './airframe';

const DEG = Math.PI / 180;

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

/** Albedo multiplier for the airframe at night: a faint cool light instead of sunlight through the planet. */
const NIGHT_TINT = new THREE.Color(0.16, 0.18, 0.24);
const WHITE = new THREE.Color(1, 1, 1);

interface Plane {
  group: THREE.Group;
  /** Body, trim, and tail materials with their daylight colours: this plane's own. */
  materials: THREE.MeshStandardMaterial[];
  colors: THREE.Color[];
  prop: THREE.MeshBasicMaterial;
  lamps: THREE.ShaderMaterial;
  bottom: number;
}

const PROP_OPACITY = 0.28;

function buildPlane(type: AircraftType): Plane {
  const model = airframeModel(type);
  // Hashed alpha dissolves one type into the next at a connection without sorting the model's own faces.
  const paint = (color: string, roughness: number, metalness: number) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness, alphaHash: true });
  const materials = [paint('#f3f5f8', 0.45, 0.15), paint('#9aa4b2', 0.5, 0.3), paint('#ffc76b', 0.5, 0.1)];
  // Spinning propellers read as a faint disc.
  const prop = new THREE.MeshBasicMaterial({
    color: '#1b1f26',
    transparent: true,
    opacity: PROP_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(model.geometry, [...materials, prop]));
  const lamps = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: 1 }, uNight: { value: 0 }, uTime: { value: 0 } },
    vertexShader: lampVertex,
    fragmentShader: lampFragment,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const points = new THREE.Points(model.lampGeometry, lamps);
  points.renderOrder = 4;
  points.frustumCulled = false;
  group.add(points);
  // Drawn after the cloud layer, so a plane always shows above the clouds.
  group.renderOrder = 1;
  return { group, materials, colors: materials.map((m) => m.color.clone()), prop, lamps, bottom: model.bottom };
}

/**
 * One aircraft of the given type, one unit long before `size` scales it. `sun` (Earth frame) dims the airframe
 * once the Sun has set for the plane, which at cruise height is a few degrees after it sets on the ground below,
 * and lights its navigation lights after dusk. `clock` (seconds) times the beacon: pass presentation time where
 * frames must be reproducible. `opacity` below 1 dissolves the plane, for changing aircraft at a connection.
 */
export function Aircraft({
  type,
  ground,
  heading,
  altitude,
  size,
  sun,
  clock = 0,
  opacity = 1,
}: {
  type: AircraftType;
  ground: Vec3;
  heading: Vec3;
  altitude: number;
  size: number;
  sun?: Vec3;
  clock?: number;
  opacity?: number;
}) {
  const plane = useMemo(() => buildPlane(type), [type]);
  const { group: model, materials, colors, prop, lamps } = plane;
  const pixelRatio = useThree((state) => state.gl.getPixelRatio());
  // A plane that leaves frees its own materials; the shared geometry stays for the next one.
  useEffect(
    () => () => {
      for (const m of plane.materials) m.dispose();
      plane.prop.dispose();
      plane.lamps.dispose();
    },
    [plane],
  );
  const sunHeight = sun ? dot(ground, sun) : 1;
  // The Sun's centre sets for the plane when it falls acos(1/r) below its horizontal; ease over about 1°.
  const sunlit = smoothstep(-0.5 * DEG, 0.5 * DEG, Math.asin(sunHeight) + Math.acos(1 / (1 + altitude)));
  const tint = NIGHT_TINT.clone().lerp(WHITE, sunlit);
  materials.forEach((m, i) => {
    m.color.copy(colors[i]!).multiply(tint);
    m.opacity = opacity;
  });
  prop.opacity = PROP_OPACITY * opacity;
  // Lights show from civil dusk (Sun 2° below the ground's horizon) and are full by 12° below.
  const uniforms = lamps.uniforms;
  uniforms.uNight!.value = (1 - smoothstep(Math.sin(-12 * DEG), Math.sin(-2 * DEG), sunHeight)) * opacity;
  uniforms.uTime!.value = clock;
  uniforms.uPixelRatio!.value = pixelRatio;
  const matrix = model.matrix;
  model.matrixAutoUpdate = false;
  const up = ground;
  const forward = normalize(heading);
  const right = normalize(cross(up, forward));
  // Lifted so the lowest point (a nacelle or the belly) clears the surface it stands on.
  const r = 1 + altitude + 0.0015 + size * plane.bottom;
  matrix.makeBasis(
    new THREE.Vector3(right[0], right[1], right[2]),
    new THREE.Vector3(up[0], up[1], up[2]),
    new THREE.Vector3(forward[0], forward[1], forward[2]),
  );
  matrix.scale(new THREE.Vector3(size, size, size));
  matrix.setPosition(up[0] * r, up[1] * r, up[2] * r);
  model.matrixWorldNeedsUpdate = true;
  return <primitive object={model} />;
}

import { useMemo } from 'react';
import * as THREE from 'three';
import { EARTH_RADIUS_KM } from '../../shared/geo/greatCircle';
import { type Vec3, scale } from '../../shared/geo/vec';

const DEG = Math.PI / 180;
/** The Sun is drawn this far from the camera (Earth radii): beyond the stars, inside the far plane. */
const SUN_DISTANCE = 150;
const SUN_ANGULAR_DIAMETER = 0.533 * DEG;
/** The sprite's width, in Sun diameters: the disk plus its glare. */
const SUN_GLARE = 16;
const MOON_RADIUS = 1737.4 / EARTH_RADIUS_KM;

/** A radial gradient on a square canvas, as a sprite texture. Stops run from the centre (0) to the edge (1). */
function radialTexture(stops: [number, string][]): THREE.Texture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** How much of the Sun's disc is above the Earth's limb as seen from `observer` (Earth radii, Earth frame), 0 to 1. */
export function sunVisibleFraction(observer: Vec3, sun: Vec3): number {
  // From routereplay solar_visibility.py: the limb dips acos(1/r) below the observer's horizontal, and the
  // visible part of the disc is a circular segment.
  const r = Math.hypot(observer[0], observer[1], observer[2]);
  const altitude = Math.asin((observer[0] * sun[0] + observer[1] * sun[1] + observer[2] * sun[2]) / r);
  const dip = Math.acos(Math.min(1, 1 / r));
  const u = Math.min(1, Math.max(-1, (altitude + dip) / (SUN_ANGULAR_DIAMETER / 2)));
  return 0.5 + (Math.asin(u) + u * Math.sqrt(1 - u * u)) / Math.PI;
}

/**
 * The Sun at its true size in direction `direction` (Earth frame), drawn relative to the camera so it sits
 * at infinity. The disc is hidden by the Earth as it sets; the glare is drawn over everything and fades with
 * `visible`, the fraction of the disc above the limb, so it is never left sliced by the planet's edge.
 */
export function Sun({ direction, visible }: { direction: Vec3; visible: number }) {
  const [disc, glare] = useMemo(() => {
    const disk = 1 / SUN_GLARE;
    return [
      new THREE.SpriteMaterial({
        map: radialTexture([
          [0, 'rgba(255, 255, 255, 1)'],
          [0.55, 'rgba(255, 253, 244, 1)'],
          [0.7, 'rgba(255, 244, 222, 0.5)'],
          [1, 'rgba(255, 240, 214, 0)'],
        ]),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        // Drawn as the eye sees it, not through the camera's exposure.
        toneMapped: false,
      }),
      new THREE.SpriteMaterial({
        map: radialTexture([
          [0, 'rgba(255, 240, 214, 0.6)'],
          [disk * 1.1, 'rgba(255, 238, 210, 0.55)'],
          [disk * 1.8, 'rgba(255, 224, 178, 0.3)'],
          [0.4, 'rgba(255, 204, 150, 0.07)'],
          [1, 'rgba(255, 190, 130, 0)'],
        ]),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        // Drawn as the eye sees it, not through the camera's exposure.
        toneMapped: false,
        depthTest: false,
      }),
    ];
  }, []);
  glare.opacity = visible;
  const diameter = 2 * SUN_DISTANCE * Math.tan(SUN_ANGULAR_DIAMETER / 2);
  const position = scale(direction, SUN_DISTANCE) as [number, number, number];
  return (
    <>
      <sprite material={disc} position={position} scale={[diameter * 1.8, diameter * 1.8, 1]} renderOrder={2} />
      {visible > 0 && (
        <sprite material={glare} position={position} scale={[diameter * SUN_GLARE, diameter * SUN_GLARE, 1]} renderOrder={3} />
      )}
    </>
  );
}

const moonVertex = /* glsl */ `
uniform vec3 sunDir;
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vSunW;
void main() {
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vSunW = normalize(mat3(modelMatrix) * sunDir);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPosW = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const moonFragment = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vSunW;
void main() {
  vec3 N = normalize(vNormalW);
  float mu0 = dot(N, normalize(vSunW));                   // toward the Sun
  float mu = max(dot(N, normalize(cameraPosition - vPosW)), 0.0); // toward the viewer
  // Moon dust scatters light back toward its source (Lommel–Seeliger), blended with a little Lambert as in
  // routereplay celestial.py: the lit side stays evenly bright and a crescent gets its bright edge.
  float r = mu0 > 0.0 ? 0.65 * 2.0 * mu0 / (mu0 + mu + 1e-4) + 0.35 * mu0 : 0.0;
  // A trace of earthshine keeps the dark side from vanishing completely.
  vec3 color = vec3(1.0, 0.98, 0.94) * min(r * 0.72, 1.0) + vec3(0.010, 0.012, 0.018);
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

/** The Moon at its true size and place, `position` in Earth radii (Earth frame), lit by the Sun so its phase is right. */
export function Moon({ position, sun }: { position: Vec3; sun: Vec3 }) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { sunDir: { value: new THREE.Vector3() } },
        vertexShader: moonVertex,
        fragmentShader: moonFragment,
      }),
    [],
  );
  (material.uniforms.sunDir!.value as THREE.Vector3).set(sun[0], sun[1], sun[2]);
  return (
    <mesh material={material} position={position as [number, number, number]}>
      <sphereGeometry args={[MOON_RADIUS, 32, 16]} />
    </mesh>
  );
}

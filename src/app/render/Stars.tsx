import { useThree } from '@react-three/fiber';
import { useMemo } from 'react';
import * as THREE from 'three';

/** Mulberry32: small seeded PRNG so decorative randomness is reproducible. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Greenwich mean sidereal angle (radians) for rotating the celestial sphere. */
export function siderealAngle(utcMs: number): number {
  const n = utcMs / 86_400_000 + 2440587.5 - 2451545.0;
  const deg = (280.46061837 + 360.98564736629 * n) % 360;
  return (deg * Math.PI) / 180;
}

const starVertex = /* glsl */ `
uniform float uPixelRatio;
attribute vec3 color;
attribute float aSigma;
attribute float aHalo;
varying vec3 vColor;
varying float vSigma;
varying float vHalo;
varying float vSize;
void main() {
  vColor = color;
  vSigma = aSigma * uPixelRatio;
  vHalo = aHalo;
  // Cover three standard deviations of the core, or of the five-times-wider halo on bright stars.
  vSize = 2.0 * ceil(3.0 * vSigma * (aHalo > 0.0 ? 5.0 : 1.0)) + 1.0;
  gl_PointSize = vSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const starFragment = /* glsl */ `
varying vec3 vColor;
varying float vSigma;
varying float vHalo;
varying float vSize;
void main() {
  vec2 p = (gl_PointCoord - 0.5) * vSize; // device pixels from the star's centre
  float r2 = dot(p, p);
  float s2 = 2.0 * vSigma * vSigma;
  float intensity = exp(-r2 / s2) + vHalo * exp(-r2 / (25.0 * s2));
  gl_FragColor = vec4(vColor * intensity, 1.0);
  #include <colorspace_fragment>
}
`;

/**
 * A seeded random sky with a realistic spread of brightness, drawn as soft Gaussian dots whose peak and
 * width follow magnitude, as in the offline renderer (routereplay starfield.py). Gaussians stay steady as
 * the sky turns, where 1–2 px squares flicker between pixels. Place it at the camera so the stars sit at
 * infinity (no parallax).
 */
export function Stars({ seed, utcMs, count = 1600 }: { seed: number; utcMs: number; count?: number }) {
  const pixelRatio = useThree((state) => state.gl.getPixelRatio());
  const geometry = useMemo(() => {
    const rand = mulberry32(seed ^ 0x5eed);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sigmas = new Float32Array(count);
    const halos = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const z = rand() * 2 - 1;
      const phi = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      // Inertial frame with +Y toward the celestial north pole.
      positions.set([r * Math.cos(phi) * 80, z * 80, r * Math.sin(phi) * 80], i * 3);
      // Star counts grow about 10^(0.5 V) with magnitude V: this many stars reach V 6.5, the brightest near 0.
      const magnitude = Math.max(-1, 6.5 + 2 * Math.log10(Math.max(rand(), 1e-6)));
      const rootFlux = Math.sqrt(10 ** (-0.4 * magnitude));
      // The brightness range is squeezed (about 250× in flux to 3× in peak) so faint stars still read.
      const peak = Math.min(1.6, (1.725 * rootFlux) / (rootFlux + 0.11));
      sigmas[i] = 0.42 + 0.3 * Math.min(1.6, Math.max(0, (5 - magnitude) / 5));
      halos[i] = magnitude < 2 ? 0.06 : 0;
      const warm = rand();
      colors.set([peak * (0.9 + 0.1 * warm), peak * 0.95, peak * (1.05 - 0.15 * warm)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setAttribute('aSigma', new THREE.BufferAttribute(sigmas, 1));
    g.setAttribute('aHalo', new THREE.BufferAttribute(halos, 1));
    return g;
  }, [seed, count]);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uPixelRatio: { value: 1 } },
        vertexShader: starVertex,
        fragmentShader: starFragment,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [],
  );
  material.uniforms.uPixelRatio!.value = pixelRatio;
  // The Earth frame rotates under the stars at the sidereal rate.
  return <points geometry={geometry} material={material} rotation={[0, -siderealAngle(utcMs), 0]} renderOrder={-1} />;
}

/**
 * The day map's colour on the CPU, for the light the ground throws up at a craft (craftLight.ts): the map shrunk once
 * to a coarse grid and sampled under the craft once a frame.
 *
 * The grid is read from the GPU, where the day texture already sits with its mipmaps: one draw of its 256 × 128 level
 * into a small target, and one read back, about 2 ms once per texture. Shrinking the image on a 2D canvas instead
 * took 90–200 ms of main-thread time.
 */
import * as THREE from 'three';
import type { Vec3 } from '../../shared/geo/vec';
import type { RGB } from './airLight';

const DEG = Math.PI / 180;
/** 1.4° a cell, about the size of the ground a plane's bounce light comes from. */
const WIDTH = 256;
const HEIGHT = 128;

const shrinkVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Linear colour from the sRGB texture's mip level, stored with a 1/2.2 power so dark sea keeps its precision in 8 bits.
const shrinkFragment = /* glsl */ `
uniform sampler2D map;
uniform float lod;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(pow(max(textureLod(map, vUv, lod).rgb, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
}
`;

const grids = new WeakMap<THREE.Texture, Float32Array | null>();

/** The day map's linear colour on a 256 × 128 grid, rows from 90°N, columns from 180°W; null if it can't be read. */
function albedoGrid(gl: THREE.WebGLRenderer, day: THREE.Texture): Float32Array | null {
  if (grids.has(day)) return grids.get(day)!;
  let grid: Float32Array | null = null;
  const width = (day.image as { width?: number } | undefined)?.width ?? 0;
  if (width >= WIDTH) {
    const target = new THREE.WebGLRenderTarget(WIDTH, HEIGHT, { depthBuffer: false, generateMipmaps: false });
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.ShaderMaterial({
      uniforms: { map: { value: day }, lod: { value: Math.log2(width / WIDTH) } },
      vertexShader: shrinkVertex,
      fragmentShader: shrinkFragment,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const quad = new THREE.Mesh(geometry, material);
    quad.frustumCulled = false;
    const previous = gl.getRenderTarget();
    try {
      const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
      gl.setRenderTarget(target);
      gl.render(quad, new THREE.OrthographicCamera());
      gl.readRenderTargetPixels(target, 0, 0, WIDTH, HEIGHT, pixels);
      grid = new Float32Array(WIDTH * HEIGHT * 3);
      // Pixels come bottom row first: the map's south.
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          const from = 4 * ((HEIGHT - 1 - y) * WIDTH + x);
          for (let c = 0; c < 3; c++) grid[3 * (y * WIDTH + x) + c] = (pixels[from + c]! / 255) ** 2.2;
        }
      }
    } catch {
      grid = null;
    } finally {
      gl.setRenderTarget(previous);
      target.dispose();
      geometry.dispose();
      material.dispose();
    }
  }
  // An image that hasn't loaded yet is tried again on a later frame.
  if (width >= WIDTH) grids.set(day, grid);
  return grid;
}

/** The ground's colour under the unit vector n, bilinear on the day map's grid. */
function albedoAt(grid: Float32Array, n: Vec3): RGB {
  const lat = Math.asin(Math.max(-1, Math.min(1, n[1]))) / DEG;
  const lon = Math.atan2(-n[2], n[0]) / DEG;
  const x = ((lon + 180) / 360) * WIDTH - 0.5;
  const y = Math.min(HEIGHT - 1, Math.max(0, ((90 - lat) / 180) * HEIGHT - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const y1 = Math.min(HEIGHT - 1, y0 + 1);
  const at = (xi: number, yi: number, c: number) => grid[3 * (yi * WIDTH + (((xi % WIDTH) + WIDTH) % WIDTH)) + c]!;
  return [0, 1, 2].map((c) => {
    const top = at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx;
    const bottom = at(x0, y1, c) * (1 - fx) + at(x0 + 1, y1, c) * fx;
    return top * (1 - fy) + bottom * fy;
  }) as RGB;
}

/** The day map's colour (linear) under a unit vector, or null where the map can't be read. */
export function dayAlbedo(gl: THREE.WebGLRenderer, day: THREE.Texture | null | undefined): ((n: Vec3) => RGB) | null {
  const grid = day ? albedoGrid(gl, day) : null;
  return grid ? (n) => albedoAt(grid, n) : null;
}

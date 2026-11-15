/**
 * The cloud layer's billows: a seeded, tileable cellular texture of rounded lobes, after the offline renderer's
 * (routereplay cloudshapes.py), with our own construction. Each cell of a 16³ lattice holds one jittered feature
 * point and a flat-topped dome around it, 1 − (d / r)⁴, with its own height. Domes merge through a smooth maximum, so lobes
 * stand as rounded tops with soft valleys between them instead of the creases a plain nearest-point (Worley)
 * field has. In 3D, the shell's slice through a dome is a disc whose size depends on how near its centre the
 * slice passes, so lobes come in many sizes.
 *
 * R holds the lobes (0–1); G, B, and A their analytic gradient along x, y, and z, so the shader shapes and lights
 * the tops without reading the texture again. The same on every device: a fixed seed and plain arithmetic.
 */

/** Seeded generator (mulberry32, as Stars.tsx uses), so the texture is the same on every device. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Texels along each side of the texture. */
export const SHAPE_SIZE = 64;
/** Lattice cells along each side: 4 texels a cell, so trilinear filtering keeps the domes round. */
export const SHAPE_CELLS = 16;
/** The gradient is stored in 8 bits as 128 + 127 g / SHAPE_SLOPE_RANGE, g per unit of texture coordinate. */
export const SHAPE_SLOPE_RANGE = 64;
/** Dome radius in cells: lobes overlap their neighbours, so a deck can close up entirely. */
const DOME_RADIUS = 0.9;
/** Weight of each neighbour when the lobes are smoothed along an axis: [1, 6, 1] / 8. */
const LOBE_BLUR = 0.125;
/** Width of the smooth maximum that merges neighbouring domes (in units of dome height). */
const MERGE = 0.12;
/** Lattice of the broad value noise that gathers lobes into clusters (cells along each side of the tile). */
const BROAD_CELLS = 4;
/** Share of the broad noise in the shape: the rest is the lobes. */
const BROAD = 0.3;

export interface ShapeData {
  /** RGBA bytes, x fastest: lobes and their gradient. */
  rgba: Uint8Array;
}

/**
 * The texture's bytes. Each feature's dome is merged into the texels within its radius, in a fixed order, so the
 * result is the same everywhere: about 3 million dome evaluations, 50–135 ms on an M1 Max, once per page.
 */
export function cellularShapes(seed = 0xc10d): ShapeData {
  const n = SHAPE_SIZE;
  const cells = SHAPE_CELLS;
  const perCell = n / cells;
  const rand = seeded(seed);
  const total = n * n * n;
  const value = new Float32Array(total).fill(-1);
  const grad = new Float32Array(total * 3);
  const r2 = DOME_RADIUS * DOME_RADIUS;
  const reach = Math.ceil(DOME_RADIUS * perCell);
  for (let cz = 0; cz < cells; cz++) {
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        // Feature position in texels, and its dome's height.
        const fx = (cx + 0.15 + 0.7 * rand()) * perCell;
        const fy = (cy + 0.15 + 0.7 * rand()) * perCell;
        const fz = (cz + 0.15 + 0.7 * rand()) * perCell;
        const h = 0.6 + 0.4 * rand();
        const x0 = Math.floor(fx - reach);
        const y0 = Math.floor(fy - reach);
        const z0 = Math.floor(fz - reach);
        for (let z = z0; z <= z0 + 2 * reach + 1; z++) {
          const oz = (z + 0.5 - fz) / perCell;
          const wz = ((z % n) + n) % n;
          for (let y = y0; y <= y0 + 2 * reach + 1; y++) {
            const oy = (y + 0.5 - fy) / perCell;
            const wy = ((y % n) + n) % n;
            for (let x = x0; x <= x0 + 2 * reach + 1; x++) {
              const ox = (x + 0.5 - fx) / perCell;
              const q = (ox * ox + oy * oy + oz * oz) / r2;
              if (q >= 1) continue;
              // A flat-topped dome, h (1 − q²), with steep sides: the rounded head of a cumulus lobe.
              const dome = h * (1 - q * q);
              const s = (-4 * h * q) / r2;
              const i = (wz * n + wy) * n + (((x % n) + n) % n);
              const v = value[i]!;
              // Polynomial smooth maximum (blend width MERGE), carrying the gradient through the same blend.
              const t = Math.min(1, Math.max(0, 0.5 + (0.5 * (dome - v)) / MERGE));
              value[i] = v + (dome - v) * t + MERGE * t * (1 - t);
              grad[3 * i] = grad[3 * i]! + (s * ox - grad[3 * i]!) * t;
              grad[3 * i + 1] = grad[3 * i + 1]! + (s * oy - grad[3 * i + 1]!) * t;
              grad[3 * i + 2] = grad[3 * i + 2]! + (s * oz - grad[3 * i + 2]!) * t;
            }
          }
        }
      }
    }
  }
  // Broad, smooth value noise (quintic interpolation of a seeded lattice), so lobes gather into clusters and
  // thin out between them, as the offline renderer's broad noise does.
  const b = BROAD_CELLS;
  const lattice = Array.from({ length: b * b * b }, () => rand());
  const node = (i: number, j: number, k: number) => lattice[((k % b) * b + (j % b)) * b + (i % b)]!;
  // Per texel along an axis: its lattice cell, the quintic weight of the next node, and that weight's slope.
  const cell = new Int32Array(n);
  const weight = new Float64Array(n);
  const weightSlope = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    const u = ((x + 0.5) / n) * b;
    const t = u - Math.floor(u);
    cell[x] = Math.floor(u);
    weight[x] = t * t * t * (t * (t * 6 - 15) + 10);
    weightSlope[x] = 30 * t * t * (t - 1) * (t - 1);
  }
  // Smooth the lobes [1, 6, 1] / 8 and their gradient [1, 2, 1] / 4 along each axis. A dome's flat top falls to its
  // base within about one texel, and trilinear filtering draws such a drop, and the contour carved through it, as
  // facets along the texel grid; smoothed, the drop spans about two texels (more smoothing blurs the lobes into
  // mush). Smoothing the gradient keeps its creases from showing as straight seams under a low Sun.
  for (let i = 0; i < total; i++) value[i] = Math.min(1, Math.max(0, value[i]!));
  for (let axis = 0; axis < 3; axis++) {
    const stride = axis === 0 ? 1 : axis === 1 ? n : n * n;
    const copy = grad.slice();
    const lobes = value.slice();
    for (let i = 0; i < total; i++) {
      const c = Math.floor(i / stride) % n;
      const before = i + ((c + n - 1) % n - c) * stride;
      const after = i + ((c + 1) % n - c) * stride;
      value[i] = LOBE_BLUR * (lobes[before]! + lobes[after]!) + (1 - 2 * LOBE_BLUR) * lobes[i]!;
      for (let k = 0; k < 3; k++) grad[3 * i + k] = 0.25 * copy[3 * before + k]! + 0.5 * copy[3 * i + k]! + 0.25 * copy[3 * after + k]!;
    }
  }
  const rgba = new Uint8Array(total * 4);
  // Gradients per unit of texture coordinate: lattice cells per unit times the gradient in cells.
  const slope = (g: number) => Math.min(255, Math.max(1, Math.round(128 + (127 * g) / SHAPE_SLOPE_RANGE)));
  for (let z = 0, i = 0; z < n; z++) {
    const k0 = cell[z]!;
    const sw = weight[z]!;
    const dw = weightSlope[z]!;
    for (let y = 0; y < n; y++) {
      const j0 = cell[y]!;
      const sv = weight[y]!;
      const dv = weightSlope[y]!;
      for (let x = 0; x < n; x++, i++) {
        const i0 = cell[x]!;
        const su = weight[x]!;
        const du = weightSlope[x]!;
        let broad = 0;
        let bx = 0;
        let by = 0;
        let bz = 0;
        for (let c = 0; c < 8; c++) {
          const ci = c & 1;
          const cj = (c >> 1) & 1;
          const ck = (c >> 2) & 1;
          const corner = node(i0 + ci, j0 + cj, k0 + ck);
          const wu = ci ? su : 1 - su;
          const wv = cj ? sv : 1 - sv;
          const ww = ck ? sw : 1 - sw;
          broad += corner * wu * wv * ww;
          bx += corner * (ci ? du : -du) * wv * ww;
          by += corner * wu * (cj ? dv : -dv) * ww;
          bz += corner * wu * wv * (ck ? dw : -dw);
        }
        const shape = (1 - BROAD) * value[i]! + BROAD * broad;
        rgba[4 * i] = Math.round(255 * shape);
        rgba[4 * i + 1] = slope((1 - BROAD) * grad[3 * i]! * cells + BROAD * bx * b);
        rgba[4 * i + 2] = slope((1 - BROAD) * grad[3 * i + 1]! * cells + BROAD * by * b);
        rgba[4 * i + 3] = slope((1 - BROAD) * grad[3 * i + 2]! * cells + BROAD * bz * b);
      }
    }
  }
  return { rgba };
}

/** Trilinear, wrapping sample of channel 0 (the lobes), at texture coordinates (x, y, z), 0–1 a tile. */
export function sampleShape(rgba: Uint8Array, x: number, y: number, z: number): number {
  const n = SHAPE_SIZE;
  const u = x * n - 0.5;
  const v = y * n - 0.5;
  const w = z * n - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const z0 = Math.floor(w);
  const ax = u - x0;
  const ay = v - y0;
  const az = w - z0;
  const at = (i: number, j: number, k: number) =>
    rgba[4 * (((((k % n) + n) % n) * n + (((j % n) + n) % n)) * n + (((i % n) + n) % n))]! / 255;
  let s = 0;
  for (let k = 0; k <= 1; k++) {
    for (let j = 0; j <= 1; j++) {
      for (let i = 0; i <= 1; i++) {
        s += at(x0 + i, y0 + j, z0 + k) * (i ? ax : 1 - ax) * (j ? ay : 1 - ay) * (k ? az : 1 - az);
      }
    }
  }
  return s;
}

/** How deeply the second, finer frequency (EROSION_SCALE× the first) erodes the lobes' edges. */
export const EROSION = 0.3;
export const EROSION_SCALE = 2.6;
export const EROSION_OFFSET = 0.37;
/** Levels of the shape's distribution (`COVER_LEVELS + 1` values per table, from the least to the most covered). */
export const COVER_LEVELS = 32;
/** Softness of a lobe's edge, in units of the billow shape (the shader adds what one pixel spans). */
export const LOBE_EDGE = 0.04;
/** How far above its cut-off a lobe turns from translucent rim to opaque core, in units of the billow shape. */
export const LOBE_CORE = 0.15;

/** How much of a lobe is at shape s carved at cut, as the shader's lobe(): soft at the rim, opaque in the core. */
export function lobe(s: number, cut: number, edge = LOBE_EDGE): number {
  const step = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  return step(cut - edge, cut + edge, s) * (0.6 + 0.4 * step(cut, cut + LOBE_CORE, s));
}

export interface CoverTables {
  /** Cut-offs of the full shape, lobes − EROSION × (1 − finer lobes). */
  full: number[];
  /** Cut-offs of the lobes alone, for views where the finer lobes are too small to draw. */
  coarse: number[];
  /** The mean of lobe() carved at each cut-off, over the sky: what carving fades to where lobes are too small. */
  meanFull: number[];
  meanCoarse: number[];
}

/**
 * The billow shapes the shader thresholds, at many seeded points, and their levels: level i is the shape value
 * that a fraction 1 − i / COVER_LEVELS of the texture exceeds, so carving at the level for a fraction f covers that
 * fraction of the sky, whatever the texture. With each, the mean of the carved lobes over the sky.
 */
export function coverTables(rgba: Uint8Array, samples = 40_000): CoverTables {
  const rand = seeded(0x5eed);
  const full = new Float64Array(samples);
  const coarse = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = rand();
    const y = rand();
    const z = rand();
    const lobes = sampleShape(rgba, x, y, z);
    const fine = sampleShape(rgba, x * EROSION_SCALE + EROSION_OFFSET, y * EROSION_SCALE + EROSION_OFFSET, z * EROSION_SCALE + EROSION_OFFSET);
    coarse[i] = lobes;
    full[i] = lobes - EROSION * (1 - fine);
  }
  const levels = (values: Float64Array) => {
    const sorted = values.slice().sort();
    const cut: number[] = [];
    for (let i = 0; i <= COVER_LEVELS; i++) cut.push(sorted[Math.min(samples - 1, Math.round((i / COVER_LEVELS) * (samples - 1)))]!);
    // Below the lowest level everything is covered; above the highest, nothing.
    cut[0] = cut[0]! - 0.05;
    cut[COVER_LEVELS] = cut[COVER_LEVELS]! + 0.05;
    return cut;
  };
  const means = (values: Float64Array, cut: number[]) =>
    cut.map((c) => {
      let sum = 0;
      for (let i = 0; i < samples; i++) sum += lobe(values[i]!, c);
      return sum / samples;
    });
  const fullCut = levels(full);
  const coarseCut = levels(coarse);
  return { full: fullCut, coarse: coarseCut, meanFull: means(full, fullCut), meanCoarse: means(coarse, coarseCut) };
}

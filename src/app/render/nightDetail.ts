/**
 * Night-detail tiles on the GPU: full-resolution city light around the airports a journey zooms in on
 * (src/shared/timeline/nightDetail.ts plans which, and when). Tiles go into one texture array in plan order;
 * a small index texture says, per cell, which layer holds its tile and whether the cell is covered at all.
 */
import * as THREE from 'three';
import { type DetailCell, DETAIL_COLUMNS, DETAIL_FADE, DETAIL_ROWS, DETAIL_TILE, tileName } from '../../shared/timeline/nightDetail';
import { ASSET_BASE, type Quality } from './assets';

/**
 * Index texels per cell side. The coverage flag is filtered bilinearly, so detail fades out over the outer eighth
 * of a covered cell (about 70 km) wherever its neighbour isn't covered.
 */
const INDEX_SUBDIVISION = 4;
/** Index value for a covered cell with no tile: no light there. */
const DARK = 255;
/** Tiles fetched at once. */
const CONCURRENCY = 8;

export interface NightDetailTextures {
  tiles: THREE.DataArrayTexture;
  index: THREE.DataTexture;
  /** Texels across a cell, and gutter texels on each side. */
  layout: THREE.Vector2;
}

function indexTexture(data: Uint8Array, width: number, height: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, width, height, THREE.RGFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

function tileArray(size: number, layers: number): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(new Uint8Array(size * size * layers), size, size, layers);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

let empty: NightDetailTextures | null = null;

/** No detail anywhere: for the homepage, and until a journey's first tiles arrive. */
export function noNightDetail(): NightDetailTextures {
  empty ??= { tiles: tileArray(1, 1), index: indexTexture(new Uint8Array(2), 1, 1), layout: new THREE.Vector2(1, 0) };
  return empty;
}

/**
 * A journey's night detail. `load` fetches the tiles in plan order and places each as it arrives, so the
 * textures fill in while the journey plays.
 */
export class NightDetail implements NightDetailTextures {
  readonly tiles: THREE.DataArrayTexture;
  readonly index: THREE.DataTexture;
  readonly layout: THREE.Vector2;
  /** The cells with a tile, in plan order: tile i goes in layer i. */
  private readonly lit: DetailCell[];
  private readonly size: number;

  constructor(
    plan: DetailCell[],
    private readonly quality: Quality,
  ) {
    const { cell, gutter } = DETAIL_TILE[quality];
    this.size = cell + 2 * gutter;
    this.layout = new THREE.Vector2(cell, gutter);
    this.lit = plan.filter((c) => c.lit);
    this.tiles = tileArray(this.size, Math.max(1, this.lit.length));
    const width = DETAIL_COLUMNS * INDEX_SUBDIVISION;
    this.index = indexTexture(new Uint8Array(width * DETAIL_ROWS * INDEX_SUBDIVISION * 2), width, DETAIL_ROWS * INDEX_SUBDIVISION);
    // Dark cells are covered from the start: there is nothing to fetch.
    for (const c of plan) if (!c.lit) this.cover(c.cell, DARK);
  }

  /** Mark a cell covered, its tile in `layer` (or DARK). */
  private cover(cell: number, layer: number): void {
    const data = this.index.image.data as Uint8Array;
    const width = DETAIL_COLUMNS * INDEX_SUBDIVISION;
    const x0 = (cell % DETAIL_COLUMNS) * INDEX_SUBDIVISION;
    const y0 = Math.floor(cell / DETAIL_COLUMNS) * INDEX_SUBDIVISION;
    for (let y = y0; y < y0 + INDEX_SUBDIVISION; y++) {
      for (let x = x0; x < x0 + INDEX_SUBDIVISION; x++) {
        data[2 * (y * width + x)] = layer;
        data[2 * (y * width + x) + 1] = 255;
      }
    }
    this.index.needsUpdate = true;
  }

  get tileCount(): number {
    return this.lit.length;
  }

  /** How many tiles the cells needed by frames up to `frame` take. */
  tilesBy(frame: number): number {
    return this.lit.filter((c) => c.frame <= frame).length;
  }

  /**
   * Fetch and place every tile, CONCURRENCY at a time in plan order. After each, `onTile` gets how many tiles,
   * counted from the first in plan order, are in without a gap. Resolves once all are.
   */
  async load(signal: AbortSignal, onTile: (inOrder: number) => void): Promise<void> {
    const context = new OffscreenCanvas(this.size, this.size).getContext('2d', { willReadFrequently: true })!;
    const base = `${ASSET_BASE}/earth-night-detail-${this.quality}/`;
    const placed = new Array<boolean>(this.lit.length).fill(false);
    let inOrder = 0;
    const place = async (layer: number) => {
      const url = base + tileName(this.lit[layer]!.cell);
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Failed to load ${url}`);
      const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      signal.throwIfAborted();
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const rgba = context.getImageData(0, 0, this.size, this.size).data;
      // Rows run north to south in the file and south to north on the GPU, as the globe's texture coordinates do.
      const data = this.tiles.image.data as Uint8Array;
      const offset = layer * this.size * this.size;
      for (let y = 0; y < this.size; y++) {
        const from = (this.size - 1 - y) * this.size * 4;
        const to = offset + y * this.size;
        for (let x = 0; x < this.size; x++) data[to + x] = rgba[from + 4 * x]!;
      }
      this.tiles.addLayerUpdate(layer);
      this.tiles.needsUpdate = true;
      this.cover(this.lit[layer]!.cell, layer);
      placed[layer] = true;
      while (inOrder < placed.length && placed[inOrder]) inOrder++;
      onTile(inOrder);
    };
    let next = 0;
    const worker = async () => {
      while (next < this.lit.length) await place(next++);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, this.lit.length) }, worker));
  }

  dispose(): void {
    this.tiles.dispose();
    this.index.dispose();
  }
}

/**
 * Uniforms for NIGHT_DETAIL_GLSL; keep them current with setNightDetailUniforms.
 */
export function nightDetailUniforms(): Record<string, THREE.IUniform> {
  const none = noNightDetail();
  return {
    nightTiles: { value: none.tiles },
    nightIndex: { value: none.index },
    nightLayout: { value: none.layout },
    detailFade: { value: new THREE.Vector2(...DETAIL_FADE) },
  };
}

export function setNightDetailUniforms(u: Record<string, THREE.IUniform>, detail: NightDetailTextures | null): void {
  const d = detail ?? noNightDetail();
  u.nightTiles!.value = d.tiles;
  u.nightIndex!.value = d.index;
  u.nightLayout!.value = d.layout;
}

/**
 * nightLevel(uv, global, spread): the city light level at a ground point with globe texture coordinates uv,
 * from the global night map's `global` level, swapped for the tile's where the cell is covered and the ground
 * looks close enough (spread: the camera's distance over the cosine of the viewing angle, Earth radii).
 * Derivatives come first, outside any branch.
 */
export const NIGHT_DETAIL_GLSL = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray nightTiles;
uniform sampler2D nightIndex;
uniform vec2 nightLayout;
uniform vec2 detailFade;

float nightLevel(vec2 uv, float global, float spread) {
  const vec2 CELLS = vec2(${DETAIL_COLUMNS.toFixed(1)}, ${DETAIL_ROWS.toFixed(1)});
  vec2 cells = uv * CELLS;
  float size = nightLayout.x + 2.0 * nightLayout.y;
  vec2 dx = dFdx(cells) * (nightLayout.x / size);
  vec2 dy = dFdy(cells) * (nightLayout.x / size);
  float weight = smoothstep(0.5, 1.0, texture2D(nightIndex, uv).g) * (1.0 - smoothstep(detailFade.x, detailFade.y, spread));
  if (weight <= 0.0) return global;
  ivec2 texel = min(ivec2(uv * CELLS * ${INDEX_SUBDIVISION.toFixed(1)}), ivec2(CELLS * ${INDEX_SUBDIVISION.toFixed(1)}) - 1);
  float layer = floor(texelFetch(nightIndex, texel, 0).r * 255.0 + 0.5);
  float detail = 0.0;
  if (layer < ${DARK.toFixed(1)}) {
    vec2 local = (nightLayout.y + fract(cells) * nightLayout.x) / size;
    detail = textureGrad(nightTiles, vec3(local, layer), dx, dy).r;
  }
  return mix(global, detail, weight);
}
`;

import * as THREE from 'three';
import { ASSET_MANIFEST_VERSION } from '../../shared/scene/constants';
import { type Quality, dayTextureWidth } from '../../shared/scene/surface';

export type { Quality };
export { currentSurfaceMonth, journeySurfaceMonth } from '../../shared/scene/surface';

/**
 * Assets follow the renderer, not the record: every journey loads the current set, because the shaders are
 * tuned for it. Records still pin the version they were saved with, and old directories stay deployed so a
 * page loaded from an earlier build keeps working (docs/compatibility.md).
 */
// Follows Vite's base so the same build works at the site root ('/') and from a relative base ('./').
export const ASSET_BASE = `${import.meta.env.BASE_URL}assets/${ASSET_MANIFEST_VERSION}`;
export const LABEL_FONT_FAMILY = 'RouteReplayLabel';

export interface EarthTextures {
  day: THREE.Texture;
  night: THREE.Texture;
  /** Open water (1) versus land (0), for sun glint and sky reflection: one channel, texel for texel with `day`. */
  water: THREE.Texture;
  /** The ground's normal at 12× relief, east and north components (scripts/build-textures.py). */
  relief: THREE.Texture;
  quality: Quality;
  /** Month (1–12) of the Blue Marble surface in `day`. */
  month: number;
}

let maxSize: number | null = null;

/** The largest texture this device's WebGL 2 accepts, probed once with a throwaway context. */
export function maxTextureSize(): number {
  if (maxSize === null) {
    maxSize = 4096;
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (gl) {
        maxSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    } catch {
      // Keep the safe default.
    }
  }
  return maxSize;
}

const textureCache = new Map<string, Promise<THREE.Texture>>();
const setCache = new Map<string, Promise<EarthTextures>>();

/** `format`: what the GPU keeps. RedFormat and RGFormat store one or two channels of the image, a quarter or half of RGBA's memory. */
function loadTexture(
  url: string,
  colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace,
  format: THREE.PixelFormat = THREE.RGBAFormat,
): Promise<THREE.Texture> {
  let p = textureCache.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(
        url,
        (t) => {
          t.colorSpace = colorSpace;
          t.format = format;
          t.anisotropy = 4;
          t.wrapS = THREE.RepeatWrapping;
          resolve(t);
        },
        undefined,
        () => reject(new Error(`Failed to load ${url}`)),
      );
    });
    p.catch(() => textureCache.delete(url));
    textureCache.set(url, p);
  }
  return p;
}

/**
 * Same-origin, versioned Earth textures with the Blue Marble surface for `month` (1–12). Quality changes
 * resolution only, never timing. Only the requested month downloads.
 */
export function loadEarthTextures(quality: Quality, month: number): Promise<EarthTextures> {
  const mm = String(Math.min(12, Math.max(1, Math.round(month)))).padStart(2, '0');
  const width = dayTextureWidth(quality, maxTextureSize());
  const key = `${quality}/${mm}/${width}`;
  let p = setCache.get(key);
  if (!p) {
    p = Promise.all([
      loadTexture(`${ASSET_BASE}/earth-day-${mm}-${width}.webp`),
      loadTexture(`${ASSET_BASE}/earth-night-${quality}.jpg`),
      loadTexture(`${ASSET_BASE}/earth-water-${width}.webp`, THREE.NoColorSpace, THREE.RedFormat),
      loadTexture(`${ASSET_BASE}/earth-relief-${quality}.webp`, THREE.NoColorSpace, THREE.RGFormat),
    ]).then(([day, night, water, relief]) => ({ day, night, water, relief, quality, month: Number(mm) }));
    p.catch(() => setCache.delete(key));
    setCache.set(key, p);
  }
  return p;
}

let fontPromise: Promise<void> | null = null;

/**
 * Load the bundled OFL font for the split-flap airport codes (Barlow Condensed SemiBold, standing in for the offline
 * renderer's DIN Condensed Bold), so canvas-drawn labels look the same on every device.
 */
export function loadLabelFont(): Promise<void> {
  if (!fontPromise) {
    fontPromise = (async () => {
      if (typeof FontFace === 'undefined') return;
      const face = new FontFace(LABEL_FONT_FAMILY, `url(${ASSET_BASE}/BarlowCondensed-SemiBold.ttf)`, { weight: '600' });
      await face.load();
      document.fonts.add(face);
    })().catch(() => {
      // Fall back to the system font rather than blocking playback.
    });
  }
  return fontPromise;
}

import type { NormalizedSceneV1 } from './types';

/**
 * Which month (1–12) of Blue Marble surface a journey shows: the month of its first departure in the origin's
 * local time, as the offline renderer chooses it. `departureLocal` already carries the origin's offset, so its
 * date is the local date. The texture is a 2004 seasonal composite, not imagery from the trip.
 */
export function journeySurfaceMonth(scene: Pick<NormalizedSceneV1, 'legs'>): number {
  const month = Number(scene.legs[0]?.departureLocal.slice(5, 7));
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month : 1;
}

/** The month (1–12) for the homepage globe, whose clock starts now: the current month in UTC. */
export function currentSurfaceMonth(nowMs: number = Date.now()): number {
  return new Date(nowMs).getUTCMonth() + 1;
}

/** Texture quality: resolution only, never timing. */
export type Quality = 'low' | 'standard';

/**
 * Widths of the monthly day textures (equirectangular, 2:1) in public/assets. 8192 gives about 1300 texels
 * per radian, enough for the close airport zoom; 4096 is the light set for phones and the homepage's first paint.
 */
export const DAY_TEXTURE_WIDTHS = [4096, 8192] as const;
const DAY_WIDTH: Record<Quality, number> = { low: 4096, standard: 8192 };

/**
 * The day texture width for a quality on a device whose largest texture is `maxTextureSize`: the quality's
 * width, or the largest that fits. Below 4096, three.js scales the 4096 image down itself.
 */
export function dayTextureWidth(quality: Quality, maxTextureSize: number): number {
  const fits = DAY_TEXTURE_WIDTHS.filter((w) => w <= Math.min(maxTextureSize, DAY_WIDTH[quality]));
  return fits.length ? Math.max(...fits) : DAY_TEXTURE_WIDTHS[0];
}

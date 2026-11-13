/**
 * Which night-detail tiles a journey needs, and when.
 *
 * Everywhere, the globe draws city lights from the global night map (11–20 km per texel). Where the camera comes
 * close, the shader swaps in tiles of the full-resolution Black Marble (about 0.93 km per pixel): one tile per 5°
 * cell that has any light (scripts/build-textures.py). How much of the tile it uses at a ground point depends only
 * on how far the camera is and how obliquely it sees the point (DETAIL_FADE_KM), so preview and export agree at
 * any resolution. The camera is a pure function of the timeline, so the cells every frame needs, and the first
 * frame each is needed, are known before playback starts.
 */
import { EARTH_RADIUS_KM } from '../geo/greatCircle';
import { type Vec3, length, vecToLatLon } from '../geo/vec';
import { NIGHT_TILE_CELLS } from '../scene/nightTiles';
import type { Quality } from '../scene/surface';
import { FOCAL_PX, type Timeline, cameraPositionAt } from './evaluate';

export const DETAIL_DEGREES = 5;
export const DETAIL_COLUMNS = 360 / DETAIL_DEGREES;
export const DETAIL_ROWS = 180 / DETAIL_DEGREES;
/**
 * Tiles per quality (earth-night-detail-<quality>/): texels across a cell, and the neighbouring cells' texels
 * repeated on each side so filtering is seamless across tile edges. Standard is the source's full resolution.
 */
export const DETAIL_TILE: Record<Quality, { cell: number; gutter: number }> = {
  standard: { cell: 600, gutter: 4 },
  low: { cell: 300, gutter: 2 },
};

/**
 * The ground scale at which the detail starts to fade, and where it is gone: kilometres per pixel of a 1080-pixel
 * short side (70° across it), as if the point were at the frame's centre. Straight below the camera that is the
 * true pixel size; off to the side it is the camera's distance divided by the cosine of the viewing angle, and
 * ignores the frame, so the detailed area is a circle whatever the frame's shape. At the closest airport framing
 * (1.35 km per pixel at the centre) the detail is whole for 1,210 km around and gone by 1,540 km, the left and
 * right edges of a 16:9 frame; in between it blurs into the global map. As the camera climbs it lasts at the
 * centre until pixels are 4 km across and is gone by 6 km, where the global night map is magnified only 2×.
 */
export const DETAIL_FADE_KM_PER_PX = [4, 6] as const;
/** The same, as the camera's distance divided by the cosine of the viewing angle, in Earth radii (the shader's unit). */
export const DETAIL_FADE = DETAIL_FADE_KM_PER_PX.map((k) => (k * FOCAL_PX) / EARTH_RADIUS_KM) as [number, number];

/**
 * At most this many tiles (GPU texture layers) per journey. Tiles are taken in the order first needed, so a long
 * journey keeps its earliest airports detailed and draws later ones from the global map.
 */
export const DETAIL_MAX_TILES: Record<Quality, number> = { standard: 128, low: 128 };

let lit: Uint8Array | null = null;

/** Whether a cell (row × DETAIL_COLUMNS + column, rows from 90°S, columns from 180°W) has a tile: any light at all. */
export function cellHasTile(cell: number): boolean {
  if (!lit) lit = Uint8Array.from(atob(NIGHT_TILE_CELLS), (c) => c.charCodeAt(0));
  return ((lit[cell >> 3]! >> (cell & 7)) & 1) === 1;
}

/** A cell's tile file name, from its south-west corner: N50W005.webp is 50–55°N, 5°W–0°. */
export function tileName(cell: number): string {
  const lat = Math.floor(cell / DETAIL_COLUMNS) * DETAIL_DEGREES - 90;
  const lon = (cell % DETAIL_COLUMNS) * DETAIL_DEGREES - 180;
  const pad = (x: number, n: number) => String(Math.abs(x)).padStart(n, '0');
  return `${lat < 0 ? 'S' : 'N'}${pad(lat, 2)}${lon < 0 ? 'W' : 'E'}${pad(lon, 3)}.webp`;
}

const DEG = Math.PI / 180;

/** Angle (radians) from a point (latitude and longitude in degrees) to the nearest point of a cell. */
export function angleToCell(lat: number, lon: number, cell: number): number {
  const lat0 = (Math.floor(cell / DETAIL_COLUMNS) * DETAIL_DEGREES - 90) * DEG;
  const lon0 = (cell % DETAIL_COLUMNS) * DETAIL_DEGREES - 180;
  // At every latitude, distance grows with the difference in longitude, so the nearest point lies on the cell's
  // nearest meridian (or the point's own, inside the cell's span).
  const mid = lon0 + DETAIL_DEGREES / 2;
  const offset = ((((lon - mid + 180) % 360) + 360) % 360) - 180;
  const dLon = (offset - Math.max(-DETAIL_DEGREES / 2, Math.min(DETAIL_DEGREES / 2, offset))) * DEG;
  // Along that meridian, the cosine of the distance is a sin(a) + b cos(a), largest at atan2(a, b) or at an end.
  const phi = lat * DEG;
  const a = Math.sin(phi);
  const b = Math.cos(phi) * Math.cos(dLon);
  const cosine = (x: number) => a * Math.sin(x) + b * Math.cos(x);
  const peak = Math.atan2(a, b);
  const lat1 = lat0 + DETAIL_DEGREES * DEG;
  let best = Math.max(cosine(lat0), cosine(lat1));
  if (peak > lat0 && peak < lat1) best = cosine(peak);
  return Math.acos(Math.max(-1, Math.min(1, best)));
}

/**
 * Angle (radians) from the point below a camera at `position` out to where the detail is gone, or null when it
 * is gone everywhere. A point at angle θ has distance² / (d cos θ − 1) = DETAIL_FADE[1] there.
 */
export function detailRadius(position: Vec3): number | null {
  const d = length(position);
  const s = DETAIL_FADE[1];
  const c = (d * d + 1 + s) / (d * (2 + s));
  return c < 1 ? Math.acos(c) : null;
}

export interface DetailCell {
  /** row × DETAIL_COLUMNS + column, rows from 90°S, columns from 180°W. */
  cell: number;
  /** First frame that draws detail in the cell. */
  frame: number;
  /** Whether it has a tile; cells without one have no light and need no download. */
  lit: boolean;
}

/**
 * The cells a journey draws detail in, in the order first needed (by frame, then nearest the camera first). The
 * plan ends where it would take more than `maxTiles` tiles.
 */
export function planNightDetail(tl: Timeline, maxTiles: number): DetailCell[] {
  const plan: DetailCell[] = [];
  const seen = new Set<number>();
  let tiles = 0;
  let previous: Vec3 | null = null;
  for (let frame = 0; frame < tl.durationInFrames; frame++) {
    const position = cameraPositionAt(tl, frame / tl.fps);
    // Holds keep the camera still.
    if (previous && position[0] === previous[0] && position[1] === previous[1] && position[2] === previous[2]) continue;
    previous = position;
    const radius = detailRadius(position);
    if (radius === null) continue;
    const { lat, lon } = vecToLatLon(position);
    const r = radius / DEG;
    const rowMin = Math.max(0, Math.floor((lat - r + 90) / DETAIL_DEGREES));
    const rowMax = Math.min(DETAIL_ROWS - 1, Math.floor((lat + r + 90) / DETAIL_DEGREES));
    // Columns within the circle's reach in longitude, or all of them when it covers a pole.
    const reach = Math.abs(lat) + r >= 90 ? 180 : Math.asin(Math.min(1, Math.sin(radius) / Math.cos(lat * DEG))) / DEG;
    const colMin = Math.floor((lon - reach + 180) / DETAIL_DEGREES);
    const colMax = reach >= 180 ? colMin + DETAIL_COLUMNS - 1 : Math.floor((lon + reach + 180) / DETAIL_DEGREES);
    const found: { cell: number; angle: number }[] = [];
    for (let row = rowMin; row <= rowMax; row++) {
      for (let c = colMin; c <= colMax; c++) {
        const cell = row * DETAIL_COLUMNS + (((c % DETAIL_COLUMNS) + DETAIL_COLUMNS) % DETAIL_COLUMNS);
        if (seen.has(cell)) continue;
        const angle = angleToCell(lat, lon, cell);
        if (angle < radius) found.push({ cell, angle });
      }
    }
    found.sort((a, b) => a.angle - b.angle);
    for (const { cell } of found) {
      const hasTile = cellHasTile(cell);
      if (hasTile && tiles === maxTiles) return plan;
      seen.add(cell);
      plan.push({ cell, frame, lit: hasTile });
      if (hasTile) tiles++;
    }
  }
  return plan;
}

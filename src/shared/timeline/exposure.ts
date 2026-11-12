/**
 * Camera exposure, as in the offline renderer (routereplay scene_overlays.py scene_exposure and
 * radiometry.py causal_exposure_profile): a coarse diffuse proxy of the globe in view sets a target that
 * puts it at middle grey, within fixed bounds, and the exposure follows that target smoothly, never
 * looking ahead. It is an artistic camera response, not calibrated photometry. Labels, routes, and the
 * aircraft don't count.
 */
import { type Vec3, cross, dot, normalize } from '../geo/vec';

export const EXPOSURE = {
  middleGrey: 0.18,
  min: 0.8,
  max: 2.2,
  /** Seconds for the exposure to cover 63 % of a change. */
  adaptationSeconds: 0.75,
} as const;

/** Rays per side of the metered square. */
const GRID = 12;

/**
 * Mean brightness of the globe in a square view, `tanHalf` its half-width's tangent, from `camera` (Earth
 * radii, Earth frame) looking along `forward` with `up` roughly up. Only rays that hit the Earth count, so a
 * small globe in a black sky is metered on itself. Sunlit ground reads 0.004 + 0.24 cos(zenith).
 */
export function meterGlobe(camera: Vec3, forward: Vec3, up: Vec3, tanHalf: number, sun: Vec3): number {
  const f = normalize(forward);
  const right = normalize(cross(f, up));
  const u = cross(right, f);
  const cc = dot(camera, camera) - 1;
  let sum = 0;
  let hits = 0;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const x = ((i + 0.5) / GRID) * 2 - 1;
      const y = ((j + 0.5) / GRID) * 2 - 1;
      const d = normalize([
        f[0] + (right[0] * x + u[0] * y) * tanHalf,
        f[1] + (right[1] * x + u[1] * y) * tanHalf,
        f[2] + (right[2] * x + u[2] * y) * tanHalf,
      ]);
      const b = dot(camera, d);
      const disc = b * b - cc;
      if (disc < 0) continue;
      const t = -b - Math.sqrt(disc);
      if (t <= 0) continue;
      const p: Vec3 = [camera[0] + d[0] * t, camera[1] + d[1] * t, camera[2] + d[2] * t];
      sum += 0.004 + 0.24 * Math.max(0, dot(p, sun));
      hits++;
    }
  }
  return (hits ? sum / hits : 0) + 0.002;
}

/** The exposure that puts a metered brightness at middle grey, within bounds. */
export function targetExposure(meter: number): number {
  return Math.min(EXPOSURE.max, Math.max(EXPOSURE.min, EXPOSURE.middleGrey / Math.max(meter, 1e-8)));
}

/** One step of adaptation toward `target` over `seconds`, in log exposure. */
export function adaptExposure(current: number, target: number, seconds: number): number {
  const w = -Math.expm1(-Math.max(0, seconds) / EXPOSURE.adaptationSeconds);
  return Math.exp(Math.log(current) + w * (Math.log(target) - Math.log(current)));
}

/** Exposure for each sample of a chronological series of meter readings `dt` seconds apart. */
export function exposureProfile(meters: ArrayLike<number>, dt: number): Float32Array {
  const out = new Float32Array(meters.length);
  let e = meters.length ? targetExposure(meters[0]!) : 1;
  for (let i = 0; i < meters.length; i++) {
    e = i === 0 ? e : adaptExposure(e, targetExposure(meters[i]!), dt);
    out[i] = e;
  }
  return out;
}

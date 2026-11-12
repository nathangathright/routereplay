/**
 * What the camera sees, computed from an evaluated camera state: the framing summary that
 * storyboards report to agents.
 */
import { EARTH_RADIUS_KM, centralAngle } from '../geo/greatCircle';
import { type Vec3, add, cross, dot, length, normalize, scale, sub } from '../geo/vec';
import type { CameraState } from './evaluate';

const DEG = Math.PI / 180;

function basis(camera: CameraState) {
  const forward = normalize(sub(camera.target, camera.position));
  const right = normalize(cross(forward, camera.up));
  const up = cross(right, forward);
  return { forward, right, up };
}

/** Nearest intersection of a ray with the unit sphere (Earth), or null if it misses. */
function hitEarth(origin: Vec3, dir: Vec3): Vec3 | null {
  const b = dot(origin, dir);
  const c = dot(origin, origin) - 1;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = -b - Math.sqrt(disc);
  return s < 0 ? null : add(origin, scale(dir, s));
}

/**
 * The ground point at the centre of the frame and roughly how far the view reaches from it:
 * the great-circle distance to the middle of the nearer frame edges, or to the horizon when
 * an edge shows sky.
 */
export function framing(camera: CameraState, aspect: number): { center: Vec3; viewRadiusKm: number } {
  const { forward, right, up } = basis(camera);
  const center = hitEarth(camera.position, forward) ?? normalize(camera.target);
  const vHalf = (camera.fovDeg * DEG) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  const half = Math.min(vHalf, hHalf);
  const side = vHalf <= hHalf ? up : right;
  const distances: number[] = [];
  for (const sign of [1, -1]) {
    const ray = normalize(add(scale(forward, Math.cos(half)), scale(side, sign * Math.sin(half))));
    const hit = hitEarth(camera.position, ray);
    if (hit) distances.push(centralAngle(center, normalize(hit)));
  }
  const horizon = Math.acos(Math.min(1, 1 / length(camera.position)));
  const angle = distances.length ? distances.reduce((a, b) => a + b, 0) / distances.length : horizon;
  return { center, viewRadiusKm: angle * EARTH_RADIUS_KM };
}

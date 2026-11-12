import type { Quality } from './render/assets';

export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

/** Conservative starting quality: phones and low-memory devices start low. Quality never changes timing. */
export function initialQuality(): Quality {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const small = Math.min(window.screen.width, window.screen.height) < 600;
  const lowMemory = (nav.deviceMemory ?? 8) <= 4;
  const fewCores = (nav.hardwareConcurrency ?? 8) <= 4;
  return small || lowMemory || fewCores ? 'low' : 'standard';
}

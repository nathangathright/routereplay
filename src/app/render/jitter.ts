/**
 * Sub-pixel camera offsets for drawing one moment several times and averaging (display.tsx). A fixed table: the
 * same for every frame, every device and every run, so no frame depends on another and seeking draws what playing
 * draws. Offsets are in pixels, inside ±½, from the Halton (2, 3) sequence, with the centre (0, 0) last: the centre
 * sample's depth is the one the graphics are tested against.
 */

function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  for (let i = index; i > 0; i = Math.floor(i / base)) {
    f /= base;
    r += f * (i % base);
  }
  return r;
}

/** `samples` offsets [x, y] in pixels; the last is the centre. One sample is just the centre. */
export function jitterPattern(samples: number): [number, number][] {
  const n = Math.max(1, Math.floor(samples));
  const out: [number, number][] = [];
  for (let k = 1; k < n; k++) out.push([halton(k, 2) - 0.5, halton(k, 3) - 0.5]);
  out.push([0, 0]);
  return out;
}

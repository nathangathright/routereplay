/**
 * The frame's one display transform (display.tsx), and its inverse for display-referred things drawn among the
 * scene's light. Values are linear; the sRGB encoding follows separately.
 */

/** Per-channel Reinhard after exposure, as three.js's ReinhardToneMapping: x / (1 + x), x = light × exposure. */
export function reinhard(light: number, exposure: number): number {
  const x = Math.max(0, light) * exposure;
  return x / (1 + x);
}

/**
 * Several samples of one pixel (jittered exports, display.tsx): each tone mapped, then averaged, before the sRGB
 * encoding. Tone mapping first keeps a bright edge (glint, a city light) as bright as the share of the pixel it
 * covers; averaging the light first would let one bright sample whiten the whole pixel. One sample is reinhard().
 */
export function averageDisplay(lights: readonly number[], exposure: number): number {
  let sum = 0;
  for (const light of lights) sum += reinhard(light, exposure);
  return sum / Math.max(1, lights.length);
}

/** The brightest display value the inverse reaches: 1 would need unbounded light. It still encodes to 255. */
export const DISPLAY_LIMIT = 0.996;

/** The scene light that reinhard() turns back into `display` at `exposure`. */
export function sceneFromDisplay(display: number, exposure: number): number {
  const c = Math.min(Math.max(display, 0), DISPLAY_LIMIT);
  return c / ((1 - c) * exposure);
}

/**
 * sceneFromDisplay() for shaders. `displayExposure` is the frame's exposure while drawing into linear light, and 0
 * when drawing straight to the frame, where display values are written as they are.
 */
export const SCENE_FROM_DISPLAY_GLSL = /* glsl */ `
uniform float displayExposure;
vec3 sceneFromDisplay(vec3 c) {
  if (displayExposure <= 0.0) return c;
  c = clamp(c, 0.0, ${DISPLAY_LIMIT.toFixed(3)});
  return c / ((1.0 - c) * displayExposure);
}
`;

import { type Vec3, dot, normalize, smoothstep, sub } from '../../shared/geo/vec';

/** Linear RGB. */
export type RGB = [number, number, number];

/** Where a ray toward the Sun starts to pass through appreciable air, in Earth radii: about five Rayleigh scale
 * heights (57.6 km, as drawn in Earth.tsx) up. The drawn shell reaches 1.072, but the air there is negligible. */
const ATMOSPHERE_TOP = 1.045;

/** Glossy white paint, like the aircraft's (linear albedo). */
export const PAINT_ALBEDO = 0.86;
/** Sunlight above the atmosphere: nearly white. */
export const SUN_LIGHT: RGB = [1.0, 0.98, 0.95];
/** Light reflected off a fully lit Earth: faint and blue (artistically brighter than the real ~2 % of sunlight). */
export const EARTH_LIGHT: RGB = [0.12, 0.16, 0.24];
/** Light from a full Moon (artistically far brighter than real moonlight, so a lit Moon shows). */
export const MOON_LIGHT: RGB = [0.05, 0.055, 0.07];
/** What's left with no Sun or Moon: enough to keep the object's shape. */
export const STARLIGHT: RGB = [0.045, 0.05, 0.065];
/** Earthlight comes from behind an object that faces the viewer, so it is wrapped to reach its lower rim. */
export const EARTH_WRAP = 0.35;

/** Relative scattering by colour (Rayleigh, about wavelength⁻⁴ for 680, 550 and 440 nm). */
const SCATTER: RGB = [0.18, 0.42, 1.0];

/**
 * Sunlight reaching a point in space (`observer`, Earth frame, Earth radii) toward the Sun (`sun`, unit vector),
 * as linear RGB with full sunlight near 1. `visible` is the fraction of the Sun's disc above the Earth's limb
 * (sunVisibleFraction). Light that grazes the atmosphere on its way loses blue first, so it turns orange and dims
 * just before the Sun sets behind the planet, as astronauts see at orbital sunset.
 */
export function sunlightAt(observer: Vec3, sun: Vec3, visible: number): RGB {
  // How close the ray toward the Sun passes to the Earth's centre, if the Earth lies along it.
  const along = -dot(observer, sun);
  const miss = along > 0 ? Math.sqrt(Math.max(0, dot(observer, observer) - along * along)) : Infinity;
  const clear = smoothstep(1, ATMOSPHERE_TOP, miss); // 0 grazing the surface, 1 above the atmosphere
  const depth = 6 * (1 - clear) ** 1.5;
  return SUN_LIGHT.map((c, i) => c * visible * Math.exp(-depth * SCATTER[i]!)) as RGB;
}

/** Fraction of the Earth's face that is sunlit, seen from `observer` (0 new, 1 full). */
export function earthPhase(observer: Vec3, sun: Vec3): number {
  return (1 + dot(normalize(observer), sun)) / 2;
}

/** Fraction of the Moon's face (at `moon`) that is sunlit, seen from `observer`. */
export function moonPhase(observer: Vec3, moon: Vec3, sun: Vec3): number {
  return (1 + dot(normalize(sub(observer, moon)), sun)) / 2;
}

const luminance = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * Linear luminance of the flat face of a painted object facing the viewer, from each light's colour and the
 * z component of its direction in view space (+z toward the viewer). Matches the diffuse face term in SunlitButton.
 */
export function faceLuminance(lights: { sun: Vec3; sunZ: number; moon: Vec3; moonZ: number; earth: Vec3; earthZ: number }): number {
  const { sun, sunZ, moon, moonZ, earth, earthZ } = lights;
  const earthWrap = Math.max(0, (earthZ + EARTH_WRAP) / (1 + EARTH_WRAP));
  const light = [0, 1, 2].map(
    (i) => sun[i]! * Math.max(0, sunZ) + moon[i]! * Math.max(0, moonZ) + earth[i]! * earthWrap + STARLIGHT[i]!,
  ) as RGB;
  return PAINT_ALBEDO * luminance(light);
}

export type LabelTone = 'dark' | 'light';

/**
 * Black or white label for a face of linear luminance `y`. They have equal contrast (about 4.5:1) at 0.18; the
 * switch waits slightly past that so a face hovering there doesn't flicker.
 */
export function labelTone(y: number, previous: LabelTone | null): LabelTone {
  const CROSSOVER = 0.182;
  const BAND = 0.01;
  if (previous === 'dark') return y < CROSSOVER - BAND ? 'light' : 'dark';
  if (previous === 'light') return y > CROSSOVER + BAND ? 'dark' : 'light';
  return y >= CROSSOVER ? 'dark' : 'light';
}

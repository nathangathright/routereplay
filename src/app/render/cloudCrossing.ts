/**
 * A craft and the cloud deck: how far under the deck's top it is (its submersion), and how much of the deck veils it.
 *
 * A plane under an overcast is drawn under it. The deck's own shader runs again over the plane's pixels (Clouds.tsx
 * `veilMaterial`): it finds where each pixel's view ray meets the deck's shell, shades that cloud as the deck does, and
 * draws it over the plane at the cloud's opacity × VEIL_MAX × submersion. So broken cloud veils the plane only where its
 * lobes cover it.
 *
 * Submersion comes from the craft's display altitude, not its geometry. The icon is drawn tens of kilometres tall at
 * an airport, so a depth test against the shell would cut through its fuselage. The offline renderer keeps "cloud
 * crossings tied to aircraft altitude rather than icon size" the same way (routereplay `aircraft_blender.py`), and
 * composites the cloud between camera and plane over the plane (`cloudvolume.py`, `render.py`).
 *
 * Everything here is a pure function of the altitude and the deck: nothing carries over from one frame to the next.
 */
import { clamp, smoothstep } from '../../shared/geo/vec';

/** Display heights are the real ones × 12 (CRUISE_DISPLAY in evaluate.ts), in Earth radii. */
const DISPLAY_PER_METRE = 12 / 6_371_000;
/**
 * A craft is wholly under the deck this far below its top: 1 km of real cloud, 12 km as drawn. On a default 6 s leg the
 * climb crosses it in about 0.26 s (u 0.16 → 0.20 of the leg) and the descent in the same at the other end.
 */
export const DECK_DEPTH = 1000 * DISPLAY_PER_METRE;
/**
 * The most of a craft the thickest deck hides, so a plane at the gate under an overcast still reads as a faint shape.
 * Thinner cloud veils less, in proportion to its opacity.
 */
export const VEIL_MAX = 0.65;

/**
 * How far under the deck a craft at display altitude `altitude` is (Earth radii above the ground), for a deck whose top
 * is `top` above the ground: 0 at or above the top, rising smoothly to 1 once DECK_DEPTH below it.
 */
export function submersion(altitude: number, top: number): number {
  return 1 - smoothstep(top - DECK_DEPTH, top, altitude);
}

/**
 * The veil's strength for a craft this far under the deck: what an opaque deck over it hides. The shader multiplies it
 * by the cloud's density there (0–1), carved into lobes and gaps as the deck draws it.
 */
export function veilStrength(under: number): number {
  return VEIL_MAX * clamp(under, 0, 1);
}

/** How much of a craft at `altitude` the deck hides where its density (opacity before its 0.95 ceiling) is `density`. */
export function veil(altitude: number, top: number, density: number): number {
  return veilStrength(submersion(altitude, top)) * clamp(density, 0, 1);
}

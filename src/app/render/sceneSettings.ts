import { createContext, useContext } from 'react';

/**
 * Fidelity a hardware tier sets inside the scene (tier.ts): march steps and shadow-map resolution, never timing,
 * framing or art direction. Provided by the journey composition; elsewhere (the homepage) the defaults apply, which
 * are the phone and laptop tiers' values.
 */
export interface SceneSettings {
  /** Steps in the atmosphere's march (Earth.tsx). */
  airSteps: number;
  /** Texels across each aircraft self-shadow map (craftPaint.ts). */
  craftShadowSize: number;
}

export const DEFAULT_SCENE_SETTINGS: Readonly<SceneSettings> = { airSteps: 8, craftShadowSize: 512 };

const SceneSettingsContext = createContext<Readonly<SceneSettings>>(DEFAULT_SCENE_SETTINGS);

export const SceneSettingsProvider = SceneSettingsContext.Provider;

export function useSceneSettings(): Readonly<SceneSettings> {
  return useContext(SceneSettingsContext);
}

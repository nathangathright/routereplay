import type { NormalizedSceneV1 } from './types';

/** A journey's title: its own, or "<first code> to <last code>". The pages and their link previews both use it. */
export function journeyTitle(scene: NormalizedSceneV1): string {
  return scene.title ?? `${scene.legs[0]!.from} to ${scene.legs[scene.legs.length - 1]!.to}`;
}

/** The choices for a video export, shared by the watch page's Export drawer and the draft chat's export card. */
import type { AspectRatio } from '../shared/scene/constants';
import type { NormalizedSceneV1 } from '../shared/scene/types';
import type { ExportQuality } from './export';

export const QUALITIES: { value: ExportQuality; label: string; detail: string }[] = [
  { value: 'standard', label: 'Standard', detail: '720p' },
  { value: 'high', label: 'High', detail: '1080p' },
];

export const ASPECTS: { value: AspectRatio; label: string; w: number; h: number }[] = [
  { value: '16:9', label: 'Landscape', w: 16, h: 9 },
  { value: '1:1', label: 'Square', w: 12, h: 12 },
  { value: '9:16', label: 'Portrait', w: 9, h: 16 },
];

export function fileName(scene: NormalizedSceneV1, aspect: AspectRatio, ext: string) {
  const route = [scene.legs[0]!.from, ...scene.legs.map((l) => l.to)].join('-').toLowerCase();
  return `routereplay-${route}-${aspect.replace(':', 'x')}.${ext}`;
}

/** The shape that suits the screen the viewer is on, as a starting choice. */
export function screenAspect(): AspectRatio {
  const r = window.innerWidth / Math.max(1, window.innerHeight);
  return r < 0.8 ? '9:16' : r > 1.25 ? '16:9' : '1:1';
}

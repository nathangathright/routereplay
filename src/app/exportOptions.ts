/**
 * Video export on this device, shared by the watch page's Export drawer, the draft chat's export card, and the
 * pages' browser tools: the choices, and running an export through its phases. The renderer itself (export.ts)
 * loads only when an export starts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AspectRatio } from '../shared/scene/constants';
import type { NormalizedSceneV1 } from '../shared/scene/types';
import type { ExportCheck, ExportQuality } from './export';

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

export interface ExportChoice {
  aspect: AspectRatio;
  quality: ExportQuality;
}

export const describeExport = (c: ExportChoice) => {
  const shape = ASPECTS.find((a) => a.value === c.aspect)!;
  const quality = QUALITIES.find((q) => q.value === c.quality)!;
  return `${shape.label} ${shape.value}, ${quality.label} ${quality.detail}`;
};

/** Where an export is: running (checking, then exporting), or how it ended. */
export type ExportPhase =
  | { kind: 'checking' }
  | { kind: 'exporting'; progress: number }
  | { kind: 'unsupported'; reasons: string[] }
  /** `width` and `height`: the video's frame, in pixels. */
  | { kind: 'done'; url: string; name: string; size: number; width: number; height: number }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

export const exportRunning = (p: ExportPhase) => p.kind === 'checking' || p.kind === 'exporting';

/**
 * Export a video on this device: a capability check and a short test export, then the export. Reports each phase,
 * ending with done, unsupported, cancelled or failed. Failure or lack of support never affects playback or sharing.
 */
export async function runExport(scene: NormalizedSceneV1, choice: ExportChoice, signal: AbortSignal, report: (p: ExportPhase) => void) {
  try {
    report({ kind: 'checking' });
    const mod = await import('./export');
    const check: ExportCheck = await mod.checkExportSupport(choice);
    if (!check.ok) return report({ kind: 'unsupported', reasons: check.reasons });
    if (!(await mod.probeExport(scene, check, signal))) {
      return report({ kind: 'unsupported', reasons: ['A short test export did not produce a playable video on this device.'] });
    }
    report({ kind: 'exporting', progress: 0 });
    const blob = await mod.exportVideo(scene, check, (p) => report({ kind: 'exporting', progress: p }), signal);
    report({
      kind: 'done',
      url: URL.createObjectURL(blob),
      name: fileName(scene, choice.aspect, check.container),
      size: blob.size,
      width: check.width,
      height: check.height,
    });
  } catch (e) {
    report(signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', message: e instanceof Error ? e.message : String(e) });
  }
}

/** One export at a time for a page's scene: what's chosen, where it is, and starting or cancelling it. */
export interface ExportJob {
  choice: ExportChoice;
  /** Null until an export starts, and again once the choice changes after one. */
  phase: ExportPhase | null;
  choose: (change: Partial<ExportChoice>) => void;
  /** Start with the current choice, or with `choice`, which becomes the current one. Ignored while one runs. */
  start: (choice?: ExportChoice) => void;
  cancel: () => void;
}

export function useExportJob(scene: NormalizedSceneV1): ExportJob {
  const [choice, setChoice] = useState<ExportChoice>(() => ({ aspect: screenAspect(), quality: 'standard' }));
  const [phase, setPhase] = useState<ExportPhase | null>(null);
  const latestChoice = useRef(choice);
  latestChoice.current = choice;
  const abort = useRef<AbortController | null>(null);

  // A finished file's object URL is released when replaced or when the page goes away.
  useEffect(
    () => () => {
      if (phase?.kind === 'done') URL.revokeObjectURL(phase.url);
    },
    [phase],
  );
  // Leaving the page stops an export.
  useEffect(() => () => abort.current?.abort(), []);

  const choose = useCallback((change: Partial<ExportChoice>) => {
    setChoice((c) => ({ ...c, ...change }));
    // A new choice after an export offers a fresh Export button.
    setPhase((p) => (p && exportRunning(p) ? p : null));
  }, []);

  const start = useCallback(
    (next?: ExportChoice) => {
      if (abort.current) return;
      const c = next ?? latestChoice.current;
      if (next) setChoice(next);
      const controller = new AbortController();
      abort.current = controller;
      void runExport(scene, c, controller.signal, (p) => {
        setPhase(p);
        if (!exportRunning(p) && abort.current === controller) abort.current = null;
      });
    },
    [scene],
  );

  const cancel = useCallback(() => abort.current?.abort(), []);
  return { choice, phase, choose, start, cancel };
}

/** How a page's browser tools start an export and follow it: the watch page's drawer, or the draft's chat. */
export interface ExportPort {
  /** Start an export with this choice, shown where the person saves the file; or why it can't start now. */
  start: (choice: ExportChoice) => { ok: true } | { ok: false; code: string; message: string };
  /** The latest export since the page opened, if any. */
  status: () => ExportPhase | null;
}

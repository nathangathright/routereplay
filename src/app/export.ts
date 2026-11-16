/**
 * Local video export with @remotion/web-renderer. Loaded lazily so playback never pays for it.
 * The same JourneyComposition renders playback and export; only the tier's settings, samples, pixel ratio and
 * capture differ. Exports draw at least laptop settings, and as many jittered samples per frame as the probe
 * projects will fit the time budget (tier.ts).
 */
import type { NormalizedSceneV1 } from '../shared/scene/types';
import { type AspectRatio, RENDER_SIZES } from '../shared/scene/constants';
import { buildTimeline } from '../shared/timeline/evaluate';
import type { JourneyProps } from './remotion/JourneyComposition';
import { JourneyComposition } from './remotion/JourneyComposition';
import {
  EXPORT_MARGIN,
  type ProbeTiming,
  TIERS,
  chooseSamples,
  exportBudgetSeconds,
  exportSampleCandidates,
  exportTier,
  tierDecision,
} from './tier';

export type ExportQuality = 'standard' | 'high';

/** What the viewer picks: the shape of the video and its resolution. */
export interface ExportOptions {
  aspect: AspectRatio;
  quality: ExportQuality;
}

/** Pixel size of each export: 720p-class at standard quality, 1080p-class at high. */
export function exportSize({ aspect, quality }: ExportOptions): { width: number; height: number } {
  const base = RENDER_SIZES[aspect];
  const k = quality === 'high' ? 1.5 : 1;
  return { width: base.width * k, height: base.height * k };
}

export interface ExportCheck {
  ok: boolean;
  reasons: string[];
  container: 'mp4' | 'webm';
  codec: string | null;
  width: number;
  height: number;
}

/**
 * Remotion license. Eligibility for the Free License (individual maintainer; users render their
 * own videos from this app's template) was checked on 2026-11-11 (docs/assets.md). A Company
 * License key can be supplied with VITE_REMOTION_LICENSE_KEY if that ever changes.
 */
const LICENSE_KEY = (import.meta.env.VITE_REMOTION_LICENSE_KEY as string | undefined) || 'free-license';

function composition(scene: NormalizedSceneV1, width: number, height: number) {
  const tl = buildTimeline(scene);
  return {
    id: 'routereplay-journey',
    component: JourneyComposition as unknown as React.ComponentType<Record<string, unknown>>,
    durationInFrames: tl.durationInFrames,
    fps: tl.fps,
    width,
    height,
    calculateMetadata: null,
    defaultProps: {},
  };
}

/** Step 1: check browser APIs, codec, and dimensions. Browser version sniffing is not used. */
export async function checkExportSupport(options: ExportOptions): Promise<ExportCheck> {
  const { width, height } = exportSize(options);
  if (typeof VideoEncoder === 'undefined') {
    return { ok: false, reasons: ['This browser does not provide WebCodecs video encoding.'], container: 'mp4', codec: null, width, height };
  }
  const { canRenderMediaOnWeb } = await import('@remotion/web-renderer');
  for (const container of ['mp4', 'webm'] as const) {
    const r = await canRenderMediaOnWeb({ container, width, height, muted: true });
    if (r.canRender) return { ok: true, reasons: [], container, codec: r.resolvedVideoCodec, width, height };
    if (container === 'webm') {
      return { ok: false, reasons: r.issues.map((i) => i.message), container, codec: null, width, height };
    }
  }
  return { ok: false, reasons: ['No supported codec.'], container: 'mp4', codec: null, width, height };
}

interface RunOptions {
  container: 'mp4' | 'webm';
  width: number;
  height: number;
  frameRange?: [number, number];
  /** Jittered samples per frame (display.tsx); 1 draws each frame once. */
  samples?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number, encodedFrames: number) => void;
}

/** A finished render, and how long it took. */
export interface RunResult {
  blob: Blob;
  frames: number;
  samples: number;
  /** From the start until the first frame was drawn: loading textures, clouds, city lights, and compiling. */
  setupMs: number;
  /**
   * A frame's drawing, capture and encoding: the median time between frames after the first. The median, because a
   * 15-frame probe on a busy machine catches the odd stall that would otherwise dominate its mean.
   */
  msPerFrame: number;
  /** The whole render, start to file. */
  totalMs: number;
}

async function run(scene: NormalizedSceneV1, opts: RunOptions): Promise<RunResult> {
  const { renderMediaOnWeb } = await import('@remotion/web-renderer');
  const samples = opts.samples ?? 1;
  const inputProps: JourneyProps = { scene, settings: TIERS[exportTier(tierDecision().tier)], samples, dpr: 1, capture: true };
  const start = performance.now();
  const stamps: number[] = [];
  const { getBlob } = await renderMediaOnWeb({
    composition: composition(scene, opts.width, opts.height),
    inputProps,
    container: opts.container,
    muted: true,
    frameRange: opts.frameRange ?? null,
    signal: opts.signal,
    videoBitrate: 'high',
    licenseKey: LICENSE_KEY,
    onProgress: (p) => opts.onProgress?.(p.progress, p.encodedFrames),
    // Only timed: the frame goes to the encoder as it came.
    onFrame: (frame) => {
      stamps.push(performance.now());
      return frame;
    },
  });
  const blob = await getBlob();
  const end = performance.now();
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]!);
  gaps.sort((a, b) => a - b);
  return {
    blob,
    frames: stamps.length,
    samples,
    setupMs: (stamps[0] ?? end) - start,
    msPerFrame: gaps.length ? gaps[Math.floor(gaps.length / 2)]! : end - start,
    totalMs: end - start,
  };
}

/** Decode check: the produced file must load as video with the expected dimensions. */
export function decodeCheck(blob: Blob, width: number, height: number): Promise<boolean> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    const done = (ok: boolean) => {
      URL.revokeObjectURL(url);
      resolve(ok);
    };
    v.onloadedmetadata = () => done(v.videoWidth === width && v.videoHeight === height);
    v.onerror = () => done(false);
    setTimeout(() => done(false), 10_000);
    v.src = url;
  });
}

/** What the probe found: whether this device can export, and with how many samples per frame. */
export interface ExportProbe {
  ok: boolean;
  /** Samples per frame for the export. */
  samples: number;
  timing: ProbeTiming;
  /** The export's projected length (setup, then every frame at `samples`), and the budget it had to fit 1.5 times. */
  projectedSeconds: number;
  budgetSeconds: number;
}

/**
 * Step 2: a short real export of the actual scene. Passing it gates the full export, as always: 15 frames from the
 * start, which must decode. Where the device's tier offers more than one sample per frame, two more short renders at
 * the most samples offered, one from the start and one mid-journey, time the cost of samples, and the slower of the
 * two stands for the journey: the start's close airport framing and the flight's whole globe each cost more in some
 * journeys. The export then takes the most samples whose projected length fits the budget (tier.ts). Phones offer
 * one sample, so they probe exactly as before.
 */
export async function probeExport(scene: NormalizedSceneV1, check: ExportCheck, signal?: AbortSignal): Promise<ExportProbe> {
  const tl = buildTimeline(scene);
  const frames = tl.durationInFrames;
  const last = Math.min(frames - 1, 14);
  const candidates = exportSampleCandidates(tierDecision());
  const budgetSeconds = exportBudgetSeconds(frames / tl.fps);
  const base = candidates.length === 1 ? candidates[0]! : 1;
  const sized = { container: check.container, width: check.width, height: check.height, signal };
  const first = await run(scene, { ...sized, frameRange: [0, last], samples: base });
  const ok = first.blob.size > 0 && (await decodeCheck(first.blob, check.width, check.height));
  const timing: ProbeTiming = { base, msAtBase: first.msPerFrame, top: base, msAtTop: null };
  // Worth timing more samples only if one sample leaves room in the budget.
  const room = (frames * first.msPerFrame * EXPORT_MARGIN) / 1000 < budgetSeconds;
  if (ok && candidates.length > 1 && room) {
    const top = candidates[0]!;
    const mid = Math.floor(frames / 2);
    let slowest = 0;
    for (const range of [
      [0, Math.min(frames - 1, 7)],
      [Math.max(0, mid - 4), Math.min(frames - 1, mid + 3)],
    ] as [number, number][]) {
      slowest = Math.max(slowest, (await run(scene, { ...sized, frameRange: range, samples: top })).msPerFrame);
    }
    timing.top = top;
    timing.msAtTop = slowest;
  }
  const chosen = chooseSamples(candidates, timing, frames, budgetSeconds);
  return { ok, samples: chosen.samples, timing, projectedSeconds: first.setupMs / 1000 + chosen.projectedSeconds, budgetSeconds };
}

export async function exportVideo(
  scene: NormalizedSceneV1,
  check: ExportCheck,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
  samples = 1,
): Promise<RunResult> {
  return run(scene, { container: check.container, width: check.width, height: check.height, signal, onProgress, samples });
}

/**
 * Render a frame range for frame-comparison checks (development and browser tests), at ?samples (or one sample)
 * unless `samples` is given.
 */
export async function exportRange(
  scene: NormalizedSceneV1,
  container: 'mp4' | 'webm',
  frameRange: [number, number],
  options: ExportOptions = { aspect: '16:9', quality: 'standard' },
  samples = tierDecision().samples ?? 1,
): Promise<Blob> {
  return (await run(scene, { container, ...exportSize(options), frameRange, samples })).blob;
}

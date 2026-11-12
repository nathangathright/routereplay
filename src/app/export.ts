/**
 * Local video export with @remotion/web-renderer. Loaded lazily so playback never pays for it.
 * The same JourneyComposition renders playback and export; only pixel ratio and capture differ.
 */
import type { NormalizedSceneV1 } from '../shared/scene/types';
import { type AspectRatio, RENDER_SIZES } from '../shared/scene/constants';
import { buildTimeline } from '../shared/timeline/evaluate';
import { JourneyComposition } from './remotion/JourneyComposition';

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
  signal?: AbortSignal;
  onProgress?: (fraction: number, encodedFrames: number) => void;
}

async function run(scene: NormalizedSceneV1, opts: RunOptions): Promise<Blob> {
  const { renderMediaOnWeb } = await import('@remotion/web-renderer');
  const { getBlob } = await renderMediaOnWeb({
    composition: composition(scene, opts.width, opts.height),
    inputProps: { scene, quality: 'standard', dpr: 1, capture: true },
    container: opts.container,
    muted: true,
    frameRange: opts.frameRange ?? null,
    signal: opts.signal,
    videoBitrate: 'high',
    licenseKey: LICENSE_KEY,
    onProgress: (p) => opts.onProgress?.(p.progress, p.encodedFrames),
  });
  return getBlob();
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

/** Step 2: a short real export of the actual scene. Passing it gates the full export. */
export async function probeExport(scene: NormalizedSceneV1, check: ExportCheck, signal?: AbortSignal): Promise<boolean> {
  const tl = buildTimeline(scene);
  const last = Math.min(tl.durationInFrames - 1, 14);
  const blob = await run(scene, { container: check.container, width: check.width, height: check.height, frameRange: [0, last], signal });
  return blob.size > 0 && (await decodeCheck(blob, check.width, check.height));
}

export async function exportVideo(
  scene: NormalizedSceneV1,
  check: ExportCheck,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<Blob> {
  return run(scene, { container: check.container, width: check.width, height: check.height, signal, onProgress });
}

/** Render a frame range for frame-comparison checks (development and browser tests). */
export async function exportRange(
  scene: NormalizedSceneV1,
  container: 'mp4' | 'webm',
  frameRange: [number, number],
  options: ExportOptions = { aspect: '16:9', quality: 'standard' },
): Promise<Blob> {
  return run(scene, { container, ...exportSize(options), frameRange });
}

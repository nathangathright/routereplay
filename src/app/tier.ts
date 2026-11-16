/**
 * Hardware tiers: how much fidelity this device draws, never what it draws or when (docs/decisions.md, "Hardware
 * tiers"). Every tier shows the same moment from the same evaluate(timeline, t), exposure and seeds; a tier only
 * changes resolution, textures, steps and samples. Nothing under src/shared imports this module.
 *
 * - phone: the old `low` quality, constant for constant.
 * - laptop: the old `standard`, constant for constant.
 * - desktop: new, and for now reached only with ?tier=desktop, for measurement.
 *
 * The floor is the old phone rule (device.ts's initialQuality, before tiers) plus the GPU: a software renderer, or no
 * complete RGBA16F framebuffer, also means phone. Everything else starts at laptop. Playback that stays below 20 fps
 * steps one tier down (JourneyPlayer.tsx), and the step is remembered for this GPU and build for a week.
 */
import { RENDERER_VERSION } from '../shared/scene/constants';
import type { Quality } from '../shared/scene/surface';

export type Tier = 'phone' | 'laptop' | 'desktop';

/** Lowest first. */
export const TIER_ORDER: readonly Tier[] = ['phone', 'laptop', 'desktop'];

export interface TierSettings {
  /** The Earth texture set. */
  textures: Quality;
  /** The largest device pixel ratio the playback canvas uses (see pixelRatio()). */
  dprCap: number;
  /** The globe's segments around the equator (the air's are half, at least 48). */
  segments: number;
  /** Steps in the atmosphere's march (Earth.tsx). */
  airSteps: number;
  /** Texels across each aircraft self-shadow map (craftPaint.ts). */
  craftShadowSize: number;
  /** At most this many full-resolution city-light tiles per journey (nightDetail.ts). */
  nightDetailCap: number;
  /** Samples per exported frame to try, largest first: the export probe picks the largest that fits its budget. */
  exportSamples: readonly number[];
}

/**
 * Desktop's 12 atmosphere steps: more steps darken the air only where sunlight grazes the terminator, and 16 made a
 * dusk frame 3.4 % darker than laptop's 8, past the 3 % that tiers may differ by (docs/decisions.md).
 */
export const TIERS: Readonly<Record<Tier, Readonly<TierSettings>>> = {
  phone: { textures: 'low', dprCap: 1, segments: 72, airSteps: 8, craftShadowSize: 512, nightDetailCap: 128, exportSamples: [1] },
  laptop: { textures: 'standard', dprCap: 2, segments: 144, airSteps: 8, craftShadowSize: 512, nightDetailCap: 128, exportSamples: [8, 4, 1] },
  desktop: { textures: 'standard', dprCap: 3, segments: 144, airSteps: 12, craftShadowSize: 1024, nightDetailCap: 256, exportSamples: [8, 4, 1] },
};

/** The playback canvas's pixel ratio: 1 at a cap of 1 (whatever the screen, as `low` always was), else the screen's up to the cap. */
export function pixelRatio(settings: Pick<TierSettings, 'dprCap'>, devicePixelRatio: number): number {
  return settings.dprCap <= 1 ? 1 : Math.min(devicePixelRatio || 1, settings.dprCap);
}

/** One tier down, or null at the bottom. */
export function stepDown(tier: Tier): Tier | null {
  const i = TIER_ORDER.indexOf(tier);
  return i > 0 ? TIER_ORDER[i - 1]! : null;
}

const rank = (tier: Tier) => TIER_ORDER.indexOf(tier);
const lower = (a: Tier, b: Tier): Tier => (rank(a) <= rank(b) ? a : b);

/** Exports draw at least laptop settings, as they always drew `standard` (phones only change the samples). */
export function exportTier(tier: Tier): Tier {
  return rank(tier) < rank('laptop') ? 'laptop' : tier;
}

// ---------------------------------------------------------------------------------------------------------------
// Capabilities

export interface Capabilities {
  /** The screen's short side, CSS pixels. */
  screenShortSide: number;
  /** navigator.deviceMemory (GB, bucketed; Chrome only). */
  deviceMemory: number | null;
  cores: number | null;
  webgl2: boolean;
  /** The WebGL renderer string, unmasked where the browser allows; '' if unknown. Used only to spot software rendering. */
  renderer: string;
  maxTextureSize: number;
  /** The browser refuses a context with failIfMajorPerformanceCaveat: rendering would be in software. */
  performanceCaveat: boolean;
  /** A complete RGBA16F framebuffer: the linear composite, and export accumulation, can run. */
  halfFloatTarget: boolean;
}

let probed: Capabilities | null = null;

/**
 * What this device offers, read once from a throwaway WebGL 2 context (also the source of maxTextureSize() in
 * assets.ts, so the page makes one such context, or two where only a software one is offered).
 */
export function probeCapabilities(): Capabilities {
  if (probed) return probed;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const caps: Capabilities = {
    screenShortSide: Math.min(window.screen.width, window.screen.height),
    deviceMemory: nav.deviceMemory ?? null,
    cores: nav.hardwareConcurrency ?? null,
    webgl2: false,
    renderer: '',
    maxTextureSize: 4096,
    performanceCaveat: false,
    halfFloatTarget: false,
  };
  try {
    let gl = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    if (!gl) {
      // A second canvas: a canvas keeps the first context it was given.
      gl = document.createElement('canvas').getContext('webgl2');
      caps.performanceCaveat = gl !== null;
    }
    if (gl) {
      caps.webgl2 = true;
      caps.maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
      caps.renderer = rendererName(gl);
      caps.halfFloatTarget = halfFloatTarget(gl);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    // Keep the safe defaults.
  }
  probed = caps;
  return caps;
}

function rendererName(gl: WebGL2RenderingContext): string {
  const plain = String(gl.getParameter(gl.RENDERER) ?? '');
  // Chrome masks RENDERER as "WebKit WebGL" and unmasks it through the extension; Firefox and Safari answer directly.
  if (plain && plain !== 'WebKit WebGL') return plain;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? plain) : plain;
}

/** Whether RGBA16F is colour-renderable and a framebuffer with it is complete, rather than trusting the extension. */
function halfFloatTarget(gl: WebGL2RenderingContext): boolean {
  if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return false;
  const fb = gl.createFramebuffer();
  const rb = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA16F, 4, 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteRenderbuffer(rb);
  while (gl.getError() !== gl.NO_ERROR); // a refused format leaves an error behind
  return complete;
}

/** Software rasterizers (Chrome's SwiftShader, Mesa's llvmpipe and softpipe, Windows' Basic Render Driver). */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|lavapipe|basic render|software/i;

/** The machine a remembered step down belongs to. */
export function gpuKey(caps: Capabilities): string {
  return `${caps.renderer}|${caps.maxTextureSize}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The decision

/** A remembered step down, in localStorage under TIER_CACHE_KEY. */
export interface TierCache {
  gpu: string;
  build: string;
  /** The tier playback stepped down to. */
  tier: Tier;
  from: Tier;
  /** When, ms since the epoch. */
  at: number;
}

export const TIER_CACHE_KEY = 'rr.tier';
/** A step down is forgotten after a week, or when the GPU or the renderer build changes. */
export const STEP_DOWN_MEMORY_MS = 7 * 24 * 3600 * 1000;

export interface TierDecision {
  tier: Tier;
  /** Why, in a few words (shown by ?measure). */
  reason: string;
  /** ?debug or ?samples: the tier never steps down, so comparisons and measurements don't drift with the machine. */
  pinned: boolean;
  /** ?samples=N, or 1 under ?debug: samples per frame for preview and export instead of the export probe's choice. */
  samples: number | null;
}

const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIER_ORDER as readonly string[]).includes(v);

/** At most this many samples per frame from ?samples. */
export const MAX_SAMPLES = 32;

function samplesParam(params: URLSearchParams): number | null {
  const raw = params.get('samples');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_SAMPLES) : null;
}

/** Today's phone rule, and the GPU's floor: the reasons this device draws at phone tier, if any. */
export function phoneFloor(caps: Capabilities): string[] {
  const why: string[] = [];
  if (caps.screenShortSide < 600) why.push(`screen ${caps.screenShortSide} px`);
  if ((caps.deviceMemory ?? 8) <= 4) why.push(`${caps.deviceMemory} GB memory`);
  if ((caps.cores ?? 8) <= 4) why.push(`${caps.cores} cores`);
  if (!caps.webgl2) why.push('no WebGL 2');
  else {
    if (caps.performanceCaveat || SOFTWARE.test(caps.renderer)) why.push(`software renderer (${caps.renderer || 'major performance caveat'})`);
    if (!caps.halfFloatTarget) why.push('no half-float target');
  }
  return why;
}

/**
 * The tier for this device. Pure, for tests: `params` is the page's query, `cache` the remembered step down.
 *
 * 1. ?tier=phone|laptop|desktop starts there (playback may still step down, unless pinned).
 * 2. ?debug pins laptop, or the ?tier given; ?samples pins whichever tier is chosen.
 * 3. The floor (phoneFloor) means phone.
 * 4. Otherwise laptop, or lower if playback stepped down on this GPU and build within the week.
 */
export function chooseTier(caps: Capabilities, params: URLSearchParams, cache: TierCache | null, now: number): TierDecision {
  const debug = params.has('debug');
  const asked = samplesParam(params);
  const samples = asked ?? (debug ? 1 : null);
  const pinned = debug || asked !== null;
  const named = params.get('tier');
  if (isTier(named)) return { tier: named, reason: `?tier=${named}`, pinned, samples };
  if (debug) return { tier: 'laptop', reason: '?debug', pinned: true, samples };
  const floor = phoneFloor(caps);
  if (floor.length) return { tier: 'phone', reason: floor.join(', '), pinned, samples };
  if (cache && cache.gpu === gpuKey(caps) && cache.build === RENDERER_VERSION && now - cache.at >= 0 && now - cache.at < STEP_DOWN_MEMORY_MS) {
    const tier = lower(cache.tier, 'laptop');
    const day = new Date(cache.at).toISOString().slice(0, 10);
    return { tier, reason: `stepped down from ${cache.from} on ${day}`, pinned, samples };
  }
  return { tier: 'laptop', reason: 'default', pinned, samples };
}

export function readTierCache(storage: Pick<Storage, 'getItem'> | null): TierCache | null {
  try {
    const raw = storage?.getItem(TIER_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<TierCache>;
    if (typeof c.gpu !== 'string' || typeof c.build !== 'string' || !isTier(c.tier) || !isTier(c.from) || typeof c.at !== 'number') return null;
    return c as TierCache;
  } catch {
    return null;
  }
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let decided: TierDecision | null = null;

/** This page's tier decision, made once. */
export function tierDecision(): TierDecision {
  decided ??= chooseTier(probeCapabilities(), new URLSearchParams(location.search), readTierCache(storage()), Date.now());
  return decided;
}

/** Remember that playback stepped down from `from` to `to`, so the next visit on this GPU and build starts there. */
export function rememberStepDown(from: Tier, to: Tier): void {
  const entry: TierCache = { gpu: gpuKey(probeCapabilities()), build: RENDERER_VERSION, tier: to, from, at: Date.now() };
  try {
    storage()?.setItem(TIER_CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Private windows and full storage just don't remember.
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Export samples

/** How long an export may take, in seconds: the larger of 90 s and three times the clip. */
export function exportBudgetSeconds(clipSeconds: number): number {
  return Math.max(90, 3 * clipSeconds);
}

/** The projection must fit the budget this many times over: the probe can't see every frame's cost. */
export const EXPORT_MARGIN = 1.5;

/** The samples per frame an export may try: the override, else the device tier's candidates, largest first. */
export function exportSampleCandidates(decision: Pick<TierDecision, 'tier' | 'samples'>): number[] {
  if (decision.samples !== null) return [decision.samples];
  return [...TIERS[decision.tier].exportSamples].sort((a, b) => b - a);
}

/** What the export probe measured: ms a frame at `base` samples, and at `top` samples (null if not probed). */
export interface ProbeTiming {
  base: number;
  msAtBase: number;
  top: number;
  msAtTop: number | null;
}

/** ms a frame at `samples`: along the line through the probe's two measurements, never cheaper per sample than free. */
export function projectedMsPerFrame(samples: number, timing: ProbeTiming): number {
  if (timing.msAtTop === null || timing.top === timing.base) return timing.msAtBase;
  const perSample = Math.max(0, (timing.msAtTop - timing.msAtBase) / (timing.top - timing.base));
  return Math.max(0, timing.msAtBase + (samples - timing.base) * perSample);
}

/**
 * The largest candidate whose projected export, times EXPORT_MARGIN, fits the budget; the smallest candidate if none
 * does (an export always runs, as before).
 */
export function chooseSamples(
  candidates: readonly number[],
  timing: ProbeTiming,
  frames: number,
  budgetSeconds: number,
): { samples: number; projectedSeconds: number } {
  const sorted = [...candidates].sort((a, b) => b - a);
  const project = (n: number) => (frames * projectedMsPerFrame(n, timing)) / 1000;
  for (const n of sorted) {
    if (project(n) * EXPORT_MARGIN <= budgetSeconds) return { samples: n, projectedSeconds: project(n) };
  }
  const n = sorted[sorted.length - 1] ?? 1;
  return { samples: n, projectedSeconds: project(n) };
}

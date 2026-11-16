import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RENDERER_VERSION } from '../../src/shared/scene/constants';
import { DETAIL_MAX_TILES, planNightDetail } from '../../src/shared/timeline/nightDetail';
import { buildTimeline, evaluate, exposureAt } from '../../src/shared/timeline/evaluate';
import { jitterPattern } from '../../src/app/render/jitter';
import { DEFAULT_SCENE_SETTINGS } from '../../src/app/render/sceneSettings';
import {
  type Capabilities,
  EXPORT_MARGIN,
  STEP_DOWN_MEMORY_MS,
  TIERS,
  type TierCache,
  chooseSamples,
  chooseTier,
  exportBudgetSeconds,
  exportSampleCandidates,
  exportTier,
  gpuKey,
  pixelRatio,
  projectedMsPerFrame,
  readTierCache,
  stepDown,
} from '../../src/app/tier';

/** device.ts's initialQuality before tiers, verbatim but for its inputs. */
function initialQualityBefore(screen: { width: number; height: number }, nav: { deviceMemory?: number; hardwareConcurrency?: number }) {
  const small = Math.min(screen.width, screen.height) < 600;
  const lowMemory = (nav.deviceMemory ?? 8) <= 4;
  const fewCores = (nav.hardwareConcurrency ?? 8) <= 4;
  return small || lowMemory || fewCores ? 'low' : 'standard';
}

/** The pixel ratio JourneyPlayer used before tiers. */
const dprBefore = (quality: 'low' | 'standard', devicePixelRatio: number) => (quality === 'standard' ? Math.min(devicePixelRatio || 1, 2) : 1);

const M1: Capabilities = {
  screenShortSide: 1117,
  deviceMemory: 8,
  cores: 10,
  webgl2: true,
  renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)',
  maxTextureSize: 16384,
  performanceCaveat: false,
  halfFloatTarget: true,
};
const NOW = Date.parse('2026-11-15T12:00:00Z');
const none = new URLSearchParams();
const q = (s: string) => new URLSearchParams(s);

describe('choosing a tier', () => {
  it('gives phone exactly where the old initialQuality gave low, on a capable GPU', () => {
    let phones = 0;
    for (const width of [320, 390, 393, 599, 600, 768, 1080, 1440, 2560]) {
      for (const height of [599, 600, 844, 1920]) {
        for (const deviceMemory of [undefined, 0.5, 2, 4, 8]) {
          for (const hardwareConcurrency of [undefined, 2, 4, 6, 8, 12]) {
            const before = initialQualityBefore({ width, height }, { deviceMemory, hardwareConcurrency });
            const caps = { ...M1, screenShortSide: Math.min(width, height), deviceMemory: deviceMemory ?? null, cores: hardwareConcurrency ?? null };
            const { tier } = chooseTier(caps, none, null, NOW);
            expect(tier).toBe(before === 'low' ? 'phone' : 'laptop');
            if (tier === 'phone') phones++;
          }
        }
      }
    }
    expect(phones).toBeGreaterThan(0);
  });

  it('gives phone to software renderers, wherever the old rule gave standard', () => {
    for (const renderer of [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'Google SwiftShader',
      'llvmpipe (LLVM 15.0.7, 256 bits)',
      'Mesa softpipe',
      'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ]) {
      const decision = chooseTier({ ...M1, renderer }, none, null, NOW);
      expect(decision.tier).toBe('phone');
      expect(decision.reason).toContain('software renderer');
    }
    // A browser that refuses a context with failIfMajorPerformanceCaveat, whatever the renderer says.
    expect(chooseTier({ ...M1, renderer: 'Apple GPU', performanceCaveat: true }, none, null, NOW).tier).toBe('phone');
    // Hardware renderers, masked or not, stay laptop.
    for (const renderer of ['Apple GPU', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Mali-G78', 'WebKit WebGL', '']) {
      expect(chooseTier({ ...M1, renderer }, none, null, NOW).tier).toBe('laptop');
    }
  });

  it('gives phone without a complete half-float target or without WebGL 2', () => {
    expect(chooseTier({ ...M1, halfFloatTarget: false }, none, null, NOW)).toMatchObject({ tier: 'phone', reason: 'no half-float target' });
    expect(chooseTier({ ...M1, webgl2: false, halfFloatTarget: false }, none, null, NOW)).toMatchObject({ tier: 'phone', reason: 'no WebGL 2' });
  });

  it('starts at the tier asked for with ?tier, even below the floor, and lets it step down', () => {
    const phone = { ...M1, screenShortSide: 393, cores: 4 };
    expect(chooseTier(phone, q('tier=desktop'), null, NOW)).toEqual({ tier: 'desktop', reason: '?tier=desktop', pinned: false, samples: null });
    expect(chooseTier(M1, q('tier=phone'), null, NOW).tier).toBe('phone');
    expect(chooseTier(M1, q('tier=ultra'), null, NOW).tier).toBe('laptop');
  });

  it('pins laptop under ?debug, or the ?tier given, at one sample unless ?samples says otherwise', () => {
    const phone = { ...M1, screenShortSide: 393 };
    expect(chooseTier(phone, q('debug'), null, NOW)).toEqual({ tier: 'laptop', reason: '?debug', pinned: true, samples: 1 });
    expect(chooseTier(M1, q('debug&tier=desktop'), null, NOW)).toEqual({ tier: 'desktop', reason: '?tier=desktop', pinned: true, samples: 1 });
    expect(chooseTier(M1, q('debug&samples=8'), null, NOW)).toMatchObject({ tier: 'laptop', pinned: true, samples: 8 });
  });

  it('takes ?samples as a whole number of at least one, at most 32, and pins the tier with it', () => {
    expect(chooseTier(M1, q('samples=4'), null, NOW)).toMatchObject({ tier: 'laptop', pinned: true, samples: 4 });
    expect(chooseTier(M1, q('samples=100'), null, NOW).samples).toBe(32);
    for (const bad of ['samples=0', 'samples=-2', 'samples=2.5', 'samples=x', 'samples=']) {
      expect(chooseTier(M1, q(bad), null, NOW)).toMatchObject({ pinned: false, samples: null });
    }
  });

  it('starts where playback last stepped down, on the same GPU and build, for a week', () => {
    const cache: TierCache = { gpu: gpuKey(M1), build: RENDERER_VERSION, tier: 'phone', from: 'laptop', at: NOW - 3600_000 };
    expect(chooseTier(M1, none, cache, NOW)).toMatchObject({ tier: 'phone', reason: 'stepped down from laptop on 2026-11-15' });
    expect(chooseTier({ ...M1, renderer: 'Apple GPU' }, none, cache, NOW).tier).toBe('laptop');
    expect(chooseTier({ ...M1, maxTextureSize: 8192 }, none, cache, NOW).tier).toBe('laptop');
    expect(chooseTier(M1, none, { ...cache, build: '2.4.0' }, NOW).tier).toBe('laptop');
    expect(chooseTier(M1, none, { ...cache, at: NOW - STEP_DOWN_MEMORY_MS }, NOW).tier).toBe('laptop');
    expect(chooseTier(M1, none, { ...cache, at: NOW + 60_000 }, NOW).tier).toBe('laptop');
    // A remembered tier never promotes, and an override or the floor wins over it.
    expect(chooseTier(M1, none, { ...cache, tier: 'desktop', from: 'desktop' }, NOW).tier).toBe('laptop');
    expect(chooseTier(M1, none, { ...cache, tier: 'laptop', from: 'desktop' }, NOW).tier).toBe('laptop');
    expect(chooseTier(M1, q('tier=laptop'), cache, NOW).tier).toBe('laptop');
  });

  it('reads the cache defensively', () => {
    const store = (v: string | null) => ({ getItem: () => v });
    const good: TierCache = { gpu: 'g', build: '2.5.0', tier: 'phone', from: 'laptop', at: 1 };
    expect(readTierCache(store(JSON.stringify(good)))).toEqual(good);
    expect(readTierCache(store(null))).toBeNull();
    expect(readTierCache(store('{'))).toBeNull();
    expect(readTierCache(store(JSON.stringify({ ...good, tier: 'tablet' })))).toBeNull();
    expect(readTierCache(store(JSON.stringify({ ...good, at: '1' })))).toBeNull();
    expect(readTierCache({ getItem: () => { throw new Error('SecurityError'); } })).toBeNull();
    expect(readTierCache(null)).toBeNull();
  });

  it('steps down desktop, laptop, phone, then stops', () => {
    expect(stepDown('desktop')).toBe('laptop');
    expect(stepDown('laptop')).toBe('phone');
    expect(stepDown('phone')).toBeNull();
  });
});

describe('tier settings', () => {
  it('phone is the old low quality, constant for constant', () => {
    const phone = TIERS.phone;
    expect(phone.textures).toBe('low');
    expect(phone.segments).toBe(72);
    expect(phone.nightDetailCap).toBe(DETAIL_MAX_TILES.low);
    expect(phone.airSteps).toBe(8);
    expect(phone.craftShadowSize).toBe(512);
    expect(phone.exportSamples).toEqual([1]);
    for (const ratio of [0.5, 0.9, 1, 2, 3, 0]) expect(pixelRatio(phone, ratio)).toBe(dprBefore('low', ratio));
  });

  it('laptop is the old standard quality, constant for constant', () => {
    const laptop = TIERS.laptop;
    expect(laptop.textures).toBe('standard');
    expect(laptop.segments).toBe(144);
    expect(laptop.nightDetailCap).toBe(DETAIL_MAX_TILES.standard);
    expect(laptop.airSteps).toBe(8);
    expect(laptop.craftShadowSize).toBe(512);
    for (const ratio of [0.5, 0.9, 1, 1.5, 2, 3, 0]) expect(pixelRatio(laptop, ratio)).toBe(dprBefore('standard', ratio));
  });

  it('phone and laptop match the scene defaults that the homepage draws with', () => {
    for (const tier of [TIERS.phone, TIERS.laptop]) {
      expect({ airSteps: tier.airSteps, craftShadowSize: tier.craftShadowSize }).toEqual(DEFAULT_SCENE_SETTINGS);
    }
  });

  it('desktop changes only fidelity: the same textures and segments, more of everything else', () => {
    const { desktop, laptop } = TIERS;
    expect(desktop.textures).toBe(laptop.textures);
    expect(desktop.segments).toBe(laptop.segments);
    expect(desktop.airSteps).toBeGreaterThan(laptop.airSteps);
    expect(desktop.airSteps % 2).toBe(0);
    expect(desktop.craftShadowSize).toBeGreaterThan(laptop.craftShadowSize);
    expect(desktop.nightDetailCap).toBeLessThanOrEqual(256); // WebGL 2's least MAX_ARRAY_TEXTURE_LAYERS
    expect(desktop.dprCap).toBeGreaterThanOrEqual(laptop.dprCap);
  });

  it('exports at laptop settings or better, with one sample on phones', () => {
    expect(exportTier('phone')).toBe('laptop');
    expect(exportTier('laptop')).toBe('laptop');
    expect(exportTier('desktop')).toBe('desktop');
    expect(exportSampleCandidates({ tier: 'phone', samples: null })).toEqual([1]);
    expect(exportSampleCandidates({ tier: 'laptop', samples: null })).toEqual([16, 8, 4, 1]);
    expect(exportSampleCandidates({ tier: 'phone', samples: 8 })).toEqual([8]);
  });
});

describe('the jitter pattern', () => {
  it('is fixed, ends at the centre, and stays inside half a pixel', () => {
    for (let n = 1; n <= 32; n++) {
      const p = jitterPattern(n);
      expect(p).toEqual(jitterPattern(n));
      expect(p).toHaveLength(n);
      expect(p[n - 1]).toEqual([0, 0]);
      for (const [x, y] of p) {
        expect(Math.abs(x)).toBeLessThan(0.5);
        expect(Math.abs(y)).toBeLessThan(0.5);
      }
      expect(new Set(p.map(([x, y]) => `${x},${y}`)).size).toBe(n);
    }
    expect(jitterPattern(1)).toEqual([[0, 0]]);
  });

  it('is centred: its mean offset is under 1/N of a pixel', () => {
    for (let n = 1; n <= 32; n++) {
      const p = jitterPattern(n);
      const mx = p.reduce((s, [x]) => s + x, 0) / n;
      const my = p.reduce((s, [, y]) => s + y, 0) / n;
      expect(Math.abs(mx)).toBeLessThan(1 / n);
      expect(Math.abs(my)).toBeLessThan(1 / n);
    }
  });

  it('covers the pixel: besides the centre, every quadrant gets a sample from eight on', () => {
    for (const n of [8, 16, 32]) {
      const quadrants = new Set(jitterPattern(n).slice(0, -1).map(([x, y]) => `${x >= 0}${y >= 0}`));
      expect(quadrants.size).toBe(4);
    }
  });
});

describe('choosing export samples', () => {
  const timing = { base: 1, msAtBase: 20, top: 16, msAtTop: 110 };

  it('budgets the larger of 90 s and three times the clip', () => {
    expect(exportBudgetSeconds(10.3)).toBe(90);
    expect(exportBudgetSeconds(30)).toBe(90);
    expect(exportBudgetSeconds(120)).toBe(360);
  });

  it('projects each sample count along the line through the two probes', () => {
    expect(projectedMsPerFrame(1, timing)).toBe(20);
    expect(projectedMsPerFrame(16, timing)).toBe(110);
    expect(projectedMsPerFrame(8, timing)).toBe(62);
    expect(projectedMsPerFrame(8, { ...timing, msAtTop: null })).toBe(20);
    // A second probe that came out cheaper doesn't make samples free of charge below zero.
    expect(projectedMsPerFrame(8, { ...timing, msAtTop: 15 })).toBe(20);
  });

  it('takes the most samples whose projection fits the budget with the margin', () => {
    // Singapore–Hong Kong at 720p: 309 frames, 34 s at 16 samples, 51 s with the margin.
    expect(chooseSamples([16, 8, 4, 1], timing, 309, 90)).toEqual({ samples: 16, projectedSeconds: (309 * 110) / 1000 });
    // 1,800 frames: 16 samples would take 198 s (297 with the margin); 8 take 112 s (167); 4 take 58 s (87).
    expect(chooseSamples([16, 8, 4, 1], timing, 1800, 120).samples).toBe(4);
    expect(chooseSamples([1, 4, 8, 16], timing, 1800, 168).samples).toBe(8);
    for (const frames of [30, 300, 900, 1800, 3600]) {
      for (const budget of [90, 180, 360]) {
        const { samples, projectedSeconds } = chooseSamples([16, 8, 4, 1], timing, frames, budget);
        if (samples > 1) expect(projectedSeconds * EXPORT_MARGIN).toBeLessThanOrEqual(budget);
        const larger = [16, 8, 4].filter((n) => n > samples);
        for (const n of larger) expect(((frames * projectedMsPerFrame(n, timing)) / 1000) * EXPORT_MARGIN).toBeGreaterThan(budget);
      }
    }
  });

  it('still exports, at the fewest samples, when nothing fits; and a single candidate is just taken', () => {
    expect(chooseSamples([16, 8, 4, 1], { base: 1, msAtBase: 500, top: 16, msAtTop: 2000 }, 3600, 360).samples).toBe(1);
    expect(chooseSamples([1], { base: 1, msAtBase: 20, top: 1, msAtTop: null }, 309, 90)).toEqual({ samples: 1, projectedSeconds: 309 * 0.02 });
    expect(chooseSamples([8], { base: 8, msAtBase: 60, top: 8, msAtTop: null }, 99999, 90).samples).toBe(8);
  });
});

describe('no tier in the timeline', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
    });

  it('nothing under src/shared imports the app, so no tier reaches evaluate, exposure, labels or storyboards', () => {
    const shared = new URL('../../src/shared', import.meta.url).pathname;
    const offenders = files(shared).filter((f) => /from\s+['"][^'"]*\/app\/|from\s+['"][^'"]*tier['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('keeps the timeline functions’ parameters: the timeline, a time, and (for evaluate) the frame’s shape', () => {
    expect(buildTimeline.length).toBe(1);
    expect(evaluate.length).toBe(2); // (timeline, t, aspect = default)
    expect(exposureAt.length).toBe(2);
    expect(planNightDetail.length).toBe(2); // (timeline, cap): only a cap, whatever the tier
  });
});

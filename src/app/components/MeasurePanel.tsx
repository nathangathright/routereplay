import { useEffect, useRef, useState, type RefObject } from 'react';
import type { NormalizedSceneV1 } from '../../shared/scene/types';
import type { JourneyPlayerHandle } from './JourneyPlayer';

/**
 * Device budget measurement, shown only with ?measure on a watch page. Records load and
 * first-frame times, transfer, rendered frame rate during playback, GPU details, and a full
 * local export, and displays them on the page so they can be read off a real device.
 * Nothing is sent anywhere.
 */
type Result = Record<string, string | number | boolean | null>;

declare global {
  interface Window {
    __rrRenderedFrames?: number;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gpuInfo(): Result {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return { webgl2: false };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      webgl2: true,
      gpu: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
      maxTexture: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
    };
  } catch {
    return { webgl2: false };
  }
}

export function MeasurePanel({ scene, player }: { scene: NormalizedSceneV1; player: RefObject<JourneyPlayerHandle | null> }) {
  const [result, setResult] = useState<Result>({ status: 'starting' });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const set = (patch: Result) => setResult((r) => ({ ...r, ...patch }));
    (async () => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const nav2 = navigator as Navigator & { deviceMemory?: number };
      set({
        ua: navigator.userAgent.replace(/^Mozilla\/5\.0 /, ''),
        screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
        cores: navigator.hardwareConcurrency ?? null,
        memoryGB: nav2.deviceMemory ?? null,
        videoEncoder: typeof VideoEncoder !== 'undefined',
        ...gpuInfo(),
      });
      for (let i = 0; i < 300 && !player.current; i++) await sleep(100);
      const p = player.current;
      if (!p) return set({ status: 'no player' });
      const rendered = await p.whenRendered(scene, 60_000);
      const firstFrameMs = Math.round(performance.now());
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const transfer = resources.reduce((s, e) => s + (e.transferSize || 0), nav?.transferSize ?? 0);
      const textures = resources.filter((e) => e.name.includes('/earth-')).map((e) => e.name.split('/').pop()?.replace('.jpg', ''));
      set({
        status: 'measuring playback',
        firstFrameRendered: rendered,
        firstFrameMs,
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        transferKiB: Math.round(transfer / 1024),
        textures: textures.join(', '),
        quality: (document.querySelector('#quality') as HTMLSelectElement | null)?.value ?? null,
      });

      // Playback: count frames the scene actually rendered while playing for 6 s.
      await sleep(500);
      p.seekSeconds(0, true);
      await sleep(500);
      window.__rrRenderedFrames = 0;
      const intervals: number[] = [];
      let last = performance.now();
      let running = true;
      const tick = (t: number) => {
        intervals.push(t - last);
        last = t;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const t0 = performance.now();
      const s0 = p.currentSeconds();
      p.play();
      await sleep(6000);
      running = false;
      p.pause();
      const elapsed = (performance.now() - t0) / 1000;
      const advanced = p.currentSeconds() - s0;
      intervals.sort((a, b) => a - b);
      const q = (f: number) => +(intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * f))] ?? 0).toFixed(1);
      set({
        status: 'measuring export',
        renderedFps: +((window.__rrRenderedFrames ?? 0) / elapsed).toFixed(1),
        playbackSpeed: +(advanced / elapsed).toFixed(2),
        rafMedianMs: q(0.5),
        rafP95Ms: q(0.95),
        qualityAfterPlayback: (document.querySelector('#quality') as HTMLSelectElement | null)?.value ?? null,
      });

      // Export: capability check, probe, full render (kept in memory, not downloaded).
      try {
        const mod = await import('../export');
        const e0 = performance.now();
        const check = await mod.checkExportSupport({ aspect: '16:9', quality: 'standard' });
        if (!check.ok) return set({ status: 'done', exportSupported: false, exportReason: check.reasons.join('; ') });
        const probe = await mod.probeExport(scene, check);
        set({ exportSupported: true, exportContainer: check.container, exportCodec: check.codec, probeOk: probe });
        if (!probe) return set({ status: 'done' });
        const f0 = performance.now();
        const blob = await mod.exportVideo(scene, check, () => undefined, new AbortController().signal);
        const decoded = await mod.decodeCheck(blob, check.width, check.height);
        set({
          status: 'done',
          exportSeconds: +((performance.now() - f0) / 1000).toFixed(1),
          exportTotalSeconds: +((performance.now() - e0) / 1000).toFixed(1),
          exportMB: +(blob.size / 1_048_576).toFixed(1),
          exportDecodes: decoded,
          clipSeconds: scene.presentation.durationSeconds,
        });
      } catch (err) {
        set({ status: 'done', exportError: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, [scene, player]);

  return (
    <section className="panel" aria-live="polite" id="measure-panel">
      <h2>Device measurement</h2>
      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, margin: 0, fontFamily: 'var(--mono)' }}>
        {Object.entries(result)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n')}
      </pre>
    </section>
  );
}

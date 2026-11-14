import { Player, type PlayerRef } from '@remotion/player';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { RENDER_SIZES } from '../../shared/scene/constants';
import type { NormalizedSceneV1 } from '../../shared/scene/types';
import { buildTimeline } from '../../shared/timeline/evaluate';
import { JourneyComposition, type JourneyProps } from '../remotion/JourneyComposition';
import type { Quality } from '../render/assets';
import { initialQuality } from '../device';
import type { SceneStats } from '../render/JourneyScene';

export type QualityMode = 'auto' | Quality;

export interface JourneyPlayerHandle {
  seekSeconds(seconds: number, pause?: boolean): number;
  pause(): void;
  play(): void;
  /** Show a moment: jump to `seconds`, pausing there unless `playing` is true; or just play (true) or pause (false). */
  show(seconds?: number, playing?: boolean): void;
  currentSeconds(): number;
  isPlaying(): boolean;
  /** Resolves once a frame of the given scene object has rendered with loaded assets. */
  whenRendered(scene: NormalizedSceneV1, timeoutMs?: number): Promise<boolean>;
}

export { initialQuality, webglAvailable } from '../device';

interface Props {
  scene: NormalizedSceneV1;
  qualityMode: QualityMode;
  onQualityDowngrade?: () => void;
  onFrame?: (frame: number) => void;
  onContextLost?: () => void;
  onPlayingChange?: (playing: boolean) => void;
  autoPlay?: boolean;
  /** Fill the parent edge to edge, framing the scene for its shape, with no built-in controls. */
  fill?: boolean;
}

/**
 * Layout size of an element in CSS pixels, kept current as it resizes. Transforms don't count: a phone's floating
 * window (pip.ts) shrinks the stage with one, and the journey should keep its frame.
 */
function useElementSize(ref: React.RefObject<HTMLElement | null>, enabled: boolean) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const measure = () => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      if (width > 0 && height > 0) setSize((s) => (s?.width === width && s.height === height ? s : { width, height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, enabled]);
  return size;
}

export const JourneyPlayer = forwardRef<JourneyPlayerHandle, Props>(function JourneyPlayer(
  { scene, qualityMode, onQualityDowngrade, onFrame, onContextLost, onPlayingChange, autoPlay = false, fill = false },
  ref,
) {
  const playerRef = useRef<PlayerRef>(null);
  const shell = useRef<HTMLDivElement>(null);
  const fillSize = useElementSize(shell, fill);
  const [autoQuality, setAutoQuality] = useState<Quality>(() => initialQuality());
  const quality: Quality = qualityMode === 'auto' ? autoQuality : qualityMode;
  const timeline = useMemo(() => buildTimeline(scene), [scene]);
  // Boxed players show the default 16:9 frame; a filling player takes the shape of its parent.
  const size = fill ? fillSize : RENDER_SIZES['16:9'];
  const renderedScene = useRef<NormalizedSceneV1 | null>(null);
  const waiters = useRef<{ scene: NormalizedSceneV1; resolve: (v: boolean) => void }[]>([]);

  const handleFrame = useCallback(
    (s: SceneStats) => {
      renderedScene.current = scene;
      waiters.current = waiters.current.filter((w) => {
        if (w.scene === scene) {
          w.resolve(true);
          return false;
        }
        return true;
      });
      onFrame?.(s.frame);
    },
    [scene, onFrame],
  );

  // ?debug renders at export pixel ratio with a readable drawing buffer for frame comparison checks.
  const debugCapture = useMemo(() => new URLSearchParams(location.search).has('debug'), []);
  const dpr = debugCapture ? 1 : quality === 'standard' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  const inputProps: JourneyProps = useMemo(
    () => ({ scene, quality, dpr, capture: debugCapture, onContextLost, onFrame: handleFrame }),
    [scene, quality, dpr, debugCapture, onContextLost, handleFrame],
  );

  // Quality fallback: if playback runs well below real time at standard quality, step down.
  useEffect(() => {
    const p = playerRef.current;
    if (!p || qualityMode !== 'auto' || autoQuality === 'low') return;
    let frames = 0;
    let start = 0;
    const onUpdate = () => {
      if (!p.isPlaying()) {
        frames = 0;
        start = 0;
        return;
      }
      const now = performance.now();
      if (start === 0) start = now;
      frames++;
      const elapsed = now - start;
      if (elapsed > 3000) {
        const fps = (frames * 1000) / elapsed;
        if (fps < 20) {
          setAutoQuality('low');
          onQualityDowngrade?.();
        }
        frames = 0;
        start = now;
      }
    };
    p.addEventListener('frameupdate', onUpdate);
    return () => p.removeEventListener('frameupdate', onUpdate);
  }, [qualityMode, autoQuality, onQualityDowngrade, size !== null]);

  // Report play and pause so custom controls can follow along.
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !onPlayingChange) return;
    const onPlay = () => onPlayingChange(true);
    const onPause = () => onPlayingChange(false);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    onPlayingChange(p.isPlaying());
    return () => {
      p.removeEventListener('play', onPlay);
      p.removeEventListener('pause', onPause);
    };
  }, [onPlayingChange, size !== null]);

  useImperativeHandle(
    ref,
    () => ({
      seekSeconds(seconds: number, pause = true) {
        const p = playerRef.current;
        const frame = Math.max(0, Math.min(timeline.durationInFrames - 1, Math.round(seconds * timeline.fps)));
        if (p) {
          if (pause) p.pause();
          p.seekTo(frame);
        }
        return frame;
      },
      pause: () => playerRef.current?.pause(),
      play: () => playerRef.current?.play(),
      show(seconds?: number, playing?: boolean) {
        const p = playerRef.current;
        if (!p) return;
        if (seconds !== undefined) {
          if (playing !== true) p.pause();
          p.seekTo(Math.max(0, Math.min(timeline.durationInFrames - 1, Math.round(seconds * timeline.fps))));
        }
        if (playing === true) p.play();
        else if (playing === false) p.pause();
      },
      currentSeconds: () => (playerRef.current?.getCurrentFrame() ?? 0) / timeline.fps,
      isPlaying: () => playerRef.current?.isPlaying() ?? false,
      whenRendered(target, timeoutMs = 15000) {
        if (renderedScene.current === target) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          const entry = { scene: target, resolve };
          waiters.current.push(entry);
          setTimeout(() => {
            waiters.current = waiters.current.filter((w) => w !== entry);
            resolve(false);
          }, timeoutMs);
        });
      },
    }),
    [timeline],
  );

  return (
    <div ref={shell} className={fill ? 'player-fill' : 'player-shell'}>
      {size && (
        <Player
          ref={playerRef}
          component={JourneyComposition as unknown as React.ComponentType<Record<string, unknown>>}
          inputProps={inputProps}
          durationInFrames={timeline.durationInFrames}
          fps={timeline.fps}
          compositionWidth={size.width}
          compositionHeight={size.height}
          style={fill ? { width: '100%', height: '100%', display: 'block' } : { width: '100%', aspectRatio: `${size.width} / ${size.height}`, display: 'block' }}
          controls={!fill}
          loop
          autoPlay={autoPlay}
          clickToPlay={!fill}
          doubleClickToFullscreen={!fill}
          allowFullscreen={!fill}
          showVolumeControls={false}
          // Journeys are silent; muting keeps playback independent of the audio device.
          initiallyMuted
          numberOfSharedAudioTags={0}
          spaceKeyToPlayOrPause={!fill}
          acknowledgeRemotionLicense
        />
      )}
    </div>
  );
});

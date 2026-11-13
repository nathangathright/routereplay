import { ThreeCanvas } from '@remotion/three';
import * as THREE from 'three';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AbsoluteFill, useDelayRender, useVideoConfig } from 'remotion';
import type { NormalizedSceneV1 } from '../../shared/scene/types';
import { buildTimeline } from '../../shared/timeline/evaluate';
import { DETAIL_MAX_TILES, planNightDetail } from '../../shared/timeline/nightDetail';
import { type EarthTextures, type Quality, journeySurfaceMonth, loadEarthTextures, loadLabelFont } from '../render/assets';
import { type CloudSet, loadJourneyClouds } from '../render/Clouds';
import { JourneyScene, type SceneStats } from '../render/JourneyScene';
import { NightDetail } from '../render/nightDetail';

export interface JourneyProps extends Record<string, unknown> {
  scene: NormalizedSceneV1;
  quality: Quality;
  /** Device pixel ratio for the WebGL backing store; 1 during export. */
  dpr?: number;
  /** True during export so the canvas can be captured. */
  capture?: boolean;
  onContextLost?: () => void;
  onFrame?: (s: SceneStats) => void;
}

/**
 * The one composition shared by playback (Remotion Player) and local export
 * (@remotion/web-renderer). Only quality and pixel ratio differ between them.
 */
export function JourneyComposition({ scene, quality, dpr = 1, capture = false, onContextLost, onFrame }: JourneyProps) {
  const { width, height } = useVideoConfig();
  const timeline = useMemo(() => buildTimeline(scene), [scene]);
  const [textures, setTextures] = useState<EarthTextures | null>(null);
  const [clouds, setClouds] = useState<CloudSet | null>(null);
  const [detail, setDetail] = useState<{ textures: NightDetail; version: number } | null>(null);
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  // The Blue Marble month of the first departure, in the origin's local time.
  const month = journeySurfaceMonth(scene);

  useEffect(() => {
    let alive = true;
    const handle = delayRender('Loading Earth textures and label font');
    Promise.all([loadEarthTextures(quality, month), loadLabelFont()])
      .then(([t]) => {
        if (!alive) return;
        setTextures(t);
        continueRender(handle);
      })
      .catch((e: unknown) => cancelRender(e instanceof Error ? e : new Error(String(e))));
    return () => {
      alive = false;
      continueRender(handle);
    };
  }, [quality, month, delayRender, continueRender, cancelRender]);

  // Weather-model clouds load before the first frame, so playback and export draw the same sky.
  // If they can't be fetched, the journey plays without them rather than failing.
  useEffect(() => {
    let alive = true;
    const handle = delayRender('Loading clouds');
    loadJourneyClouds(scene)
      .catch(() => null)
      .then((c) => {
        if (alive) setClouds(c);
        continueRender(handle);
      });
    return () => {
      alive = false;
      continueRender(handle);
    };
  }, [scene, delayRender, continueRender]);

  // Full-resolution city lights near the airports, in the order the camera reaches them. Export waits for all of
  // them; playback starts once the first frame's are in, and the rest arrive while it plays.
  const plan = useMemo(() => planNightDetail(timeline, DETAIL_MAX_TILES[quality]), [timeline, quality]);
  useEffect(() => {
    const night = new NightDetail(plan, quality);
    const controller = new AbortController();
    const handle = delayRender('Loading night detail');
    let waiting = true;
    const needed = capture ? night.tileCount : night.tilesBy(0);
    let version = 0;
    const update = (inOrder: number) => {
      if (inOrder < needed) return;
      setDetail({ textures: night, version: ++version });
      if (waiting) {
        waiting = false;
        continueRender(handle);
      }
    };
    update(0);
    night.load(controller.signal, update).catch((e: unknown) => {
      if (!controller.signal.aborted) cancelRender(e instanceof Error ? e : new Error(String(e)));
    });
    return () => {
      controller.abort();
      if (waiting) continueRender(handle);
      setDetail(null);
      night.dispose();
    };
  }, [plan, quality, capture, delayRender, continueRender, cancelRender]);

  const onCreated = useCallback(
    (state: { gl: { domElement: HTMLCanvasElement } }) => {
      const canvas = state.gl.domElement;
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        onContextLost?.();
      });
    },
    [onContextLost],
  );

  return (
    <AbsoluteFill style={{ backgroundColor: '#02040a' }}>
      {textures && detail && (
        <ThreeCanvas
          width={width}
          height={height}
          dpr={dpr}
          frameloop="demand"
          camera={{ fov: 30, near: 0.01, far: 200, position: [0, 0, 4] }}
          gl={{ antialias: true, preserveDrawingBuffer: capture, powerPreference: 'high-performance', toneMapping: THREE.ReinhardToneMapping }}
          onCreated={onCreated}
        >
          <JourneyScene
            timeline={timeline}
            textures={textures}
            clouds={clouds}
            detail={detail.textures}
            detailVersion={detail.version}
            segments={quality === 'low' ? 72 : 144}
            aspect={width / height}
            onFrame={onFrame}
          />
        </ThreeCanvas>
      )}
    </AbsoluteFill>
  );
}

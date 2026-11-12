import { ThreeCanvas } from '@remotion/three';
import * as THREE from 'three';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AbsoluteFill, useDelayRender, useVideoConfig } from 'remotion';
import type { NormalizedSceneV1 } from '../../shared/scene/types';
import { buildTimeline } from '../../shared/timeline/evaluate';
import { type EarthTextures, type Quality, journeySurfaceMonth, loadEarthTextures, loadLabelFont } from '../render/assets';
import { type CloudSet, loadJourneyClouds } from '../render/Clouds';
import { JourneyScene, type SceneStats } from '../render/JourneyScene';

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
      {textures && (
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
            segments={quality === 'low' ? 72 : 144}
            aspect={width / height}
            onFrame={onFrame}
          />
        </ThreeCanvas>
      )}
    </AbsoluteFill>
  );
}

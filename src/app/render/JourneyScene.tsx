import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { useCurrentFrame } from 'remotion';
import * as THREE from 'three';
import { moonPosition } from '../../shared/geo/solar';
import { length, scale } from '../../shared/geo/vec';
import { AIRCRAFT_SHORT_SIDE_FRACTION, CRUISE_DISPLAY, type Timeline, evaluate, exposureAt, isSurfaceMode } from '../../shared/timeline/evaluate';
import { Aircraft } from './Aircraft';
import type { EarthTextures } from './assets';
import { type CloudSet, Clouds, cloudFrameAt } from './Clouds';
import type { NightDetailTextures } from './nightDetail';
import { Atmosphere, Earth } from './Earth';
import { Labels } from './Labels';
import { skyLights } from './lighting';
import { Routes } from './Routes';
import { Stars } from './Stars';
import type { ShadowCaster } from './planeShadow';
import { Moon, Sun, sunVisibleFraction } from './SunAndMoon';
import { Vehicle } from './Vehicle';

export interface SceneStats {
  frame: number;
  t: number;
}

/**
 * Frame-driven journey scene. Everything visible is derived from evaluate(timeline, frame / fps);
 * nothing depends on wall-clock time or the previously rendered frame.
 */
export function JourneyScene({
  timeline,
  textures,
  clouds = null,
  detail = null,
  detailVersion = 0,
  segments,
  aspect,
  onFrame,
}: {
  timeline: Timeline;
  textures: EarthTextures;
  clouds?: CloudSet | null;
  /** Full-resolution city lights near the airports; `detailVersion` changes as tiles arrive. */
  detail?: NightDetailTextures | null;
  detailVersion?: number;
  segments: number;
  /** Width ÷ height of the frame: the camera frames the route for this shape. */
  aspect: number;
  onFrame?: (s: SceneStats) => void;
}) {
  const frame = useCurrentFrame();
  const t = frame / timeline.fps;
  const state = useMemo(() => evaluate(timeline, t, aspect), [timeline, t, aspect]);
  const { camera, invalidate, gl } = useThree();
  const cam = state.camera;
  const camDist = length(cam.position);

  // Apply the evaluated camera before this frame renders.
  const pc = camera as THREE.PerspectiveCamera;
  pc.position.set(cam.position[0], cam.position[1], cam.position[2]);
  pc.up.set(cam.up[0], cam.up[1], cam.up[2]);
  pc.lookAt(cam.target[0], cam.target[1], cam.target[2]);
  pc.fov = cam.fovDeg;
  pc.near = Math.max(0.002, (camDist - 1) * 0.05);
  pc.far = 200;
  pc.updateProjectionMatrix();
  // The camera's exposure for this frame, metered over the whole journey in advance (Reinhard tone mapping).
  gl.toneMappingExposure = exposureAt(timeline, t);

  useEffect(() => {
    invalidate();
    onFrame?.({ frame, t });
    // Rendered-frame counter for the ?measure device budget panel.
    if (typeof window !== 'undefined' && window.__rrRenderedFrames !== undefined) window.__rrRenderedFrames++;
  }, [frame, t, invalidate, onFrame, state, detailVersion]);

  const sun = state.sun;
  const lights = useMemo(() => skyLights(state.physicalUtcMs), [state.physicalUtcMs]);
  const cloudFrame = clouds ? cloudFrameAt(clouds, state.physicalUtcMs) : null;
  // A constant-size icon, as in the offline renderer: every model is one unit nose to tail and spans the same
  // fraction of the frame's short side at every zoom.
  const toAircraft = camDist - 1 - state.aircraft.altitude;
  const shortSide = toAircraft * 2 * Math.tan((35 * Math.PI) / 180);
  const aircraftSize = AIRCRAFT_SHORT_SIDE_FRACTION * shortSide;
  // Each aircraft drawn casts its shadow, in proportion while one type dissolves into the next. Vehicles on
  // surface legs draw their own.
  const { ground, heading, altitude } = state.aircraft;
  const shadows: ShadowCaster[] = state.aircraft.mix.flatMap((m) =>
    isSurfaceMode(m.type)
      ? []
      : [{ type: m.type, ground, heading, altitude, size: aircraftSize, aloft: altitude / CRUISE_DISPLAY, weight: m.weight }],
  );

  return (
    <>
      <color attach="background" args={['#02040a']} />
      {/* Centred on the camera so the stars and Sun sit at infinity. */}
      <group position={cam.position as [number, number, number]}>
        <Stars seed={timeline.scene.seed} utcMs={state.physicalUtcMs} />
        <Sun direction={sun} visible={sunVisibleFraction(cam.position, sun)} />
      </group>
      <Moon position={moonPosition(state.physicalUtcMs)} sun={sun} />
      <ambientLight intensity={0.5} />
      <directionalLight position={scale(sun, 10) as [number, number, number]} intensity={2.4} />
      <Earth textures={textures} lights={lights} segments={segments} clouds={cloudFrame} detail={detail} shadows={shadows} />
      {cloudFrame && <Clouds frame={cloudFrame} lights={lights} night={textures.night} segments={segments} shadows={shadows} />}
      <Atmosphere sun={sun} segments={Math.max(48, segments / 2)} shadows={shadows} />
      <Routes timeline={timeline} trail={state.trail} />
      {state.aircraft.mix.map((m) =>
        isSurfaceMode(m.type) ? (
          <Vehicle key={m.type} mode={m.type} timeline={timeline} state={state} shortSide={shortSide} opacity={m.weight} />
        ) : (
          <Aircraft
            key={m.type}
            type={m.type}
            opacity={m.weight}
            ground={state.aircraft.ground}
            heading={state.aircraft.heading}
            altitude={state.aircraft.altitude}
            size={aircraftSize}
            sun={sun}
            clock={t}
          />
        ),
      )}
      <Labels labels={state.labels} pulses={state.pulses} sun={sun} />
    </>
  );
}

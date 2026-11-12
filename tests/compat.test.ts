import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compatibility } from '../src/shared/scene/compat';
import { EXAMPLE_SCENE } from '../src/shared/scene/examples';
import type { NormalizedSceneV1 } from '../src/shared/scene/types';
import { buildTimeline, evaluate } from '../src/shared/timeline/evaluate';
import { buildStoryboard } from '../src/shared/timeline/storyboard';
import { normalize } from './helpers';

/**
 * Saved published fixtures, one per supported schema version. They are never regenerated
 * casually: a renderer or schema change must keep them playable (or bump the renderer major
 * and document the migration). Regenerate only with UPDATE_FIXTURES=1 and review the diff.
 */
const FIXTURE = new URL('./fixtures/publication-v1.json', import.meta.url).pathname;
const GOLDEN = new URL('./fixtures/publication-v1.golden.json', import.meta.url).pathname;
const STORYBOARD = new URL('./fixtures/publication-v1.storyboard.json', import.meta.url).pathname;
const GOLDEN_FRAMES = [0, 45, 150, 240, 330, 450, 599];
const update = process.env.UPDATE_FIXTURES === '1';

if (update || !existsSync(FIXTURE)) {
  const snapshot = { schemaVersion: 1, scene: normalize(EXAMPLE_SCENE) };
  writeFileSync(FIXTURE, JSON.stringify(snapshot, null, 2) + '\n');
}

/** Rounded evaluated state: what the renderer draws, independent of GPU differences. */
function goldenState(scene: NormalizedSceneV1) {
  const tl = buildTimeline(scene);
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  return GOLDEN_FRAMES.map((f) => {
    const s = evaluate(tl, f / tl.fps);
    return {
      frame: f,
      phase: s.phase,
      leg: s.legIndex,
      physicalUtc: new Date(s.physicalUtcMs).toISOString(),
      aircraft: [...s.aircraft.ground, s.aircraft.altitude].map(r),
      camera: [...s.camera.position, ...s.camera.up, s.camera.fovDeg].map(r),
      sun: s.sun.map(r),
      trail: s.trail.map(r),
      labels: s.labels.map((l) => `${l.index}:${l.code}:${r(l.opacity)}`),
    };
  });
}

describe('published fixture v1', () => {
  const snapshot = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { schemaVersion: number; scene: NormalizedSceneV1 };

  it('is still playable by the current renderer', () => {
    expect(compatibility(snapshot.scene)).toEqual({ ok: true });
    const tl = buildTimeline(snapshot.scene);
    expect(tl.duration).toBeCloseTo(snapshot.scene.presentation.durationSeconds, 6);
    for (let f = 0; f <= tl.durationInFrames; f += 15) {
      const s = evaluate(tl, f / tl.fps);
      expect(Number.isFinite(s.camera.position[0])).toBe(true);
    }
  });

  it('animates the real connection during the stop', () => {
    const tl = buildTimeline(snapshot.scene);
    const p = snapshot.scene.presentation;
    const first = snapshot.scene.legs[0]!;
    const mid = evaluate(tl, p.startHoldSeconds + first.flightSeconds + first.holdAfterSeconds / 2);
    expect(mid.phase).toBe('stop');
    expect(new Date(mid.physicalUtcMs).toISOString()).toBe('2031-01-06T01:07:30.000Z');
  });

  it('matches the golden evaluated states pinned for this renderer version', () => {
    // A difference means published links would play differently: bump the renderer major
    // (and keep the old renderer for old records) instead of regenerating the golden file.
    const states = goldenState(snapshot.scene);
    if (update || !existsSync(GOLDEN)) writeFileSync(GOLDEN, JSON.stringify(states, null, 2) + '\n');
    expect(states).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });

  it('matches the storyboard pinned for this renderer version', () => {
    // Agents check their work against storyboards, so they change only with a renderer major.
    const board = buildStoryboard(snapshot.scene, undefined, 12);
    if (update || !existsSync(STORYBOARD)) writeFileSync(STORYBOARD, JSON.stringify(board, null, 2) + '\n');
    expect(board).toEqual(JSON.parse(readFileSync(STORYBOARD, 'utf8')));
  });

  it('rejects records from an unsupported renderer major', () => {
    const future = { ...snapshot.scene, compatibility: { ...snapshot.scene.compatibility, rendererVersion: '3.0.0' } };
    expect(compatibility(future).ok).toBe(false);
  });
});

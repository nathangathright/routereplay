import { describe, expect, it } from 'vitest';
import { EXAMPLE_SCENE } from '../src/shared/scene/examples';
import { buildTimeline } from '../src/shared/timeline/evaluate';
import { buildStoryboard, evenTimes } from '../src/shared/timeline/storyboard';
import { storyboardSvg } from '../src/server/storyboardSvg';
import { clone, leg, normalize, spec } from './helpers';

describe('storyboards', () => {
  const scene = normalize(EXAMPLE_SCENE);

  it('spaces keyframes evenly from the first frame to the last', () => {
    expect(evenTimes(20, 5)).toEqual([0, 5, 10, 15, 20]);
    const board = buildStoryboard(scene);
    expect(board.keyframes).toHaveLength(8);
    expect(board.keyframes[0]).toMatchObject({ t: 0, phase: 'start', legId: 'ord-sfo', legProgress: 0, labels: ['ORD'] });
    expect(board.keyframes[0]!.summary).toBe('At ORD before departure');
    expect(board.keyframes[7]).toMatchObject({ t: 20, phase: 'end', legId: 'sfo-akl', legProgress: 1, labels: ['AKL'] });
  });

  it('reports screen time for every leg and stop, adding up to the duration', () => {
    const { onScreenSeconds: o, durationSeconds } = buildStoryboard(scene);
    const total = o.startHold + o.endHold + o.legs.reduce((s, l) => s + l.seconds, 0) + o.stops.reduce((s, x) => s + x.seconds, 0);
    expect(total).toBeCloseTo(durationSeconds, 1);
    expect(o.stops).toEqual([{ airport: 'SFO', afterLegId: 'ord-sfo', startsAt: 6.35, seconds: 2, connectionMinutes: 525 }]);
    expect(o.legs.map((l) => l.id)).toEqual(['ord-sfo', 'sfo-akl']);
  });

  it('lists connections that are cut straight through', () => {
    const s = clone(EXAMPLE_SCENE);
    s.presentation = { stopHolds: { 'ord-sfo': 0 } };
    expect(buildStoryboard(normalize(s)).onScreenSeconds.stops).toEqual([
      { airport: 'SFO', afterLegId: 'ord-sfo', startsAt: expect.any(Number), seconds: 0, connectionMinutes: 525 },
    ]);
  });

  it('describes a moment in flight with local times at both ends, daylight, and framing', () => {
    const [k] = buildStoryboard(scene, [12]).keyframes;
    expect(k).toMatchObject({ phase: 'flight', legId: 'sfo-akl' });
    expect(k!.summary).toMatch(/^Flying SFO → AKL, \d+% of the way$/);
    expect(Object.keys(k!.local)).toEqual(['SFO', 'AKL']);
    expect(k!.local.SFO).toMatch(/^2031-01-0[56]T\d{2}:\d{2}-08:00$/);
    expect(k!.local.AKL).toMatch(/\+13:00$/);
    // Overnight across the Pacific in January: dark below the aircraft.
    expect(k!.aircraft.daylight).toBe(false);
    expect(k!.camera.viewRadiusKm).toBeGreaterThan(3000);
  });

  it('frames airports close and pulls back toward the middle of a flight', () => {
    const tl = buildTimeline(scene);
    const leg = tl.legs[1]!;
    const atGate = buildStoryboard(scene, [0]).keyframes[0]!;
    const midFlight = buildStoryboard(scene, [(leg.flightStart + leg.flightEnd) / 2]).keyframes[0]!;
    expect(midFlight.camera.viewRadiusKm).toBeGreaterThan(atGate.camera.viewRadiusKm * 2);
  });

  it('draws an SVG sketch with routes, airports, numbered keyframes, and night shading', () => {
    const svg = storyboardSvg(scene, buildStoryboard(scene), 0);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    // Each leg is a line over its glow.
    expect(svg.match(/<polyline /g)).toHaveLength(4);
    // Airports a flight touches are drawn as the renderer's control tower from above (roof, glass, beacon).
    expect(svg.match(/r="3.6" fill="#ffa974"/g)).toHaveLength(3);
    // Routes take the renderer's accent, not the old gold.
    expect(svg).not.toContain('stroke="#ffc76b"');
    for (const code of ['ORD', 'SFO', 'AKL']) expect(svg).toContain(`>${code}</text>`);
    for (let i = 1; i <= 8; i++) expect(svg).toContain(`>${i}</text>`);
    expect(svg).toContain('fill-opacity="0.62"');
    expect(svg).not.toMatch(/NaN|undefined/);
  });

  it('escapes titles and handles routes across the antimeridian', () => {
    const s = spec([leg('akl-lax', 'AKL', 'LAX', '2027-02-01T19:30:00+13:00', '2027-02-01T10:45:00-08:00')], { title: 'A <b>&</b> "trip"' });
    const svg = storyboardSvg(normalize(s), buildStoryboard(normalize(s)), 3);
    expect(svg).toContain('A &lt;b&gt;&amp;&lt;/b&gt; &quot;trip&quot;');
    const xs = [...svg.matchAll(/<polyline points="([^"]+)"/g)][0]![1]!.split(' ').map((p) => Number(p.split(',')[0]));
    // One continuous line: no jump across the whole map at the date line.
    expect(Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i]!)))).toBeLessThan(40);
  });
});

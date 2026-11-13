/**
 * A plain equirectangular sketch of a storyboard: routes, airports, numbered keyframe
 * markers, and night shading at a chosen moment. Pure geometry, so it is cheap to build
 * on the server and gives vision-capable agents a picture to check.
 */
import { subsolarPoint } from '../shared/geo/solar';
import { vecToLatLon } from '../shared/geo/vec';
import type { NormalizedSceneV1 } from '../shared/scene/types';
import { buildTimeline, evaluate } from '../shared/timeline/evaluate';
import type { Storyboard } from '../shared/timeline/storyboard';
import { formatUtc } from '../shared/scene/time';

/** The renderer's accent (ROUTE_COLOR in src/app/render/Routes.tsx). */
const ACCENT = '#2e8cff';
const W = 800;
const H = 400;
const HEADER = 34;
const FOOTER = 26;
const SAMPLES = 48;
const MAX_ROUTE_SAMPLES = 400;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const f1 = (n: number) => (Math.round(n * 10) / 10).toString();

/** Shift lon by whole turns so it lies within 180° of ref. */
const unwrap = (lon: number, ref: number) => lon + 360 * Math.round((ref - lon) / 360);

export function storyboardSvg(scene: NormalizedSceneV1, board: Storyboard, nightAtSeconds: number): string {
  const tl = buildTimeline(scene);
  // Route samples with longitudes unwrapped into one continuous range. A looked-up route gets enough samples
  // to show its bends (one per corner, up to a few hundred).
  const routes: { id: string; surface: boolean; pts: { f: number; lat: number; lon: number }[] }[] = [];
  let ref: number | null = null;
  for (const [i, leg] of scene.legs.entries()) {
    const track = tl.legs[i]!.track;
    const samples = Math.max(SAMPLES, Math.min(track.corners.length, MAX_ROUTE_SAMPLES));
    const pts: { f: number; lat: number; lon: number }[] = [];
    for (let j = 0; j <= samples; j++) {
      const f = j / samples;
      const p = vecToLatLon(track.at(f));
      const lon: number = ref === null ? p.lon : unwrap(p.lon, ref);
      ref = lon;
      pts.push({ f, lat: p.lat, lon });
    }
    routes.push({ id: leg.id, surface: leg.mode !== undefined, pts });
  }

  // Frame the routes with padding at a 2:1 aspect, clamped to the globe.
  const all = routes.flatMap((r) => r.pts);
  const minLon = Math.min(...all.map((p) => p.lon));
  const maxLon = Math.max(...all.map((p) => p.lon));
  const minLat = Math.min(...all.map((p) => p.lat));
  const maxLat = Math.max(...all.map((p) => p.lat));
  let lonSpan = Math.max(maxLon - minLon, 20) * 1.3;
  let latSpan = Math.max(maxLat - minLat, 10) * 1.3;
  if (lonSpan < latSpan * 2) lonSpan = latSpan * 2;
  else latSpan = lonSpan / 2;
  lonSpan = Math.min(lonSpan, 360);
  latSpan = Math.min(latSpan, 180);
  const lon0 = (minLon + maxLon) / 2 - lonSpan / 2;
  let lat1 = (minLat + maxLat) / 2 + latSpan / 2;
  lat1 = Math.min(90, Math.max(-90 + latSpan, lat1));
  const x = (lon: number) => ((lon - lon0) / lonSpan) * W;
  const y = (lat: number) => HEADER + ((lat1 - lat) / latSpan) * H;
  const pt = (lat: number, lon: number) => `${f1(x(lon))},${f1(y(lat))}`;

  const parts: string[] = [];
  parts.push(`<rect x="0" y="${HEADER}" width="${W}" height="${H}" fill="#163a5c"/>`);

  // Night shading at the chosen moment.
  const nightUtc = evaluate(tl, nightAtSeconds).physicalUtcMs;
  const sun = subsolarPoint(nightUtc);
  const decl = (Math.sign(sun.lat) || 1) * Math.max(Math.abs(sun.lat), 0.05);
  const tanD = Math.tan((decl * Math.PI) / 180);
  const line: string[] = [];
  for (let i = 0; i <= 200; i++) {
    const lon = lon0 + (lonSpan * i) / 200;
    const lat = (Math.atan(-Math.cos(((lon - sun.lon) * Math.PI) / 180) / tanD) * 180) / Math.PI;
    line.push(pt(lat, lon));
  }
  const edgeY = decl > 0 ? HEADER + H + 1 : HEADER - 1;
  parts.push(
    `<polygon points="${f1(0)},${f1(edgeY)} ${line.join(' ')} ${f1(W)},${f1(edgeY)}" fill="#01060d" fill-opacity="0.62" stroke="#7fa3c8" stroke-width="1" stroke-dasharray="4 3"/>`,
  );

  // Graticule.
  const step = lonSpan > 120 ? 30 : lonSpan > 40 ? 10 : 5;
  const grid: string[] = [];
  for (let lon = Math.ceil(lon0 / step) * step; lon <= lon0 + lonSpan; lon += step) {
    grid.push(`<line x1="${f1(x(lon))}" y1="${HEADER}" x2="${f1(x(lon))}" y2="${HEADER + H}"/>`);
    const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
    const ew = Math.abs(wrapped) === 180 || wrapped === 0 ? '' : wrapped < 0 ? 'W' : 'E';
    grid.push(`<text x="${f1(x(lon) + 3)}" y="${HEADER + H - 4}" class="g">${Math.abs(wrapped)}°${ew}</text>`);
  }
  for (let lat = Math.ceil((lat1 - latSpan) / step) * step; lat <= lat1; lat += step) {
    grid.push(`<line x1="0" y1="${f1(y(lat))}" x2="${W}" y2="${f1(y(lat))}"/>`);
    grid.push(`<text x="3" y="${f1(y(lat) - 3)}" class="g">${Math.abs(lat)}°${lat < 0 ? 'S' : lat > 0 ? 'N' : ''}</text>`);
  }
  parts.push(`<g stroke="#2b5277" stroke-width="1">${grid.filter((g) => g.startsWith('<line')).join('')}</g>`);
  parts.push(grid.filter((g) => g.startsWith('<text')).join(''));

  // Routes as the renderer draws them: an accent line over a soft glow, dotted for train, bus, car, and ferry legs.
  for (const r of routes) {
    const points = r.pts.map((p) => pt(p.lat, p.lon)).join(' ');
    parts.push(`<polyline points="${points}" fill="none" stroke="${ACCENT}" stroke-opacity="0.45" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>`);
    const dash = r.surface ? ' stroke-dasharray="0.1 5"' : '';
    parts.push(`<polyline points="${points}" fill="none" stroke="${ACCENT}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"${dash}/>`);
  }
  // Each place gets the renderer's ringed dot.
  const airports: { code: string; lat: number; lon: number }[] = [];
  routes.forEach((r, i) => {
    const leg = scene.legs[i]!;
    if (i === 0) airports.push({ code: leg.from, lat: r.pts[0]!.lat, lon: r.pts[0]!.lon });
    const end = r.pts[r.pts.length - 1]!;
    airports.push({ code: leg.to, lat: end.lat, lon: end.lon });
  });
  const codes: string[] = [];
  const drawn = new Set<string>();
  for (const a of airports) {
    const key = `${a.code}@${Math.round(a.lon)}`;
    if (drawn.has(key)) continue;
    drawn.add(key);
    const cx = f1(x(a.lon));
    const cy = f1(y(a.lat));
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="5.5" fill="none" stroke="${ACCENT}" stroke-opacity="0.65" stroke-width="1.5"/>` +
        `<circle cx="${cx}" cy="${cy}" r="2.6" fill="${ACCENT}"/>`,
    );
    codes.push(`<text x="${f1(x(a.lon) + 11)}" y="${f1(y(a.lat) - 11)}" class="a">${esc(a.code)}</text>`);
  }

  // Numbered keyframe markers at the aircraft's position.
  board.keyframes.forEach((k, i) => {
    const r = routes.find((route) => route.id === k.legId)!;
    const near = r.pts.reduce((best, p) => (Math.abs(p.f - k.legProgress) < Math.abs(best.f - k.legProgress) ? p : best));
    const lon = unwrap(k.aircraft.lon, near.lon);
    const cx = f1(x(lon));
    const cy = f1(y(k.aircraft.lat));
    parts.push(`<circle cx="${cx}" cy="${cy}" r="9" fill="${k.aircraft.daylight ? '#5ec8ff' : '#2a4f7a'}" stroke="#ffffff" stroke-width="1.5"/>`);
    parts.push(
      `<text x="${cx}" y="${cy}" class="k" fill="${k.aircraft.daylight ? '#06101c' : '#ffffff'}" text-anchor="middle" dominant-baseline="central">${i + 1}</text>`,
    );
  });

  // Airport codes go on top so markers never hide them.
  parts.push(...codes);

  const title = scene.title ?? `${scene.legs[0]!.from} to ${scene.legs[scene.legs.length - 1]!.to}`;
  // The footer is full, so the key for dotted routes goes up here.
  const dotted = routes.some((r) => r.surface) ? ' · dotted: train, bus, car, or ferry' : '';
  const header = `${esc(title)} · ${board.keyframes.length} keyframes over ${board.durationSeconds} s${dotted}`;
  const legend =
    `Numbered circles: keyframes in order (light: aircraft in daylight, dark: at night). ` +
    `Shaded side: night at ${f1(nightAtSeconds)} s (${formatUtc(Math.round(nightUtc / 60_000) * 60_000)}). No coastlines.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${HEADER + H + FOOTER}" width="${W}" height="${HEADER + H + FOOTER}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">
<style>.g{fill:#8fb0d0;font-size:10px}.a{fill:#ffffff;font-size:13px;font-weight:700;letter-spacing:1px;stroke:#06101c;stroke-width:3px;paint-order:stroke}.k{font-size:10px;font-weight:700}</style>
<rect width="${W}" height="${HEADER}" fill="#06101c"/>
<text x="10" y="22" fill="#e6eefa" font-size="13">${header}</text>
<rect y="${HEADER + H}" width="${W}" height="${FOOTER}" fill="#06101c"/>
<text x="10" y="${HEADER + H + 17}" fill="#a9bdd4" font-size="11">${legend}</text>
<clipPath id="map"><rect x="0" y="${HEADER}" width="${W}" height="${H}"/></clipPath>
<filter id="glow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="2.5"/></filter>
<g clip-path="url(#map)">
${parts.join('\n')}
</g>
</svg>
`;
}

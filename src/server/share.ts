/**
 * Titles and link previews (Open Graph, Twitter cards) for pages the Worker serves. Watch pages
 * stay out of search engines (they are personal itineraries) but unfurl well in chats: preview
 * crawlers ignore robots meta tags. Previews never include dates.
 */
import type { NormalizedSceneV1 } from '../shared/scene/types';

export const SITE_NAME = 'Route Replay';
export const SITE_DESCRIPTION =
  'Describe your flights, trains and ferries, or hand them to your own AI agent, and watch your trip unfold on a 3D Earth in that day’s sunlight. Then share it.';

/** Static images in public/share, made by scripts/browser/share-cards.mjs. Rename them when replacing: chats cache by URL. */
export const SHARE_IMAGES = {
  home: { path: '/share/home-2026-11-13.jpg', alt: '“Your trip, seen from space.” above the Earth: North America at night, with dawn at its edge.' },
  journey: { path: '/share/journey-2026-11-13.jpg', alt: 'The Earth from space: North America at night, with dawn at its edge.' },
} as const;
const IMAGE_SIZE = { width: 1200, height: 630 };

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** "Sydney (Mascot)" reads as "Sydney"; airports without a city use their name, then their code. */
function place(scene: NormalizedSceneV1, code: string): string {
  const a = scene.airports[code];
  return a?.city.replace(/\s*\(.*\)\s*$/, '').trim() || a?.name || code;
}

const MAX_STOPS_SHOWN = 6;

/**
 * "Boston → Reykjavík → Copenhagen · 6,018 km, replayed on a 3D Earth". It doesn't count legs, so
 * it stays right however a leg travels.
 */
export function journeyDescription(scene: NormalizedSceneV1): string {
  const stops = [scene.legs[0]!.from, ...scene.legs.map((l) => l.to)].map((code) => place(scene, code));
  const shown = stops.length > MAX_STOPS_SHOWN ? [...stops.slice(0, 2), '…', ...stops.slice(-2)] : stops;
  const km = Math.round(scene.legs.reduce((s, l) => s + l.distanceKm, 0));
  return `${shown.join(' → ')} · ${km.toLocaleString('en-US')} km, replayed on a 3D Earth`;
}

export interface PageMeta {
  /** The document title. */
  title: string;
  /** The preview title; defaults to `title`. */
  previewTitle?: string;
  description: string;
  image: { path: string; alt: string };
  /** The page's own address. Omitted for pages that are not meant to be shared (drafts, missing journeys). */
  url?: string;
  /** robots meta content, e.g. "noindex". */
  robots?: string;
}

/** Head tags for a page. All values are escaped. */
export function metaTags(origin: string, m: PageMeta): string {
  const tag = (attr: 'name' | 'property', key: string, value: string) => `<meta ${attr}="${key}" content="${escapeHtml(value)}">`;
  return [
    `<title>${escapeHtml(m.title)}</title>`,
    tag('name', 'description', m.description),
    m.robots ? tag('name', 'robots', m.robots) : '',
    tag('property', 'og:site_name', SITE_NAME),
    tag('property', 'og:type', 'website'),
    m.url ? tag('property', 'og:url', m.url) : '',
    tag('property', 'og:title', m.previewTitle ?? m.title),
    tag('property', 'og:description', m.description),
    tag('property', 'og:image', `${origin}${m.image.path}`),
    tag('property', 'og:image:type', 'image/jpeg'),
    tag('property', 'og:image:width', String(IMAGE_SIZE.width)),
    tag('property', 'og:image:height', String(IMAGE_SIZE.height)),
    tag('property', 'og:image:alt', m.image.alt),
    tag('name', 'twitter:card', 'summary_large_image'),
  ].join('');
}

const SHARE_BLOCK = /<!-- share:start[\s\S]*?<!-- share:end -->/;

/**
 * Put a page's tags into the app shell in place of the homepage's (the block between the
 * share:start and share:end comments in index.html). A shell without the block, such as the
 * tests' stand-in, loses its <title> instead.
 */
export function withMeta(shell: string, tags: string): string {
  if (SHARE_BLOCK.test(shell)) return shell.replace(SHARE_BLOCK, () => tags);
  return shell.replace(/<title>[\s\S]*?<\/title>/, '').replace('</head>', () => `${tags}</head>`);
}

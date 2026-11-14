/** Request entry point shared by the Worker and the tests. */
import { type Ctx, type Env, originOf, readPublication, routeApi } from './api';
import { redact } from './crypto';
import { acknowledgments, agentDocs, llmsTxt, schemaJson } from './docs';
import { ApiError, errorResponse } from './http';
import { HTML_SECURITY_HEADERS } from './security';
import { SHARE_IMAGES, SITE_DESCRIPTION, SITE_NAME, type PageMeta, escapeHtml, journeyDescription, metaTags, withMeta } from './share';
import * as store from './store';
import { journeyTitle } from '../shared/scene/title';
import type { NormalizedSceneV1 } from '../shared/scene/types';

export type { Env, Ctx };

const TEXT_CACHE = 'public, max-age=300';

function text(body: string, type: string, cache = TEXT_CACHE, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': cache, 'x-content-type-options': 'nosniff', ...extra },
  });
}

/** A watch or draft page: the app shell with its own title, link preview, and a hint for agents. */
interface ShellPage {
  status: number;
  meta: PageMeta;
  hint: string;
  /** The page's machine-readable twin, advertised to agents. */
  api?: string;
  cache: string;
}

/** Serve the SPA shell with the page's head tags and agent-readable discovery hints. */
async function shellPage(request: Request, env: Env, origin: string, page: ShellPage): Promise<Response> {
  if (!env.ASSETS) return new Response('Assets unavailable', { status: 500 });
  const shell = await env.ASSETS.fetch(new Request(new URL('/', request.url).toString(), { headers: request.headers }));
  const head = [
    metaTags(origin, page.meta),
    page.api ? `<link rel="alternate" type="application/json" href="${escapeHtml(page.api)}">` : '',
    `<link rel="describedby" href="${escapeHtml(origin)}/agent-docs">`,
  ].join('');
  const html = withMeta(await shell.text(), head).replace(
    /<body([^>]*)>/,
    (_, attrs: string) => `<body${attrs}><p class="visually-hidden" data-agent-hint>${escapeHtml(page.hint)}</p>`,
  );
  const link = [
    page.api ? `<${page.api}>; rel="alternate"; type="application/json"` : '',
    `<${origin}/agent-docs>; rel="describedby"`,
  ].filter(Boolean).join(', ');
  return new Response(html, {
    status: page.status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': page.cache,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      ...HTML_SECURITY_HEADERS,
      ...(page.meta.robots ? { 'x-robots-tag': page.meta.robots } : {}),
      vary: 'accept',
      link,
    },
  });
}

/**
 * Where Cloudflare places the visitor from their IP address (request.cf), rounded to whole degrees. That's as precise
 * as the homepage globe needs, and the page carries nothing more precise. Null when Cloudflare can't place the address,
 * and outside Cloudflare.
 */
export function visitorLocation(request: Request): { lat: number; lon: number } | null {
  const cf = request.cf as IncomingRequestCfProperties | undefined;
  const lat = parseFloat(cf?.latitude ?? '');
  const lon = parseFloat(cf?.longitude ?? '');
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null; // also rules out NaN
  // `|| 0` turns -0 into 0.
  return { lat: Math.round(lat) || 0, lon: Math.round(lon) || 0 };
}

/**
 * The homepage, with the visitor's location in a meta tag so the globe starts over them (IdleEarth.tsx). Each copy
 * is for one visitor, so shared caches never keep it, and each visit fetches it again.
 */
async function homePage(request: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) return new Response('Assets unavailable', { status: 500 });
  // Fetched without the browser's If-None-Match: a copy it cached before the Worker served this page has no location,
  // and a 304 would keep that copy in use.
  const shell = await env.ASSETS.fetch(new Request(new URL('/', request.url).toString()));
  if (!shell.ok) return shell;
  const place = visitorLocation(request);
  const html = (await shell.text()).replace(
    '</head>',
    () => (place ? `<meta name="visitor-location" content="${place.lat},${place.lon}"></head>` : '</head>'),
  );
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-cache',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      ...HTML_SECURITY_HEADERS,
    },
  });
}

const siteMeta = (title: string, robots: string): PageMeta => ({
  title,
  previewTitle: title === SITE_NAME ? undefined : title,
  description: SITE_DESCRIPTION,
  image: SHARE_IMAGES.home,
  robots,
});

/**
 * A watch page. It stays out of search results (journeys are personal itineraries) but carries
 * the journey's title and route for chat previews. Every view revalidates, like the snapshot
 * itself, so once the owner deletes the journey its title stops appearing in new previews.
 */
async function watchPage(request: Request, env: Env, origin: string, id: string): Promise<Response> {
  const cache = 'public, no-cache';
  const row = await store.getPublication(env.DB, id);
  if (!row) {
    const deleted = await store.isPublicationDeleted(env.DB, id);
    return shellPage(request, env, origin, {
      status: deleted ? 410 : 404,
      meta: siteMeta(deleted ? `Journey deleted · ${SITE_NAME}` : `Journey not found · ${SITE_NAME}`, 'noindex'),
      hint: deleted
        ? `The owner deleted this Route Replay journey. To create your own, read ${origin}/agent-docs.`
        : `No published Route Replay journey has this address. To create one, read ${origin}/agent-docs.`,
      cache,
    });
  }
  const { scene } = JSON.parse(row.snapshot_json) as { scene: NormalizedSceneV1 };
  const title = journeyTitle(scene);
  const api = `${origin}/api/v1/publications/${id}`;
  return shellPage(request, env, origin, {
    status: 200,
    meta: {
      title: `${title} · ${SITE_NAME}`,
      previewTitle: title,
      description: journeyDescription(scene),
      image: SHARE_IMAGES.journey,
      url: `${origin}/w/${id}`,
      robots: 'noindex',
    },
    hint: `This page plays a published Route Replay journey. Machine-readable snapshot: ${api} (public JSON). Scene schema: ${origin}/schemas/scene-v1.json. To create your own, read ${origin}/agent-docs.`,
    api,
    cache,
  });
}

/** A private draft preview: a generic preview card, never the journey's details. */
function draftPage(request: Request, env: Env, origin: string, id: string): Promise<Response> {
  const api = `${origin}/api/v1/scenes/${id}`;
  return shellPage(request, env, origin, {
    status: 200,
    meta: siteMeta(SITE_NAME, 'noindex, nofollow'),
    hint: `This is a private Route Replay draft preview. Agents with the draft's credential can read and revise it at ${api} using Authorization: Bearer. Instructions: ${origin}/agent-docs.`,
    api,
    cache: 'no-store',
  });
}

/** API responses stay out of search results: publications and storyboards describe personal itineraries. */
function noindex(res: Response): Response {
  if (res.status === 101) return res; // WebSocket upgrades keep their socket.
  const out = new Response(res.body, res);
  out.headers.set('x-robots-tag', 'noindex');
  return out;
}

function wantsJson(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  return /application\/json/.test(accept) && !/text\/html/.test(accept);
}

export async function handle(request: Request, env: Env, ctx: Ctx = {}): Promise<Response> {
  const url = new URL(request.url);
  const origin = originOf(request, env);
  const path = url.pathname;
  try {
    if (path === '/api' || path.startsWith('/api/')) return noindex(await routeApi(request, env, ctx));
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw new ApiError(405, 'method_not_allowed', 'Only GET is supported here.', {}, { allow: 'GET' });
    }
    if (path === '/') return await homePage(request, env);
    if (path === '/agent-docs' || path === '/agent-docs.md' || path === '/agent-docs/') {
      return text(agentDocs(origin), 'text/markdown');
    }
    if (path === '/acknowledgments') return text(acknowledgments(origin), 'text/plain');
    if (path === '/llms.txt') return text(llmsTxt(origin), 'text/plain');
    if (path === '/schemas/scene-v1.json') {
      return text(schemaJson(origin), 'application/schema+json', 'public, max-age=3600');
    }
    const watch = /^\/w\/([a-z0-9]{12})\/?$/.exec(path);
    if (watch) {
      if (wantsJson(request)) return noindex(await readPublication(request, env, watch[1]!, origin));
      return await watchPage(request, env, origin, watch[1]!);
    }
    const draft = /^\/s\/([a-z0-9]{16})\/?$/.exec(path);
    if (draft) {
      if (wantsJson(request)) {
        throw new ApiError(401, 'credential_required', 'Drafts are private. Use the API with a bearer credential.', {
          hint: `GET ${origin}/api/v1/scenes/${draft[1]} with Authorization: Bearer <credential>.`,
        });
      }
      return await draftPage(request, env, origin, draft[1]!);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    throw new ApiError(404, 'not_found', 'Not found.');
  } catch (e) {
    if (e instanceof ApiError) return errorResponse(e, origin);
    // Never log request bodies or headers; redact anything token-shaped from messages.
    console.error('Unhandled error', redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
    return errorResponse(new ApiError(500, 'internal_error', 'Something went wrong. Existing scenes were not changed.'), origin);
  }
}

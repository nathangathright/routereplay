/** Request entry point shared by the Worker and the tests. */
import { type Ctx, type Env, originOf, readPublication, routeApi } from './api';
import { redact } from './crypto';
import { acknowledgments, agentDocs, llmsTxt, schemaJson } from './docs';
import { ApiError, errorResponse } from './http';
import { HTML_SECURITY_HEADERS } from './security';

export type { Env, Ctx };

const TEXT_CACHE = 'public, max-age=300';

function text(body: string, type: string, cache = TEXT_CACHE, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': cache, 'x-content-type-options': 'nosniff', ...extra },
  });
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Serve the SPA shell with agent-readable discovery hints for a draft or watch URL. */
async function pageWithHints(
  request: Request,
  env: Env,
  origin: string,
  kind: 'draft' | 'watch',
  id: string,
): Promise<Response> {
  if (!env.ASSETS) return new Response('Assets unavailable', { status: 500 });
  const shell = await env.ASSETS.fetch(new Request(new URL('/', request.url).toString(), { headers: request.headers }));
  let html = await shell.text();
  const api = kind === 'watch' ? `${origin}/api/v1/publications/${id}` : `${origin}/api/v1/scenes/${id}`;
  const hint =
    kind === 'watch'
      ? `This page plays a published Route Replay journey. Machine-readable snapshot: ${api} (public JSON). Scene schema: ${origin}/schemas/scene-v1.json. To create your own, read ${origin}/agent-docs.`
      : `This is a private Route Replay draft preview. Agents with the draft's credential can read and revise it at ${api} using Authorization: Bearer. Instructions: ${origin}/agent-docs.`;
  const head = [
    `<link rel="alternate" type="application/json" href="${escapeHtml(api)}">`,
    `<link rel="describedby" href="${escapeHtml(origin)}/agent-docs">`,
    kind === 'draft' ? '<meta name="robots" content="noindex, nofollow">' : '',
  ].join('');
  html = html.replace('</head>', `${head}</head>`);
  html = html.replace(
    /<body([^>]*)>/,
    `<body$1><p class="visually-hidden" data-agent-hint>${escapeHtml(hint)}</p>`,
  );
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': kind === 'draft' ? 'no-store' : 'public, max-age=300',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      ...HTML_SECURITY_HEADERS,
      vary: 'accept',
      link: `<${api}>; rel="alternate"; type="application/json", <${origin}/agent-docs>; rel="describedby"`,
    },
  });
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
    if (path === '/api' || path.startsWith('/api/')) return await routeApi(request, env, ctx);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw new ApiError(405, 'method_not_allowed', 'Only GET is supported here.', {}, { allow: 'GET' });
    }
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
      if (wantsJson(request)) return await readPublication(request, env, watch[1]!, origin);
      return await pageWithHints(request, env, origin, 'watch', watch[1]!);
    }
    const draft = /^\/s\/([a-z0-9]{16})\/?$/.exec(path);
    if (draft) {
      if (wantsJson(request)) {
        throw new ApiError(401, 'credential_required', 'Drafts are private. Use the API with a bearer credential.', {
          hint: `GET ${origin}/api/v1/scenes/${draft[1]} with Authorization: Bearer <credential>.`,
        });
      }
      return await pageWithHints(request, env, origin, 'draft', draft[1]!);
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

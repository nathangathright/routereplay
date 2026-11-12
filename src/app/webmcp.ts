/**
 * Optional WebMCP tools on the authorized creator preview. They call the same HTTP API
 * operations as agents (with the page's session cookie), so validation, revisions, and
 * authorization are identical. Public watch pages register no tools.
 */
import { LIMITS } from '../shared/scene/constants';
import { vecToLatLon } from '../shared/geo/vec';
import { buildTimeline, evaluate } from '../shared/timeline/evaluate';
import { ApiFailure, publishScene, putScene, type SceneView } from './api';
import type { JourneyPlayerHandle } from './components/JourneyPlayer';

interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

interface ModelContextLike {
  registerTool: (tool: ToolDef, options?: { signal?: AbortSignal }) => unknown;
  unregisterTool?: (name: string) => void;
}

export function webMcpAvailable(): ModelContextLike | null {
  const doc = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
  if (doc && typeof doc.registerTool === 'function') return doc;
  // Earlier preview builds exposed the API on navigator.
  const nav = (navigator as unknown as { modelContext?: ModelContextLike }).modelContext;
  if (nav && typeof nav.registerTool === 'function') return nav;
  return null;
}

export interface WebMcpContext {
  sceneId: string;
  getView: () => SceneView | null;
  /** Apply a server-confirmed view to the page and resolve when it has rendered. */
  applyView: (view: SceneView) => Promise<boolean>;
  player: () => JourneyPlayerHandle | null;
  lastError: () => string | null;
}

function failure(e: unknown) {
  if (e instanceof ApiFailure) {
    const { status, code, message, hint, issues, currentRevision } = e.info;
    return { ok: false, status, error: { code, message, hint, issues, currentRevision } };
  }
  return { ok: false, error: { code: 'client_error', message: e instanceof Error ? e.message : String(e) } };
}

function summarize(view: SceneView) {
  return {
    sceneId: view.id,
    revision: view.revision,
    updatedAt: view.updatedAt,
    capabilities: view.capabilities,
    spec: view.spec,
    normalized: {
      durationSeconds: view.normalized.presentation.durationSeconds,
      legs: view.normalized.legs.map((l) => ({
        id: l.id,
        from: l.from,
        to: l.to,
        departureUtc: l.departureUtc,
        arrivalUtc: l.arrivalUtc,
        distanceKm: l.distanceKm,
        flightSeconds: l.flightSeconds,
        holdAfterSeconds: l.holdAfterSeconds,
      })),
      presentation: view.normalized.presentation,
    },
    publications: view.publications,
  };
}

export function registerWebMcpTools(ctx: WebMcpContext): () => void {
  const mc = webMcpAvailable();
  if (!mc) return () => undefined;
  const controller = new AbortController();
  const registered: string[] = [];

  const tools: ToolDef[] = [
    {
      name: 'get_scene',
      title: 'Get Route Replay scene',
      description:
        'Read the journey shown in this Route Replay preview: its editable spec, revision, normalized timing, capabilities, supported options, validation state, and playback position. Edit `spec` and pass it to set_scene with expectedRevision.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      async execute() {
        const view = ctx.getView();
        if (!view) return { ok: false, error: { code: 'not_loaded', message: 'The scene has not loaded yet.' } };
        const p = ctx.player();
        return {
          ok: true,
          ...summarize(view),
          supportedOptions: {
            maxLegs: LIMITS.maxLegs,
            durationSeconds: [LIMITS.minDurationSeconds, LIMITS.maxDurationSeconds],
            schema: `${location.origin}/schemas/scene-v1.json`,
            docs: `${location.origin}/agent-docs`,
          },
          validation: { lastError: ctx.lastError() },
          playback: p ? { currentSeconds: p.currentSeconds(), playing: p.isPlaying() } : null,
        };
      },
    },
    {
      name: 'set_scene',
      title: 'Replace Route Replay scene',
      description:
        'Validate and atomically replace the journey spec. Pass the revision you last read as expectedRevision. On success the preview updates and the new revision is returned with assetsReady (whether the new scene has rendered). On failure nothing changes and the response lists issues with JSON Pointer paths and repair hints.',
      inputSchema: {
        type: 'object',
        required: ['expectedRevision', 'spec'],
        additionalProperties: false,
        properties: {
          expectedRevision: { type: 'integer', minimum: 1, description: 'Revision the change is based on.' },
          spec: { type: 'object', description: 'Complete scene spec (schemaVersion 1). See the schema URL from get_scene.' },
        },
      },
      async execute(input) {
        try {
          const res = await putScene(ctx.sceneId, input.expectedRevision as number, input.spec);
          const view = res.body!;
          const assetsReady = await ctx.applyView(view);
          return { ok: true, assetsReady, ...summarize(view) };
        } catch (e) {
          return failure(e);
        }
      },
    },
    {
      name: 'seek_scene',
      title: 'Seek Route Replay preview',
      description:
        'Pause (by default) and jump the preview to a presentation time in seconds, then report what is on screen at that moment: phase, leg, physical UTC time, aircraft position, and visible airport labels.',
      inputSchema: {
        type: 'object',
        required: ['seconds'],
        additionalProperties: false,
        properties: {
          seconds: { type: 'number', minimum: 0, description: 'Presentation time in seconds from the start.' },
          pause: { type: 'boolean', default: true },
        },
      },
      annotations: { readOnlyHint: true },
      async execute(input) {
        const view = ctx.getView();
        const p = ctx.player();
        if (!view || !p) return { ok: false, error: { code: 'not_ready', message: 'The preview is not ready.' } };
        const seconds = Number(input.seconds);
        if (!Number.isFinite(seconds) || seconds < 0) {
          return { ok: false, error: { code: 'out_of_range', message: 'seconds must be a non-negative number.' } };
        }
        const tl = buildTimeline(view.normalized);
        const frame = p.seekSeconds(Math.min(seconds, tl.duration), input.pause !== false);
        const s = evaluate(tl, frame / tl.fps);
        const leg = view.normalized.legs[s.legIndex]!;
        const pos = vecToLatLon(s.aircraft.ground);
        return {
          ok: true,
          revision: view.revision,
          frame,
          seconds: frame / tl.fps,
          durationSeconds: tl.duration,
          phase: s.phase,
          legId: leg.id,
          legProgress: Number(s.legProgress.toFixed(4)),
          physicalUtc: new Date(s.physicalUtcMs).toISOString(),
          aircraft: { lat: Number(pos.lat.toFixed(3)), lon: Number(pos.lon.toFixed(3)) },
          labels: s.labels.map((l) => ({ code: l.code, visit: l.index, opacity: Number(l.opacity.toFixed(2)) })),
        };
      },
    },
  ];

  const view = ctx.getView();
  if (view?.capabilities.publish) {
    tools.push({
      name: 'publish_scene',
      title: 'Publish Route Replay journey',
      description:
        'Create an immutable public watch link for a revision. Only call this when the creator explicitly asked to publish or share. Anyone with the returned link can watch it.',
      inputSchema: {
        type: 'object',
        required: ['revision', 'creatorRequested'],
        additionalProperties: false,
        properties: {
          revision: { type: 'integer', minimum: 1, description: 'The revision the creator approved.' },
          creatorRequested: { const: true, description: 'Must be true: the creator explicitly asked to publish.' },
        },
      },
      annotations: { readOnlyHint: false, consequentialHint: true },
      async execute(input) {
        if (input.creatorRequested !== true) {
          return { ok: false, error: { code: 'confirmation_required', message: 'Publish only when the creator asks.' } };
        }
        try {
          const res = await publishScene(ctx.sceneId, input.revision as number);
          return { ok: true, ...res.body };
        } catch (e) {
          return failure(e);
        }
      },
    });
  }

  for (const tool of tools) {
    try {
      const r = mc.registerTool(tool, { signal: controller.signal });
      if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(() => undefined);
      registered.push(tool.name);
    } catch {
      // Ignore registration failures; the HTTP API remains the primary path.
    }
  }
  return () => {
    controller.abort();
    if (mc.unregisterTool) for (const name of registered) try { mc.unregisterTool(name); } catch { /* already gone */ }
  };
}

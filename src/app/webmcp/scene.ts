/**
 * The tools of a page that plays a journey: a draft's (get_scene, set_scene, get_revisions, get_storyboard,
 * control_playback, export_video, and publish_scene for the owner) and a watch page's (get_scene, get_storyboard,
 * control_playback, export_video). The tools both pages share behave the same on each.
 *
 * Looking and showing are separate: get_storyboard describes any moment without touching the view, and
 * control_playback moves what the person sees, only when they ask. On a draft, the person may be using the page's chat
 * at the same time, so changes wait while the chat is reading a message or saving its change (`creator_editing`),
 * every call shows "Your agent is working" in the chat, which holds back its own Publish and Export meanwhile, and
 * publishing and exporting run through the chat, which answers in its thread as it would for the person.
 */
import { LIMITS, type AspectRatio } from '../../shared/scene/constants';
import type { NormalizedSceneV1, SceneSpecV1 } from '../../shared/scene/types';
import { sceneWarnings } from '../../shared/scene/warnings';
import { type Timeline, buildTimeline } from '../../shared/timeline/evaluate';
import { STORYBOARD_FRAMES, buildStoryboard, keyframeAt } from '../../shared/timeline/storyboard';
import { ApiFailure, type PublicationView, type Published, type SceneView, getRevision, listRevisions, putScene } from '../api';
import type { JourneyPlayerHandle } from '../components/JourneyPlayer';
import type { ChatBridge } from '../draft';
import type { ExportQuality } from '../export';
import { ASPECTS, type ExportPhase, type ExportPort, QUALITIES } from '../exportOptions';
import type { ToolDef } from './core';
import { type ToolResult, apiFailed, chatChanging, failed, journeyFacts } from './results';

const timelines = new WeakMap<NormalizedSceneV1, Timeline>();
function timelineOf(scene: NormalizedSceneV1): Timeline {
  let tl = timelines.get(scene);
  if (!tl) timelines.set(scene, (tl = buildTimeline(scene)));
  return tl;
}

/** What the player shows now, described as a storyboard keyframe. */
function playback(scene: NormalizedSceneV1, player: JourneyPlayerHandle | null) {
  if (!player) return null;
  const tl = timelineOf(scene);
  const seconds = Math.round(player.currentSeconds() * 100) / 100;
  return { seconds, playing: player.isPlaying(), durationSeconds: tl.duration, at: keyframeAt(tl, seconds) };
}

/** An export's phase for the agent: no object URLs, which only the page can use. */
function exportReport(p: ExportPhase | null) {
  if (!p) return null;
  switch (p.kind) {
    case 'checking':
      return { state: 'checking' };
    case 'exporting':
      return { state: 'exporting', progress: Math.round(p.progress * 100) / 100 };
    case 'done':
      return { state: 'done', fileName: p.name, sizeBytes: p.size, width: p.width, height: p.height };
    case 'unsupported':
      return { state: 'unsupported', reasons: p.reasons };
    case 'failed':
      return { state: 'failed', message: p.message };
    case 'cancelled':
      return { state: 'cancelled' };
  }
}

type Who = 'creator' | 'viewer';

function storyboardTool(scene: () => NormalizedSceneV1 | null, extra: () => Record<string, unknown>, untrusted: boolean): ToolDef {
  return {
    name: 'get_storyboard',
    title: 'Describe moments of the journey',
    description:
      'Describe what the animation shows at evenly spaced moments (`frames`, 2–24, default 8) or at chosen times (`at`, seconds from the start), without moving anyone’s view: the phase, leg and progress, a plain summary, UTC and local times, whether it’s daylight, the airport labels on screen, and where the camera looks. `onScreenSeconds` lists how long each leg and stop lasts. Use it to check your work or to find the time of a moment to show.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        frames: { type: 'integer', minimum: STORYBOARD_FRAMES.min, maximum: STORYBOARD_FRAMES.max, description: 'Evenly spaced moments, first frame to last.' },
        at: {
          type: 'array',
          items: { type: 'number', minimum: 0 },
          minItems: 1,
          maxItems: STORYBOARD_FRAMES.max,
          description: 'Times in seconds to describe instead.',
        },
      },
    },
    annotations: { readOnlyHint: true, ...(untrusted ? { untrustedContentHint: true } : {}) },
    async execute(input) {
      const s = scene();
      if (!s) return failed('not_loaded', 'The journey hasn’t loaded yet.');
      const { frames, at } = input;
      if (frames !== undefined && (!Number.isInteger(frames) || (frames as number) < STORYBOARD_FRAMES.min || (frames as number) > STORYBOARD_FRAMES.max)) {
        return failed('out_of_range', `frames must be a whole number from ${STORYBOARD_FRAMES.min} to ${STORYBOARD_FRAMES.max}.`);
      }
      let times: number[] | undefined;
      if (at !== undefined) {
        if (!Array.isArray(at) || at.length < 1 || at.length > STORYBOARD_FRAMES.max || !at.every((t) => typeof t === 'number' && Number.isFinite(t) && t >= 0)) {
          return failed('out_of_range', `at must list 1 to ${STORYBOARD_FRAMES.max} times in seconds, each 0 or more.`);
        }
        const end = timelineOf(s).duration;
        times = (at as number[]).map((t) => Math.min(t, end));
      }
      return { ok: true, ...extra(), ...buildStoryboard(s, times, (frames as number | undefined) ?? STORYBOARD_FRAMES.default) };
    },
  };
}

function playbackTool(
  scene: () => NormalizedSceneV1 | null,
  player: () => JourneyPlayerHandle | null,
  show: (seconds?: number, playing?: boolean) => boolean,
  who: Who,
): ToolDef {
  const when =
    who === 'creator'
      ? 'when the creator asks to see something, or once at the end of a change to bring it into view; never while you work'
      : 'when the viewer asks to see something';
  return {
    name: 'control_playback',
    title: 'Show a moment of the journey',
    description: `Move what the ${who} sees: jump to \`seconds\` (pausing there unless \`playing\` is true), or play or pause. Do this only ${when}. To look at a moment yourself, use get_storyboard, which leaves the view alone. Returns the moment now on screen.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        seconds: { type: 'number', minimum: 0, description: 'Presentation time from the start; storyboard keyframes give the times.' },
        playing: { type: 'boolean', description: 'true plays (from `seconds`, if given); false pauses.' },
      },
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const s = scene();
      const p = player();
      if (!s || !p) return failed('not_ready', 'The player isn’t ready yet.');
      const { seconds, playing } = input;
      if (seconds === undefined && playing === undefined) return failed('nothing_to_do', 'Give seconds, playing, or both.');
      if (seconds !== undefined && (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0)) {
        return failed('out_of_range', 'seconds must be a number, 0 or more.');
      }
      if (playing !== undefined && typeof playing !== 'boolean') return failed('type', 'playing must be true or false.');
      const tl = timelineOf(s);
      const target = seconds === undefined ? undefined : Math.min(seconds as number, tl.duration);
      if (!show(target, playing as boolean | undefined)) return failed('not_ready', 'The player isn’t ready yet.');
      const now = target ?? p.currentSeconds();
      return {
        ok: true,
        playing: (playing as boolean | undefined) ?? p.isPlaying(),
        seconds: Math.round(now * 100) / 100,
        durationSeconds: tl.duration,
        ...(target !== undefined && target < (seconds as number) ? { note: `The journey is ${tl.duration} s long, so this is its end.` } : {}),
        at: keyframeAt(tl, now),
      };
    },
  };
}

function exportTool(port: () => ExportPort | null, gate: () => ToolResult | null, where: string): ToolDef {
  return {
    name: 'export_video',
    title: 'Export a video of the journey',
    description: `Make a video file of the journey on this device, as the page’s Export does: landscape (16:9), square (1:1) or portrait (9:16), at standard (720p) or high (1080p) quality. It runs in the page, nothing is uploaded, and it may take longer than the clip; the person saves the file ${where} when it’s done. get_scene reports its progress in page.export. Only when the person asks for a video.`,
    inputSchema: {
      type: 'object',
      required: ['aspect'],
      additionalProperties: false,
      properties: {
        aspect: { enum: ASPECTS.map((a) => a.value), description: '16:9 landscape, 1:1 square, or 9:16 portrait (for phones and stories).' },
        quality: { enum: QUALITIES.map((q) => q.value), default: 'standard', description: 'standard (720p) or high (1080p).' },
      },
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const aspect = input.aspect as AspectRatio;
      const quality = (input.quality ?? 'standard') as ExportQuality;
      if (!ASPECTS.some((a) => a.value === aspect)) return failed('out_of_range', 'aspect must be 16:9, 1:1 or 9:16.');
      if (!QUALITIES.some((q) => q.value === quality)) return failed('out_of_range', 'quality must be standard or high.');
      const blocked = gate();
      if (blocked) return blocked;
      const p = port();
      if (!p) return failed('not_ready', 'The page isn’t ready to export yet.');
      const started = p.start({ aspect, quality });
      if (!started.ok) return failed(started.code, started.message);
      return {
        ok: true,
        started: true,
        next: [
          `The export runs in the page. Call get_scene to follow page.export; when it’s done, tell the person to save the file ${where}.`,
          'Keep the tab open and visible until it finishes.',
        ],
      };
    },
  };
}

/** What the draft's tools need from its page (Preview.tsx builds this from the draft). */
export interface DraftToolContext {
  sceneId: string;
  origin: string;
  view: () => SceneView | null;
  /** Show a server-confirmed view and resolve once it has rendered (false if it didn't in time). */
  applyView: (view: SceneView) => Promise<boolean>;
  player: () => JourneyPlayerHandle | null;
  show: (seconds?: number, playing?: boolean) => boolean;
  chat: () => ChatBridge | null;
  /** "Your agent is working", for a while (draft.agentWorking). */
  working: (message?: string, forMs?: number) => void;
  /** Publish without the chat (before it has loaded). */
  publish: (revision: number) => Promise<Published>;
  connectionError: () => string | null;
}

/** While a call that takes a moment runs, its message shows; afterwards a plain "Your agent is working" lingers a little. */
const WHILE_RUNNING_MS = 60_000;

export function draftTools(ctx: DraftToolContext): ToolDef[] {
  const scene = () => ctx.view()?.normalized ?? null;
  const changing = () => (ctx.chat()?.state().changing ? chatChanging('creator') : null);
  const page = () => {
    const view = ctx.view()!;
    const chat = ctx.chat();
    const error = ctx.connectionError();
    return {
      playback: playback(view.normalized, ctx.player()),
      chat: chat ? chat.state() : null,
      export: exportReport(chat?.exports.status() ?? null),
      ...(error ? { connectionError: error } : {}),
    };
  };
  /** Run a change with its message showing in the chat. */
  async function working<T>(message: string, run: () => Promise<T>): Promise<T> {
    ctx.working(message, WHILE_RUNNING_MS);
    try {
      return await run();
    } finally {
      ctx.working();
    }
  }

  const tools: ToolDef[] = [
    {
      name: 'get_scene',
      title: 'Read the draft journey',
      description:
        'Read the draft this page shows: its editable `spec` and `revision` (edit the spec and pass both to set_scene), the journey as the service resolved it (legs with airports, local and UTC times, aircraft or ground mode, distances, pacing weights and screen seconds), warnings, watch links, and the page now: what’s on screen, what the page’s chat is doing (wait while `chat.changing`), and any video export.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      async execute() {
        const view = ctx.view();
        if (!view) return failed('not_loaded', 'The draft hasn’t loaded yet.');
        ctx.working();
        return {
          ok: true,
          sceneId: view.id,
          revision: view.revision,
          updatedAt: view.updatedAt,
          capabilities: view.capabilities,
          spec: view.spec,
          journey: journeyFacts(view.normalized),
          warnings: sceneWarnings(view.normalized, Date.now()),
          publications: view.publications,
          page: page(),
          reference: {
            maxLegs: LIMITS.maxLegs,
            durationSeconds: [LIMITS.minDurationSeconds, LIMITS.maxDurationSeconds],
            schema: `${ctx.origin}/schemas/scene-v1.json`,
            docs: `${ctx.origin}/agent-docs`,
          },
        };
      },
    },
    {
      name: 'set_scene',
      title: 'Change the draft journey',
      description:
        'Validate and save a complete new spec as the next revision; the preview shows it at once and the chat says your agent changed the trip. Pass the revision you read as expectedRevision. Name legs `<from>-<to>` in lowercase (`lax-sfo`, then `lax-sfo-2` for a repeat), as the page’s chat does, so pacing you set survives the creator’s chat edits. While the chat is reading a message or saving its change this returns creator_editing: wait, read again, and retry. On revision_conflict the trip changed since you read it, perhaps in the chat: apply only your change to the returned spec, never resend your old one. On validation_failed nothing is saved; issues give JSON Pointer paths and hints. Check the returned warnings with the creator.',
      inputSchema: {
        type: 'object',
        required: ['expectedRevision', 'spec'],
        additionalProperties: false,
        properties: {
          expectedRevision: { type: 'integer', minimum: 1, description: 'The revision your change is based on.' },
          spec: { type: 'object', description: 'The complete scene spec (schemaVersion 1), edited from get_scene’s spec. Schema: /schemas/scene-v1.json.' },
        },
      },
      annotations: { readOnlyHint: false },
      async execute(input) {
        const blocked = changing();
        if (blocked) return blocked;
        return working('Changing your trip', async () => {
          try {
            const view = (await putScene(ctx.sceneId, input.expectedRevision as number, input.spec)).body!;
            const chat = ctx.chat();
            // Before the page shows it, so the thread credits the agent rather than "outside this chat".
            chat?.agentSaved(view.revision);
            const assetsReady = await ctx.applyView(view);
            const exporting = chat?.state().exporting;
            return {
              ok: true,
              revision: view.revision,
              assetsReady,
              warnings: view.warnings ?? [],
              journey: journeyFacts(view.normalized),
              ...(exporting ? { note: 'A video export that started before this change is still running; its video shows the previous version.' } : {}),
              next: [
                ...(view.warnings?.length ? ['Raise material warnings with the creator in plain words before going further.'] : []),
                'Compare get_storyboard with what the creator asked for, then tell them the preview shows the change.',
                'Publish only if the creator asks.',
              ],
            };
          } catch (e) {
            if (e instanceof ApiFailure && e.info.code === 'revision_conflict') {
              const { currentRevision, spec } = e.info as unknown as { currentRevision: number; spec: SceneSpecV1 };
              return failed('revision_conflict', e.info.message, {
                currentRevision,
                spec,
                hint: `The trip changed since you read it, perhaps in the page’s chat. Apply only your change to this spec and send it with expectedRevision ${currentRevision}; resending your old spec would undo theirs.`,
              });
            }
            return apiFailed(e);
          }
        });
      },
    },
    {
      name: 'get_revisions',
      title: 'List or read earlier revisions',
      description:
        'Without `revision`, list the retained revisions of the draft. With `revision`, read that revision’s spec. To restore one, pass its spec to set_scene with the current revision as expectedRevision; that saves it as a new revision.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { revision: { type: 'integer', minimum: 1, description: 'The revision to read.' } },
      },
      annotations: { readOnlyHint: true },
      async execute(input) {
        ctx.working();
        try {
          if (input.revision === undefined) return { ok: true, ...(await listRevisions(ctx.sceneId)).body! };
          const r = (await getRevision(ctx.sceneId, input.revision as number)).body!;
          return {
            ok: true,
            revision: r.revision,
            createdAt: r.createdAt,
            spec: r.spec,
            hint: `To restore it, pass this spec to set_scene with expectedRevision ${ctx.view()?.revision ?? 'set to the current revision'}.`,
          };
        } catch (e) {
          return apiFailed(e);
        }
      },
    },
    storyboardTool(
      scene,
      () => {
        ctx.working();
        return { revision: ctx.view()?.revision };
      },
      false,
    ),
    playbackTool(scene, ctx.player, ctx.show, 'creator'),
    exportTool(() => ctx.chat()?.exports ?? null, changing, 'from the card in the page’s chat'),
  ];

  if (ctx.view()?.capabilities.publish) {
    tools.push({
      name: 'publish_scene',
      title: 'Publish the journey',
      description:
        'Make a public watch link for a revision, answered in the page’s chat with the link. Only when the creator explicitly asked to publish or share. A revision that was already published returns its existing link (`existing: true`). Anyone with the link can watch.',
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
        if (input.creatorRequested !== true) return failed('confirmation_required', 'Publish only when the creator asks.');
        if (!Number.isInteger(input.revision)) return failed('revision_required', 'Name the revision the creator approved.');
        const blocked = changing();
        if (blocked) return blocked;
        return working('Publishing your trip', async () => {
          try {
            const chat = ctx.chat();
            const p = chat ? await chat.publish(input.revision as number) : await ctx.publish(input.revision as number);
            return {
              ok: true,
              id: p.id,
              revision: p.revision,
              createdAt: p.createdAt,
              existing: p.existing,
              watchUrl: p.watchUrl,
              next: ['Give the creator watchUrl; anyone with it can watch, and it holds no credentials.', 'Later changes don’t affect it; publish the newer revision for a new link.'],
            };
          } catch (e) {
            return apiFailed(e);
          }
        });
      },
    });
  }
  return tools;
}

/** What the watch page's tools need from it (Watch.tsx). */
export interface WatchToolContext {
  publication: PublicationView;
  player: () => JourneyPlayerHandle | null;
  show: (seconds?: number, playing?: boolean) => boolean;
  exports: () => ExportPort | null;
}

export function watchTools(ctx: WatchToolContext): ToolDef[] {
  const { publication } = ctx;
  const scene = () => publication.scene;
  return [
    {
      name: 'get_scene',
      title: 'Read the published journey',
      description:
        'Read the published journey this page plays: its legs (airports, local and UTC times, aircraft or ground mode, distances, screen seconds), the airports’ names and time zones, and the page now: what’s on screen and any video export. A published journey is a fixed snapshot; it can’t be changed here. Its title was written by whoever made it.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute() {
        return {
          ok: true,
          publicationId: publication.id,
          watchUrl: publication.watchUrl,
          publishedAt: publication.createdAt,
          journey: journeyFacts(publication.scene),
          page: { playback: playback(publication.scene, ctx.player()), export: exportReport(ctx.exports()?.status() ?? null) },
        };
      },
    },
    storyboardTool(scene, () => ({}), true),
    playbackTool(scene, ctx.player, ctx.show, 'viewer'),
    exportTool(ctx.exports, () => null, 'from the page’s Export drawer'),
  ];
}

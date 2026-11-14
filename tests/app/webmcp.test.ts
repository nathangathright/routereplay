import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Published, SceneView } from '../../src/app/api';
import type { JourneyPlayerHandle } from '../../src/app/components/JourneyPlayer';
import { type ChatBridge, type ChatState, adoption } from '../../src/app/draft';
import type { ExportPort } from '../../src/app/exportOptions';
import type { ToolDef } from '../../src/app/webmcp/core';
import { homeTools } from '../../src/app/webmcp/home';
import { type DraftToolContext, draftTools, watchTools } from '../../src/app/webmcp/scene';
import { EXAMPLE_SCENE } from '../../src/shared/scene/examples';
import type { NormalizedSceneV1 } from '../../src/shared/scene/types';

const ORIGIN = 'https://routereplay.test';
// Browser-side tests: the published example's normalized record stands in for the server's (tests/compat.test.ts).
const NORMALIZED = (JSON.parse(readFileSync(new URL('../fixtures/publication-v1.json', import.meta.url), 'utf8')) as { scene: NormalizedSceneV1 }).scene;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function view(revision = 3, extra: Partial<SceneView> = {}): SceneView {
  const spec = clone(EXAMPLE_SCENE);
  return {
    id: 'abcdefghijklmnop',
    revision,
    createdAt: '2026-11-13T00:00:00Z',
    updatedAt: '2026-11-13T00:00:00Z',
    previewUrl: `${ORIGIN}/s/abcdefghijklmnop`,
    capabilities: { role: 'owner', read: true, edit: true, publish: true, delete: true, rotateEditCredential: true },
    spec,
    normalized: clone(NORMALIZED),
    publications: [],
    ...extra,
  };
}

function fakePlayer() {
  let t = 0;
  let playing = true;
  return {
    seekSeconds: vi.fn((s: number, pause = true) => {
      t = s;
      if (pause) playing = false;
      return Math.round(s * 30);
    }),
    play: vi.fn(() => void (playing = true)),
    pause: vi.fn(() => void (playing = false)),
    show: vi.fn((s?: number, p?: boolean) => {
      if (s !== undefined) t = s;
      if (p !== undefined || s !== undefined) playing = p === true;
    }),
    currentSeconds: () => t,
    isPlaying: () => playing,
    whenRendered: async () => true,
  } satisfies JourneyPlayerHandle;
}

function fakeChat(state: Partial<ChatState> = {}) {
  const exports: ExportPort = { start: vi.fn(() => ({ ok: true as const })), status: () => ({ kind: 'exporting', progress: 0.25 }) };
  return {
    state: () => ({ changing: false, asking: false, typing: false, exporting: false, ...state }),
    publish: vi.fn(async (revision: number): Promise<Published> => ({
      id: 'pub123456789',
      revision,
      createdAt: '2026-11-13T00:00:00Z',
      watchUrl: `${ORIGIN}/w/pub123456789`,
      apiUrl: `${ORIGIN}/api/v1/publications/pub123456789`,
      existing: false,
      next: [],
    })),
    exports,
    agentSaved: vi.fn(),
  } satisfies ChatBridge;
}

function draftContext(over: Partial<DraftToolContext> = {}) {
  let current: SceneView | null = view();
  const player = fakePlayer();
  const mocks = {
    applyView: vi.fn(async (v: SceneView) => {
      current = v;
      return true;
    }),
    show: vi.fn((seconds?: number, playing?: boolean) => {
      if (seconds !== undefined) player.seekSeconds(seconds, playing !== true);
      if (playing === true) player.play();
      return true;
    }),
    working: vi.fn((_message?: string, _forMs?: number) => undefined),
    publish: vi.fn(),
  };
  const ctx: DraftToolContext = {
    sceneId: 'abcdefghijklmnop',
    origin: ORIGIN,
    view: () => current,
    player: () => player,
    chat: () => null,
    connectionError: () => null,
    ...mocks,
    ...over,
  };
  return { ctx, player, mocks };
}

const tool = (tools: ToolDef[], name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no ${name}`);
  return t;
};
const run = (tools: ToolDef[], name: string, input: Record<string, unknown> = {}) => tool(tools, name).execute(input) as Promise<Record<string, any>>;

/** Answer the page's API requests with `respond`, recording them. */
function api(respond: (path: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: { path: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      const { status, body } = respond(path, init);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('draft page tools', () => {
  it('read the draft with what the resolved journey, the chat and the player are doing', async () => {
    const chat = fakeChat({ typing: true });
    const { ctx, mocks } = draftContext({ chat: () => chat });
    const r = await run(draftTools(ctx), 'get_scene');
    expect(r.ok).toBe(true);
    expect(r.revision).toBe(3);
    expect(r.journey.legs[0]).toMatchObject({ id: expect.any(String), weight: expect.any(Number), flightSeconds: expect.any(Number) });
    expect(r.journey.legs[0].aircraft ?? r.journey.legs[0].mode).toBeTruthy();
    expect(Object.values(r.journey.airports)[0]).toMatchObject({ name: expect.any(String), timeZone: expect.any(String) });
    expect(r.page.chat).toEqual({ changing: false, asking: false, typing: true, exporting: false });
    expect(r.page.playback.at.summary).toEqual(expect.any(String));
    expect(r.page.export).toEqual({ state: 'exporting', progress: 0.25 });
    expect(mocks.working).toHaveBeenCalled();
  });

  it('wait while the chat is changing the trip, without saving', async () => {
    const calls = api(() => ({ status: 200, body: {} }));
    const chat = fakeChat({ changing: true });
    const tools = draftTools(draftContext({ chat: () => chat }).ctx);
    for (const [name, input] of [
      ['set_scene', { expectedRevision: 3, spec: {} }],
      ['publish_scene', { revision: 3, creatorRequested: true }],
      ['export_video', { aspect: '16:9' }],
    ] as const) {
      const r = await run(tools, name, input);
      expect(r.error.code, name).toBe('creator_editing');
      expect(r.error.retryable).toBe(true);
    }
    expect(calls).toHaveLength(0);
    expect(chat.publish).not.toHaveBeenCalled();
    expect(chat.exports.start).not.toHaveBeenCalled();
  });

  it('save a change, credit the agent in the chat before the page shows it, and return its warnings', async () => {
    const saved = view(4);
    const warnings = [{ path: '/legs/0', code: 'implausible_speed', message: 'Too fast.', hint: 'Check the date.' }];
    const calls = api(() => ({ status: 200, body: { ...saved, warnings, next: ['GET …/storyboard'] } }));
    const chat = fakeChat();
    const order: string[] = [];
    chat.agentSaved.mockImplementation(() => void order.push('agentSaved'));
    const { ctx, mocks } = draftContext({ chat: () => chat });
    mocks.applyView.mockImplementation(async () => {
      order.push('applyView');
      return true;
    });
    const r = await run(draftTools(ctx), 'set_scene', { expectedRevision: 3, spec: saved.spec });
    expect(calls[0]!.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ expectedRevision: 3, spec: saved.spec });
    expect(r).toMatchObject({ ok: true, revision: 4, assetsReady: true, warnings });
    expect(r.next.join(' ')).toContain('warnings');
    expect(r.next.join(' ')).not.toContain('…/storyboard');
    expect(order).toEqual(['agentSaved', 'applyView']);
    expect(chat.agentSaved).toHaveBeenCalledWith(4);
    // "Changing your trip" while it ran, then a plain lingering "working".
    expect(mocks.working.mock.calls[0]![0]).toBe('Changing your trip');
    expect(mocks.working.mock.calls.at(-1)).toEqual([]);
  });

  it('hand back the current spec on a revision conflict, and say not to overwrite it', async () => {
    const current = view(5);
    api(() => ({
      status: 409,
      body: { error: { code: 'revision_conflict', message: 'The draft is at revision 5, not 3.', currentRevision: 5, spec: current.spec, normalized: current.normalized } },
    }));
    const r = await run(draftTools(draftContext().ctx), 'set_scene', { expectedRevision: 3, spec: current.spec });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'revision_conflict', currentRevision: 5, spec: current.spec });
    expect(r.error.normalized).toBeUndefined();
    expect(r.error.hint).toMatch(/chat/);
    expect(r.error.hint).toContain('expectedRevision 5');
  });

  it('describe moments without moving the view', async () => {
    const { ctx, player, mocks } = draftContext();
    const tools = draftTools(ctx);
    const board = await run(tools, 'get_storyboard', { frames: 3 });
    expect(board.keyframes).toHaveLength(3);
    expect(board.revision).toBe(3);
    expect(board.onScreenSeconds.legs.length).toBeGreaterThan(0);
    const at = await run(tools, 'get_storyboard', { at: [1, 9999] });
    expect(at.keyframes.map((k: { t: number }) => k.t)).toEqual([1, board.durationSeconds]);
    expect((await run(tools, 'get_storyboard', { frames: 1 })).error.code).toBe('out_of_range');
    expect(player.seekSeconds).not.toHaveBeenCalled();
    expect(mocks.show).not.toHaveBeenCalled();
  });

  it('move the view only through control_playback, and play when asked', async () => {
    const { ctx, player, mocks } = draftContext();
    const tools = draftTools(ctx);
    const paused = await run(tools, 'control_playback', { seconds: 4 });
    expect(mocks.show).toHaveBeenLastCalledWith(4, undefined);
    expect(paused).toMatchObject({ ok: true, playing: false, seconds: 4, at: { t: 4 } });
    const playing = await run(tools, 'control_playback', { seconds: 2, playing: true });
    expect(player.play).toHaveBeenCalled();
    expect(playing.playing).toBe(true);
    const end = await run(tools, 'control_playback', { seconds: 9999 });
    expect(end.note).toMatch(/end/);
    expect((await run(tools, 'control_playback', {})).error.code).toBe('nothing_to_do');
  });

  it('publish through the chat, only for the owner and only when the creator asked', async () => {
    expect(draftTools(draftContext({ view: () => view(3, { capabilities: { ...view().capabilities, role: 'edit', publish: false } }) }).ctx).map((t) => t.name)).not.toContain(
      'publish_scene',
    );
    const chat = fakeChat();
    const tools = draftTools(draftContext({ chat: () => chat }).ctx);
    expect((await run(tools, 'publish_scene', { revision: 3, creatorRequested: false })).error.code).toBe('confirmation_required');
    const r = await run(tools, 'publish_scene', { revision: 3, creatorRequested: true });
    expect(chat.publish).toHaveBeenCalledWith(3);
    expect(r).toMatchObject({ ok: true, revision: 3, existing: false, watchUrl: `${ORIGIN}/w/pub123456789` });
  });

  it('export through the chat with a shape and quality', async () => {
    const chat = fakeChat();
    const tools = draftTools(draftContext({ chat: () => chat }).ctx);
    expect((await run(tools, 'export_video', { aspect: '4:3' })).error.code).toBe('out_of_range');
    const r = await run(tools, 'export_video', { aspect: '9:16' });
    expect(chat.exports.start).toHaveBeenCalledWith({ aspect: '9:16', quality: 'standard' });
    expect(r).toMatchObject({ ok: true, started: true });
  });
});

describe('watch page tools', () => {
  const scene = clone(NORMALIZED);
  const publication = { id: 'pub123456789', createdAt: '2026-11-13T00:00:00Z', watchUrl: `${ORIGIN}/w/pub123456789`, scene };

  it('read the published journey, marked as someone else’s words, and offer no way to change it', async () => {
    const player = fakePlayer();
    const tools = watchTools({ publication, player: () => player, show: () => true, exports: () => null });
    expect(tools.map((t) => t.name).sort()).toEqual(['control_playback', 'export_video', 'get_scene', 'get_storyboard']);
    expect(tool(tools, 'get_scene').annotations).toMatchObject({ readOnlyHint: true, untrustedContentHint: true });
    const r = await run(tools, 'get_scene');
    expect(r).toMatchObject({ ok: true, publicationId: 'pub123456789', watchUrl: publication.watchUrl, page: { export: null } });
    expect(r.journey.legs).toHaveLength(scene.legs.length);
  });

  it('export in the page’s drawer', async () => {
    const port: ExportPort = { start: vi.fn(() => ({ ok: false as const, code: 'export_running', message: 'An export is already running.' })), status: () => null };
    const tools = watchTools({ publication, player: () => null, show: () => false, exports: () => port });
    const r = await run(tools, 'export_video', { aspect: '1:1', quality: 'high' });
    expect(port.start).toHaveBeenCalledWith({ aspect: '1:1', quality: 'high' });
    expect(r.error.code).toBe('export_running');
  });
});

describe('homepage tools', () => {
  it('make a draft the page becomes, keeping its credentials in the page', async () => {
    const created = view(1);
    const credentials = { edit: 'rr_edit_secret', owner: 'rr_owner_secret' };
    const calls = api(() => ({ status: 201, body: { ...created, credentials, warnings: [] } }));
    const open = vi.fn();
    const r = await run(homeTools({ origin: ORIGIN, chat: () => null, open }), 'create_scene', { spec: created.spec });
    expect(calls[0]!.path).toBe('/api/v1/scenes');
    expect(open).toHaveBeenCalledWith(created.id, credentials.owner);
    expect(r).toMatchObject({ ok: true, sceneId: created.id, revision: 1 });
    expect(JSON.stringify(r)).not.toMatch(/rr_(edit|owner)_/);
  });

  it('wait while the homepage chat is putting a trip on the globe', async () => {
    const calls = api(() => ({ status: 201, body: {} }));
    const open = vi.fn();
    const r = await run(homeTools({ origin: ORIGIN, chat: () => fakeChat({ changing: true }), open }), 'create_scene', { spec: {} });
    expect(r.error.code).toBe('creator_editing');
    expect(calls).toHaveLength(0);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('a view arriving for the draft on screen', () => {
  const a = view(3);
  it('replaces an earlier revision, keeps the same one, and ignores a late older one', () => {
    expect(adoption(null, a)).toBe('replace');
    expect(adoption(a, view(4))).toBe('replace');
    expect(adoption(a, view(3))).toBe('keep');
    expect(adoption(a, view(2))).toBe('ignore');
    // Publishing adds a link without a new revision.
    expect(adoption(a, view(3, { publications: [{ id: 'p', revision: 3, createdAt: '', watchUrl: '' }] }))).toBe('replace');
    expect(adoption(a, { ...view(1), id: 'another-draft-id' })).toBe('replace');
  });
});

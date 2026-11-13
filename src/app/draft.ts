/**
 * A draft's live state, shared by the chat sidebar (which edits it) and the stage (which plays it): the session
 * handshake, the scene itself, and the Durable Object socket that brings an agent's changes.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure, type PublicationRef, type SceneView, getScene, publishScene, startSession } from './api';
import type { JourneyPlayerHandle } from './components/JourneyPlayer';
import { journeyTitle } from '../shared/scene/title';

export type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'expired' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

export interface AgentActivity {
  message: string;
  until: number;
}

export interface Draft {
  sceneId: string | null;
  load: LoadState;
  view: SceneView | null;
  /** The latest view, for callbacks that outlive a render. */
  viewRef: RefObject<SceneView | null>;
  etag: RefObject<string | null>;
  /** Show a saved revision at once (after a PUT, say), before the socket's refetch brings it. */
  adopt: (v: SceneView, tag: string | null) => void;
  /** Publish the revision on screen; resolves to its watch link. */
  publish: () => Promise<PublicationRef>;
  connected: boolean;
  activity: AgentActivity | null;
  /** For screen readers: "Updated to revision 4." */
  notice: string | null;
  setNotice: (n: string | null) => void;
  /** The private link, when this browser arrived with the owner credential: the person's only key. */
  privateLink: string | null;
  player: RefObject<JourneyPlayerHandle | null>;
  lastError: RefObject<string | null>;
}

const RECONNECT_MS = 3000;
/** Viewer reports: at most one per 2 s, none during continuous playback (plan 2, A1). */
const VIEWER_REPORT_MS = 2000;
const VIEWER_CHECK_MS = 250;

const handshakes = new Map<string, Promise<string | null>>();

/**
 * Move the credential from the URL fragment into an HttpOnly session, removing it from history first.
 * Resolves to the credential it used, if any, so the page can offer it back once (see `privateLink`).
 */
function handshake(sceneId: string): Promise<string | null> {
  let p = handshakes.get(sceneId);
  if (!p) {
    const m = /[#&]k=([^&]+)/.exec(location.hash);
    const token = m ? decodeURIComponent(m[1]!) : null;
    if (token) history.replaceState(history.state, '', location.pathname + location.search);
    p = token ? startSession(sceneId, token).then(() => token) : Promise.resolve(null);
    handshakes.set(sceneId, p);
  }
  return p;
}

/** The chat made this draft and already holds its session: skip the fragment handshake. */
export function markSessionStarted(sceneId: string) {
  handshakes.set(sceneId, Promise.resolve(null));
}

export function useDraft(sceneId: string | null): Draft {
  const [load, setLoad] = useState<LoadState>(sceneId ? { kind: 'loading' } : { kind: 'idle' });
  const [view, setView] = useState<SceneView | null>(null);
  const [connected, setConnected] = useState(false);
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [privateLink, setPrivateLink] = useState<{ sceneId: string; url: string } | null>(null);
  const viewRef = useRef<SceneView | null>(null);
  const etag = useRef<string | null>(null);
  const player = useRef<JourneyPlayerHandle | null>(null);
  const lastError = useRef<string | null>(null);

  const adopt = useCallback((v: SceneView, tag: string | null) => {
    const prev = viewRef.current;
    viewRef.current = v;
    etag.current = tag;
    setView(v);
    if (prev && prev.id === v.id && prev.revision !== v.revision) setNotice(`Updated to revision ${v.revision}.`);
  }, []);

  const publish = useCallback(async (): Promise<PublicationRef> => {
    const current = viewRef.current;
    if (!current) throw new Error('The draft isn’t loaded yet.');
    const { id, revision, createdAt, watchUrl } = (await publishScene(current.id, current.revision)).body!;
    const latest = viewRef.current;
    // Show it at once; the live socket's refetch brings the same publication.
    if (latest && latest.id === current.id && !latest.publications.some((p) => p.id === id)) {
      adopt({ ...latest, publications: [{ id, revision, createdAt, watchUrl }, ...latest.publications] }, etag.current);
    }
    return { id, revision, createdAt, watchUrl };
  }, [adopt]);

  const poll = useCallback(async () => {
    if (!sceneId) return;
    try {
      const r = await getScene(sceneId, etag.current);
      if (r.status === 200 && r.body) adopt(r.body, r.etag);
      lastError.current = null;
    } catch (e) {
      if (e instanceof ApiFailure && (e.info.status === 401 || e.info.status === 404)) {
        setLoad(e.info.status === 401 ? { kind: 'expired' } : { kind: 'missing' });
      } else {
        lastError.current = e instanceof Error ? e.message : String(e);
      }
    }
  }, [sceneId, adopt]);

  // Initial load, and a fresh start whenever the page moves to another draft (or back home).
  useEffect(() => {
    viewRef.current = null;
    etag.current = null;
    setView(null);
    setPrivateLink(null);
    setActivity(null);
    if (!sceneId) {
      setLoad({ kind: 'idle' });
      return;
    }
    setLoad({ kind: 'loading' });
    let alive = true;
    (async () => {
      try {
        const token = await handshake(sceneId);
        const r = await getScene(sceneId);
        if (!alive) return;
        adopt(r.body!, r.etag);
        if (token && r.body!.capabilities.role === 'owner') {
          setPrivateLink({ sceneId, url: `${location.origin}/s/${sceneId}#k=${encodeURIComponent(token)}` });
        }
        setLoad({ kind: 'ready' });
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiFailure && e.info.status === 401) setLoad({ kind: 'expired' });
        else if (e instanceof ApiFailure && e.info.status === 404) setLoad({ kind: 'missing' });
        else setLoad({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [sceneId, adopt]);

  // Live updates over the draft's Durable Object socket:
  // - "changed": refetch once. A dropped socket reconnects after a moment and refetches too.
  // - "seek": the agent shows the creator a moment (only when asked).
  // - "activity": "Your agent is working" banner, which lapses on its own.
  // The page reports where the creator paused or seeked, so the agent can resolve "this part".
  useEffect(() => {
    if (load.kind !== 'ready' || !sceneId) return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let reported: { t: number; paused: boolean; revision: number | null } | null = null;
    let lastSent = 0;

    const send = () => {
      pending = null;
      const p = player.current;
      if (!p || socket?.readyState !== WebSocket.OPEN) return;
      const state = { t: Math.round(p.currentSeconds() * 100) / 100, paused: !p.isPlaying(), revision: viewRef.current?.revision ?? null };
      reported = state;
      lastSent = Date.now();
      socket.send(JSON.stringify({ type: 'viewer', ...state }));
    };
    const check = setInterval(() => {
      const p = player.current;
      if (!p || socket?.readyState !== WebSocket.OPEN || pending) return;
      const paused = !p.isPlaying();
      const t = p.currentSeconds();
      // Report again after a new revision loads too, so the agent knows the creator is seeing it.
      const changed =
        !reported ||
        paused !== reported.paused ||
        (paused && Math.abs(t - reported.t) > 0.05) ||
        (viewRef.current?.revision ?? null) !== reported.revision;
      if (!changed) return;
      pending = setTimeout(send, Math.max(0, lastSent + VIEWER_REPORT_MS - Date.now()));
    }, VIEWER_CHECK_MS);

    const connect = () => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${scheme}//${location.host}/api/v1/scenes/${sceneId}/live`);
      socket.onopen = () => {
        setConnected(true);
        reported = null; // a new socket starts with no report
        void poll();
      };
      socket.onmessage = (e) => {
        let m: { type?: string; t?: number; state?: string; message?: string; expiresInMs?: number } = {};
        try {
          m = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (m.type === 'seek' && typeof m.t === 'number') player.current?.seekSeconds(m.t, true);
        else if (m.type === 'activity') {
          setActivity(m.state === 'working' ? { message: m.message ?? '', until: Date.now() + (m.expiresInMs ?? 0) } : null);
        } else void poll();
      };
      socket.onclose = () => {
        setConnected(false);
        if (!stopped) retry = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearInterval(check);
      if (retry) clearTimeout(retry);
      if (pending) clearTimeout(pending);
      socket?.close();
    };
  }, [load.kind, sceneId, poll]);

  // The activity banner disappears when it lapses, even if no "idle" arrives.
  useEffect(() => {
    if (!activity) return;
    const t = setTimeout(() => setActivity(null), Math.max(0, activity.until - Date.now()));
    return () => clearTimeout(t);
  }, [activity]);

  useEffect(() => {
    if (view && sceneId) document.title = `${journeyTitle(view.normalized)} · Draft · Route Replay`;
  }, [view, sceneId]);

  // Until the effects above catch up with a new address, say nothing about the draft that was there before.
  const current = view?.id === sceneId ? view : null;
  return {
    sceneId,
    load: sceneId && !current && load.kind === 'ready' ? { kind: 'loading' } : load,
    view: current,
    viewRef,
    etag,
    adopt,
    publish,
    connected,
    activity,
    notice,
    setNotice,
    privateLink: privateLink?.sceneId === sceneId ? privateLink.url : null,
    player,
    lastError,
  };
}

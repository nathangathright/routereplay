import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure, type SceneView, getScene, publishScene, requestStats, startSession } from '../api';
import type { JourneyPlayerHandle } from '../components/JourneyPlayer';
import { journeyTitle } from '../../shared/scene/title';
import { JourneyStage, ShareButton } from '../components/JourneyStage';
import { registerWebMcpTools, webMcpAvailable } from '../webmcp';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'expired' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

const RECONNECT_MS = 3000;
/** Viewer reports: at most one per 2 s, none during continuous playback (plan 2, A1). */
const VIEWER_REPORT_MS = 2000;
const VIEWER_CHECK_MS = 250;

interface AgentActivity {
  message: string;
  until: number;
}

const handshakes = new Map<string, Promise<void>>();

/** Move the credential from the URL fragment into an HttpOnly session, removing it from history first. */
function handshake(sceneId: string): Promise<void> {
  let p = handshakes.get(sceneId);
  if (!p) {
    const m = /[#&]k=([^&]+)/.exec(location.hash);
    const token = m ? decodeURIComponent(m[1]!) : null;
    if (token) history.replaceState(history.state, '', location.pathname + location.search);
    p = token ? startSession(sceneId, token).then(() => undefined) : Promise.resolve();
    handshakes.set(sceneId, p);
  }
  return p;
}

const AGO_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** "5m ago", "2d ago"; "now" within the first minute. */
function ago(iso: string, now: number): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  for (const [unit, size] of AGO_UNITS) {
    if (seconds >= size) return new Intl.RelativeTimeFormat(undefined, { style: 'narrow' }).format(-Math.floor(seconds / size), unit);
  }
  return new Intl.RelativeTimeFormat(undefined, { style: 'narrow', numeric: 'auto' }).format(0, 'second');
}

/** Its own clock, so the scene doesn't re-render as the label ages. */
function EditedAgo({ iso }: { iso: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [iso]);
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {ago(iso, now)}
    </time>
  );
}

const FAILURE_SHOW_MS = 6000;

export function Preview({ sceneId }: { sceneId: string }) {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [view, setView] = useState<SceneView | null>(null);
  const [connected, setConnected] = useState(false);
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const viewRef = useRef<SceneView | null>(null);
  const etag = useRef<string | null>(null);
  const player = useRef<JourneyPlayerHandle>(null);
  const lastError = useRef<string | null>(null);
  const debug = new URLSearchParams(location.search).has('debug');

  const adopt = useCallback((v: SceneView, tag: string | null) => {
    const prev = viewRef.current;
    viewRef.current = v;
    etag.current = tag;
    setView(v);
    if (prev && prev.revision !== v.revision) setNotice(`Updated to revision ${v.revision}.`);
  }, []);

  const poll = useCallback(async () => {
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

  // Initial load.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await handshake(sceneId);
        const r = await getScene(sceneId);
        if (!alive) return;
        adopt(r.body!, r.etag);
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
    if (load.kind !== 'ready') return;
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

  // Optional WebMCP tools for agents driving this page in a compatible browser.
  const role = view?.capabilities.role;
  useEffect(() => {
    if (load.kind !== 'ready' || !role || !webMcpAvailable()) return;
    return registerWebMcpTools({
      sceneId,
      getView: () => viewRef.current,
      applyView: async (v) => {
        adopt(v, null);
        return player.current ? player.current.whenRendered(v.normalized) : false;
      },
      player: () => player.current,
      lastError: () => lastError.current,
    });
  }, [load.kind, role, sceneId, adopt]);

  useEffect(() => {
    if (!failure) return;
    const t = setTimeout(() => setFailure(null), FAILURE_SHOW_MS);
    return () => clearTimeout(t);
  }, [failure]);

  useEffect(() => {
    if (view) document.title = `${journeyTitle(view.normalized)} · Draft · Route Replay`;
  }, [view]);

  if (load.kind === 'loading') {
    return (
      <div className="center-state" aria-busy="true">
        <p>Opening your draft…</p>
      </div>
    );
  }
  if (load.kind === 'expired' || load.kind === 'missing' || load.kind === 'error') {
    const text =
      load.kind === 'expired'
        ? { h: 'This preview session has ended', p: 'Ask your agent for the preview link again. If the edit link was replaced, the old one no longer works.' }
        : load.kind === 'missing'
          ? { h: 'This draft isn’t available', p: 'The link may be mistyped, the draft may have been deleted, or its edit link was replaced. Ask your agent for a current link.' }
          : { h: 'Something went wrong', p: load.message };
    return (
      <div className="center-state">
        <div>
          <h1>{text.h}</h1>
          <p>{text.p}</p>
          <a className="btn" href="/">
            Route Replay home
          </a>
        </div>
      </div>
    );
  }
  if (!view) return null;

  /** Publish what the creator is looking at, then offer the new link through Share. No confirmation step. */
  async function publish() {
    const current = viewRef.current;
    if (!current || publishing) return;
    setPublishing(true);
    setFailure(null);
    try {
      const { id, revision, createdAt, watchUrl } = (await publishScene(sceneId, current.revision)).body!;
      const latest = viewRef.current;
      // Show Share at once; the live socket's refetch brings the same publication.
      if (latest && !latest.publications.some((p) => p.id === id)) {
        adopt({ ...latest, publications: [{ id, revision, createdAt, watchUrl }, ...latest.publications] }, etag.current);
      }
      let copied = false;
      try {
        if (navigator.clipboard) {
          await navigator.clipboard.writeText(watchUrl);
          copied = true;
        }
      } catch {
        // Some browsers only allow copying straight after a tap; Share still copies.
      }
      setNotice(copied ? 'Published. Watch link copied.' : 'Published.');
      if (copied) {
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 2000);
      }
    } catch (e) {
      setFailure(e instanceof Error ? `Publishing failed: ${e.message}` : 'Publishing failed.');
    } finally {
      setPublishing(false);
    }
  }

  const title = journeyTitle(view.normalized);
  // Newest first, so this is the latest watch link of what the creator sees.
  const published = view.publications.find((p) => p.revision === view.revision);
  const action = published ? (
    <ShareButton url={published.watchUrl} title={title} copied={linkCopied} />
  ) : view.capabilities.publish ? (
    <button className="pill-btn" onClick={publish} disabled={publishing}>
      {publishing ? 'Publishing…' : 'Publish'}
    </button>
  ) : null;

  return (
    <JourneyStage
      ref={player}
      scene={view.normalized}
      corner={
        <div className="draft-heading">
          <h1>{title}</h1>
          <p>
            Draft · Edited <EditedAgo iso={view.updatedAt} />
          </p>
        </div>
      }
      action={action}
    >
      {failure ? (
        <p className="stage-toast error" role="alert">
          {failure}
        </p>
      ) : (
        activity && (
          <p className="stage-toast" role="status">
            <span className="spinner" aria-hidden="true" />
            <span>
              Your agent is working{activity.message ? ': ' : '.'}
              {activity.message}
            </span>
          </p>
        )
      )}
      <p className="visually-hidden" role="status">
        {notice}
      </p>
      {debug && (
        <div className="watch-measure">
          <p className="panel note">
            {connected ? 'Live' : 'Reconnecting'} · revision {view.revision} · API requests: {requestStats.total} (
            {requestStats.notModified} not modified) in {Math.round((Date.now() - requestStats.since) / 1000)} s · WebMCP:{' '}
            {webMcpAvailable() ? 'available' : 'unavailable'} · role {view.capabilities.role}
          </p>
        </div>
      )}
    </JourneyStage>
  );
}

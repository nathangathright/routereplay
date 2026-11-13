import { useEffect, useState } from 'react';
import { requestStats } from '../api';
import { JourneyStage } from '../components/JourneyStage';
import type { Draft } from '../draft';
import { journeyTitle } from '../../shared/scene/title';
import { registerWebMcpTools, webMcpAvailable } from '../webmcp';

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

/**
 * The draft's journey, filling the stage beside the chat: title and status top left, the agent's activity at the
 * bottom. Publishing and exporting happen in the chat. Loads with the Remotion player, so it's its own chunk.
 */
export function DraftStage({ draft }: { draft: Draft }) {
  const { sceneId, load, view, viewRef, adopt, notice, activity, connected, player, lastError } = draft;
  const debug = new URLSearchParams(location.search).has('debug');

  // Optional WebMCP tools for agents driving this page in a compatible browser.
  const role = view?.capabilities.role;
  useEffect(() => {
    if (load.kind !== 'ready' || !role || !sceneId || !webMcpAvailable()) return;
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
  }, [load.kind, role, sceneId, adopt, viewRef, player, lastError]);

  if (load.kind === 'loading' || load.kind === 'idle') {
    return (
      <div className="center-state stage-state" aria-busy="true">
        <p>Opening your draft…</p>
      </div>
    );
  }
  if (load.kind === 'expired' || load.kind === 'missing' || load.kind === 'error') {
    const text =
      load.kind === 'expired'
        ? {
            h: 'This preview session has ended',
            p: 'Open the private link you saved, or ask your agent for the preview link again. If the link was replaced, the old one no longer works.',
          }
        : load.kind === 'missing'
          ? { h: 'This draft isn’t available', p: 'The link may be mistyped, the draft may have been deleted, or its edit link was replaced. Ask your agent for a current link.' }
          : { h: 'Something went wrong', p: load.message };
    return (
      <div className="center-state stage-state">
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
  if (!view || !sceneId) return null;

  const title = journeyTitle(view.normalized);

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
      exportable={false}
    >
      {activity && (
        <p className="stage-toast" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>
            Your agent is working{activity.message ? ': ' : '.'}
            {activity.message}
          </span>
        </p>
      )}
      <p className="visually-hidden" role="status">
        {notice}
      </p>
      {debug && (
        <div className="watch-measure">
          <p className="panel note">
            {connected ? 'Live' : 'Reconnecting'} · revision {view.revision} · API requests: {requestStats.total} ({requestStats.notModified} not
            modified) in {Math.round((Date.now() - requestStats.since) / 1000)} s · WebMCP: {webMcpAvailable() ? 'available' : 'unavailable'} · role{' '}
            {view.capabilities.role}
          </p>
        </div>
      )}
    </JourneyStage>
  );
}

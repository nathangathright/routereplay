import { useEffect } from 'react';
import { requestStats } from '../api';
import { JourneyStage } from '../components/JourneyStage';
import type { Draft } from '../draft';
import { journeyTitle } from '../../shared/scene/title';
import { offerTools, webMcpAvailable } from '../webmcp/core';

/**
 * The draft's journey, filling the stage beside the chat, with the agent's activity at the bottom while the chat
 * isn't showing it (`activityInChat`). The chat's title
 * bar names the trip, so the scene carries no heading of its own except for screen readers. Publishing and exporting
 * happen in the chat. Loads with the Remotion player, so it's its own chunk.
 */
export function DraftStage({ draft, activityInChat }: { draft: Draft; activityInChat: boolean }) {
  const { sceneId, load, view, viewRef, adopt, notice, activity, connected, player, lastError, showMoment, chat, agentWorking, publish } = draft;
  const debug = new URLSearchParams(location.search).has('debug');

  // Optional WebMCP tools for an agent working in this browser, if it supports them (webmcp/scene.ts).
  const role = view?.capabilities.role;
  useEffect(() => {
    if (load.kind !== 'ready' || !role || !sceneId) return;
    return offerTools(async () =>
      (await import('../webmcp/scene')).draftTools({
        sceneId,
        origin: location.origin,
        view: () => viewRef.current,
        applyView: async (v) => {
          adopt(v, null);
          // The stage draws the view the draft holds, which is this one unless a later revision arrived meanwhile.
          const shown = viewRef.current;
          return player.current && shown ? player.current.whenRendered(shown.normalized) : false;
        },
        player: () => player.current,
        show: showMoment,
        chat: () => chat.current,
        working: agentWorking,
        publish,
        connectionError: () => lastError.current,
      }),
    );
  }, [load.kind, role, sceneId, adopt, viewRef, player, lastError, showMoment, chat, agentWorking, publish]);

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
      corner={<h1 className="visually-hidden">{title}</h1>}
      exportable={false}
    >
      {activity && !activityInChat && (
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

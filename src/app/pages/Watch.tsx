import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure, type PublicationView, getPublication } from '../api';
import { compatibility } from '../../shared/scene/compat';
import type { NormalizedSceneV1 } from '../../shared/scene/types';
import { ExportDrawer } from '../components/ExportDrawer';
import { JourneyPlayer, type JourneyPlayerHandle, type QualityMode, webglAvailable } from '../components/JourneyPlayer';
import { MeasurePanel } from '../components/MeasurePanel';
import { RouteSummary } from '../components/RouteSummary';

type State = { kind: 'loading' } | { kind: 'ready'; pub: PublicationView } | { kind: 'deleted' } | { kind: 'missing' } | { kind: 'error'; message: string };

/** How long the play/pause button stays up after a tap while the journey plays. */
const CONTROL_SHOW_MS = 2500;

const Icon = {
  plus: (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  share: (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <path d="M10 12.5V3.5M6.5 7 10 3.5 13.5 7M6 10H5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1h-1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <path d="M4.5 10.5 8 14l7.5-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <path d="M10 3.5v9M6.5 9 10 12.5 13.5 9M4 15.5h12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  play: (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
    </svg>
  ),
  pause: (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" />
    </svg>
  ),
};

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Watch({ publicationId }: { publicationId: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    getPublication(publicationId)
      .then((r) => setState({ kind: 'ready', pub: r.body! }))
      .catch((e: unknown) => {
        if (e instanceof ApiFailure && e.info.status === 410) setState({ kind: 'deleted' });
        else if (e instanceof ApiFailure && e.info.status === 404) setState({ kind: 'missing' });
        else setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
  }, [publicationId]);

  useEffect(() => {
    if (state.kind === 'ready') document.title = `${journeyTitle(state.pub.scene)} · Route Replay`;
  }, [state]);

  if (state.kind === 'loading') {
    return (
      <div className="center-state" aria-busy="true">
        <p>Loading journey…</p>
      </div>
    );
  }
  if (state.kind !== 'ready') {
    const text =
      state.kind === 'deleted'
        ? { h: 'This journey was deleted', p: 'Its owner removed it, so it can no longer be watched.' }
        : state.kind === 'missing'
          ? { h: 'Journey not found', p: 'Check that the link was copied completely.' }
          : { h: 'Something went wrong', p: state.message };
    return (
      <div className="center-state">
        <div>
          <h1>{text.h}</h1>
          <p>{text.p}</p>
          <a className="btn" href="/">
            Make your own journey
          </a>
        </div>
      </div>
    );
  }
  const scene = state.pub.scene;
  const compat = compatibility(scene);
  if (!compat.ok) {
    return (
      <main className="page">
        <div className="center-state">
          <div>
            <h1>This journey can’t be played here</h1>
            <p>{compat.reason} The route is listed below.</p>
          </div>
        </div>
        <RouteSummary scene={scene} />
      </main>
    );
  }
  return <WatchStage scene={scene} url={state.pub.watchUrl} />;
}

function journeyTitle(scene: NormalizedSceneV1): string {
  return scene.title ?? `${scene.legs[0]!.from} to ${scene.legs[scene.legs.length - 1]!.to}`;
}

/**
 * The journey edge to edge, looping. The only controls float on top: make your own (top left), share and
 * export (top right), and a play/pause button in the middle that appears when the visitor taps the scene.
 */
function WatchStage({ scene, url }: { scene: NormalizedSceneV1; url: string }) {
  const player = useRef<JourneyPlayerHandle>(null);
  const [webgl] = useState(webglAvailable);
  const [autoPlay] = useState(() => !reducedMotion());
  const [playing, setPlaying] = useState(autoPlay);
  const [controlsShown, setControlsShown] = useState(!autoPlay);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [qualityMode, setQualityMode] = useState<QualityMode>('auto');
  const [contextLost, setContextLost] = useState(false);
  const [mountKey, setMountKey] = useState(0);
  const [measure] = useState(() => new URLSearchParams(location.search).has('measure'));
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exportButton = useRef<HTMLButtonElement>(null);

  // While playing, the button hides again shortly after a tap; while paused it stays up.
  const reveal = useCallback(() => {
    setControlsShown(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsShown(false), CONTROL_SHOW_MS);
  }, []);
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  const toggle = useCallback(() => {
    const p = player.current;
    if (!p) return;
    if (p.isPlaying()) p.pause();
    else p.play();
    reveal();
  }, [reveal]);

  // Space and K play or pause, as in most video players, unless a control or the drawer has the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (exporting || (e.key !== ' ' && e.key.toLowerCase() !== 'k')) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('button, a, input, select, textarea, dialog')) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, exporting]);

  const onPlayingChange = useCallback((p: boolean) => setPlaying(p), []);
  const onContextLost = useCallback(() => setContextLost(true), []);

  async function share() {
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.share) {
      try {
        await nav.share({ title: journeyTitle(scene), url });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        // Otherwise fall back to copying.
      }
    }
    await navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const showControl = controlsShown || !playing;
  return (
    <main className="watch">
      <h1 className="visually-hidden">{journeyTitle(scene)}</h1>
      <p className="visually-hidden">
        Flight paths are great-circle illustrations between airports, not recorded tracks.{' '}
        {scene.environment.weather === 'clouds'
          ? 'Clouds come from NOAA’s GFS weather model for these times (its analysis, or its forecast for times after the journey was saved), not satellite photos.'
          : 'Weather is not shown.'}
      </p>

      {webgl ? (
        <div className="watch-stage" onPointerUp={(e) => (e.pointerType !== 'mouse' || e.button === 0 ? reveal() : undefined)}>
          <JourneyPlayer
            key={mountKey}
            ref={player}
            scene={scene}
            qualityMode={qualityMode}
            onContextLost={onContextLost}
            onPlayingChange={onPlayingChange}
            autoPlay={autoPlay}
            fill
          />
        </div>
      ) : (
        <div className="center-state">
          <div>
            <p>This browser can’t display the 3D globe (WebGL 2 is unavailable). Here is the route.</p>
            <RouteSummary scene={scene} />
          </div>
        </div>
      )}

      <a className="icon-btn watch-new" href="/" aria-label="Make your own journey" title="Make your own">
        {Icon.plus}
      </a>
      <div className="watch-actions">
        <button className="icon-btn" onClick={share} aria-label={copied ? 'Link copied' : 'Share'} title="Share">
          {copied ? Icon.check : Icon.share}
        </button>
        {webgl && (
          <button ref={exportButton} className="icon-btn" onClick={() => setExporting(true)} aria-label="Export video" title="Export video">
            {Icon.download}
          </button>
        )}
      </div>
      <span className="visually-hidden" role="status">
        {copied ? 'Link copied.' : ''}
      </span>

      {webgl && (
        <button
          className="watch-play"
          data-shown={showControl}
          onClick={toggle}
          onFocus={() => setControlsShown(true)}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? Icon.pause : Icon.play}
        </button>
      )}

      {contextLost && (
        <div className="overlay" role="alert">
          <div>
            <p>The 3D view stopped because the graphics device was reset.</p>
            <button
              className="btn primary"
              onClick={() => {
                setContextLost(false);
                setQualityMode('low');
                setMountKey((k) => k + 1);
              }}
            >
              Restore 3D view
            </button>
          </div>
        </div>
      )}

      {webgl && (
        <ExportDrawer
          scene={scene}
          open={exporting}
          onClose={() => {
            setExporting(false);
            exportButton.current?.focus();
          }}
        />
      )}
      {/* The route in words, for screen readers. */}
      {webgl && (
        <div className="visually-hidden">
          <RouteSummary scene={scene} />
        </div>
      )}
      {measure && (
        <div className="watch-measure">
          <MeasurePanel scene={scene} player={player} />
        </div>
      )}
    </main>
  );
}

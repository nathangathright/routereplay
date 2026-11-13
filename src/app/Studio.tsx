import { PanelLeftOpenIcon } from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { ChatPanel } from './components/ChatPanel';
import { useDraft } from './draft';
import { LandingStage } from './pages/Landing';

// The draft's stage carries Remotion; the homepage loads it only once the chat opens.
const loadDraftStage = () => import('./pages/Preview').then((m) => ({ default: m.DraftStage }));
const DraftStage = lazy(loadDraftStage);

/** Wide enough for the chat as a left rail beside the scene; narrower screens get a drawer from the bottom. */
const DESKTOP = '(min-width: 900px)';
/** How long the homepage globe stays under a new draft while the draft fades in over it. */
const CROSSFADE_MS = 700;

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (change) => {
      const m = matchMedia(query);
      m.addEventListener('change', change);
      return () => m.removeEventListener('change', change);
    },
    () => matchMedia(query).matches,
  );
}

const sceneIdOf = (path: string) => /^\/s\/([a-z0-9]{16})\/?$/.exec(path)?.[1] ?? null;

/**
 * The homepage and draft pages, as one workspace: the chat on the left (a drawer at the bottom on phones) and the
 * scene in the space that's left. On the homepage the scene is the live globe behind the hero; once the chat has
 * a complete journey, the page becomes its draft without reloading, and the chat stays to edit it.
 */
export function Studio({ initialSceneId }: { initialSceneId: string | null }) {
  const desktop = useMedia(DESKTOP);
  const [sceneId, setSceneId] = useState(initialSceneId);
  const [chatOpen, setChatOpen] = useState(initialSceneId !== null);
  // Phones: a draft opens with the drawer collapsed so the journey has the screen; the homepage's opens expanded.
  const [expanded, setExpanded] = useState(initialSceneId === null);
  // A new conversation (back on the homepage, or another draft) starts a fresh chat.
  const [chatKey, setChatKey] = useState(0);
  const draft = useDraft(sceneId);
  const getStarted = useRef<HTMLButtonElement>(null);
  const rail = useRef<HTMLElement>(null);
  const [landingGone, setLandingGone] = useState(initialSceneId !== null);

  useEffect(() => {
    if (!sceneId) document.title = 'Route Replay: your journeys on a 3D Earth';
  }, [sceneId]);

  // Fetch the draft's stage while the person is still describing their trip, so the switch is immediate.
  useEffect(() => {
    if (chatOpen) void loadDraftStage();
  }, [chatOpen]);

  // Back and Forward move between the homepage and drafts.
  useEffect(() => {
    const onPop = () => {
      const id = sceneIdOf(location.pathname);
      setSceneId(id);
      setChatKey((k) => k + 1);
      setChatOpen(id !== null);
      setExpanded(id === null);
      setLandingGone(id !== null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The homepage globe stays under a new draft until the draft has faded in over it.
  const draftShown = sceneId !== null && draft.load.kind !== 'loading' && draft.load.kind !== 'idle';
  useEffect(() => {
    if (!draftShown) {
      if (!sceneId) setLandingGone(false);
      return;
    }
    const t = setTimeout(() => setLandingGone(true), CROSSFADE_MS);
    return () => clearTimeout(t);
  }, [draftShown, sceneId]);

  const onDraftCreated = useCallback((id: string, owner: string) => {
    // The draft's page takes the owner credential from the fragment as it does from an agent's owner link, and
    // removes it from the address straight away.
    history.pushState(null, '', `/s/${id}#k=${encodeURIComponent(owner)}`);
    setSceneId(id);
  }, []);

  const onNewTrip = useCallback(() => {
    history.pushState(null, '', '/');
    setSceneId(null);
    setChatKey((k) => k + 1);
    setChatOpen(true);
    setExpanded(true);
  }, []);

  // A deleted draft leaves the history too, so Back can't return to it.
  const onDeleted = useCallback(() => {
    history.replaceState(null, '', '/');
    setSceneId(null);
    setChatKey((k) => k + 1);
    setChatOpen(true);
    setExpanded(true);
  }, []);

  // Back to Get started when the homepage chat closes.
  const hide = useCallback(() => {
    setChatOpen(false);
    if (!sceneId) requestAnimationFrame(() => getStarted.current?.focus());
  }, [sceneId]);

  // On a phone the on-screen keyboard covers the bottom of the layout viewport; keep the drawer, and its message
  // box, above it and inside what's visible.
  useEffect(() => {
    const el = rail.current;
    const vv = window.visualViewport;
    if (desktop || !chatOpen || !el || !vv) return;
    const update = () => {
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      el.style.setProperty('--keyboard', `${Math.round(covered)}px`);
      el.style.setProperty('--visible-height', `${Math.round(vv.height)}px`);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      el.style.removeProperty('--keyboard');
      el.style.removeProperty('--visible-height');
    };
  }, [desktop, chatOpen]);

  const layout = desktop ? 'rail' : 'drawer';
  return (
    <div
      className="studio"
      data-chat={chatOpen ? 'open' : 'closed'}
      data-drawer={expanded ? 'expanded' : 'collapsed'}
      data-page={sceneId ? 'draft' : 'home'}
    >
      <aside ref={rail} id="chat-panel" className="studio-chat" aria-label="Chat" inert={!chatOpen || undefined}>
        <ChatPanel
          key={chatKey}
          draft={draft}
          open={chatOpen}
          layout={layout}
          expanded={desktop || expanded}
          onExpandedChange={setExpanded}
          onHide={hide}
          onDraftCreated={onDraftCreated}
          onNewTrip={onNewTrip}
          onDeleted={onDeleted}
        />
      </aside>
      <div className="studio-stage">
        {!landingGone && <LandingStage chatOpen={chatOpen} onGetStarted={() => setChatOpen(true)} getStarted={getStarted} />}
        {sceneId && (
          <div className="studio-draft" data-shown={draftShown || landingGone}>
            <Suspense fallback={null}>
              <DraftStage draft={draft} />
            </Suspense>
          </div>
        )}
        {sceneId && desktop && !chatOpen && (
          <Button
            variant="outline"
            size="icon"
            className="studio-show-chat"
            onClick={() => setChatOpen(true)}
            aria-label="Show chat"
            title="Show chat"
            aria-controls="chat-panel"
            aria-expanded={false}
          >
            <PanelLeftOpenIcon aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}

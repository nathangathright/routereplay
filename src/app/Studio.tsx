import { Suspense, lazy, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useDraft } from './draft';
import { usePip } from './pip';
import { LandingStage } from './pages/Landing';

// The chat and the UI kit it's built from load when someone reaches for Get started, not with the homepage.
const loadChat = () => import('./components/ChatPanel');
const ChatPanel = lazy(() => loadChat().then((m) => ({ default: m.ChatPanel })));
// Shown only once the chat has been open, so its code is already here.
const ShowChatButton = lazy(() => loadChat().then((m) => ({ default: m.ShowChatButton })));
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
  // The chat mounts the first time it opens, then stays, so hiding it keeps the conversation.
  const [chatMounted, setChatMounted] = useState(chatOpen);
  if (chatOpen && !chatMounted) setChatMounted(true);
  // Phones: a draft opens with the drawer collapsed so the journey has the screen; the homepage's opens expanded.
  const [expanded, setExpanded] = useState(initialSceneId === null);
  // A new conversation (back on the homepage, or another draft) starts a fresh chat.
  const [chatKey, setChatKey] = useState(0);
  // When an agent shows the creator a moment, a phone's drawer gets out of the way so the scene has the screen.
  const draft = useDraft(sceneId, { onSeek: () => !desktop && setExpanded(false) });
  const getStarted = useRef<HTMLButtonElement>(null);
  const studio = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  // On a phone the chat's questions and answers slide up in a layer of their own, over the floating window too.
  const [faqLayer, setFaqLayer] = useState<HTMLDivElement | null>(null);
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

  // On a phone the on-screen keyboard covers the bottom of the layout viewport; keep the drawer, its message box, and
  // the questions and answers' layer above it and inside what's visible.
  useEffect(() => {
    const el = studio.current;
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

  // Browsers that tint their bars with the theme colour (Chrome on Android, web apps on the home screen) take the colour
  // behind Safari's status bar: the scene's, or the drawer's once it fills the screen (styles.css).
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const top = getComputedStyle(document.documentElement).getPropertyValue('--edge-top').trim();
    if (!meta || !top) return;
    const previous = meta.content;
    meta.content = top;
    return () => {
      meta.content = previous;
    };
  }, [desktop, chatOpen, expanded]);

  // On a phone, while the drawer fills the screen, the scene floats over the chat in a small window (pip.ts).
  const pip = !desktop && chatOpen && expanded;
  const pipHandlers = usePip(studio, stage, !desktop, pip, useCallback(() => setExpanded(false), []));

  const layout = desktop ? 'rail' : 'drawer';
  return (
    <div
      ref={studio}
      className="studio"
      data-chat={chatOpen ? 'open' : 'closed'}
      data-drawer={expanded ? 'expanded' : 'collapsed'}
      data-page={sceneId ? 'draft' : 'home'}
      data-pip={pip}
    >
      <aside id="chat-panel" className="studio-chat" aria-label="Chat" inert={!chatOpen || undefined}>
        {chatMounted && (
          <Suspense fallback={null}>
            <ChatPanel
              key={chatKey}
              draft={draft}
              open={chatOpen}
              layout={layout}
              expanded={desktop || expanded}
              onExpandedChange={setExpanded}
              faqLayer={desktop ? null : faqLayer}
              onHide={hide}
              onDraftCreated={onDraftCreated}
              onNewTrip={onNewTrip}
              onDeleted={onDeleted}
            />
          </Suspense>
        )}
      </aside>
      {/* Shrunk into the floating window, the stage is only a picture: the window's touch target takes the input. */}
      <div ref={stage} className="studio-stage" inert={pip || undefined}>
        {!landingGone && (
          <LandingStage chatOpen={chatOpen} onGetStarted={() => setChatOpen(true)} onApproach={loadChat} getStarted={getStarted} />
        )}
        {sceneId && (
          <div className="studio-draft" data-shown={draftShown || landingGone}>
            <Suspense fallback={null}>
              {/* Agent activity shows in the chat while it's on screen, and over the scene otherwise. */}
              <DraftStage draft={draft} activityInChat={chatOpen && (desktop || expanded)} />
            </Suspense>
          </div>
        )}
        {sceneId && desktop && !chatOpen && (
          <Suspense fallback={null}>
            <ShowChatButton onClick={() => setChatOpen(true)} />
          </Suspense>
        )}
      </div>
      {pip && (
        <button
          type="button"
          className="studio-pip"
          aria-label={sceneId ? 'Show the journey' : 'Show the globe'}
          title={sceneId ? 'Show the journey' : 'Show the globe'}
          {...pipHandlers}
        />
      )}
      {!desktop && <div ref={setFaqLayer} className="studio-faq" />}
      {/* What Safari colours its status bar and toolbar from on a phone (styles.css). */}
      {!desktop && (
        <>
          <div className="studio-edge" data-edge="top" aria-hidden="true" />
          <div className="studio-edge" data-edge="bottom" aria-hidden="true" />
        </>
      )}
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ComposeChat } from '../components/ComposeChat';
import { CopyPromptButton } from '../components/CopyPrompt';
import { IdleEarth } from '../render/IdleEarth';
import { initialQuality, webglAvailable } from '../device';

export function Landing() {
  const [webgl] = useState(webglAvailable);
  const [quality] = useState(initialQuality);
  const page = useRef<HTMLElement>(null);
  const hero = useRef<HTMLElement>(null);
  // The globe paints this button as an object lit by its Sun (SunlitButton).
  const promptButton = useRef<HTMLButtonElement>(null);
  const getStarted = useRef<HTMLButtonElement>(null);
  const [horizon, setHorizon] = useState(0.5);
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    document.title = 'Route Replay: your journeys on a 3D Earth';
  }, []);

  // Back to Get started when the chat closes. This runs after the drawer's own effect has closed the dialog, which
  // otherwise returns focus to whatever had it before.
  const chatWasOpen = useRef(false);
  useEffect(() => {
    if (chatOpen) chatWasOpen.current = true;
    else if (chatWasOpen.current) getStarted.current?.focus();
  }, [chatOpen]);

  // Place Earth's top edge so the space between the hero and Earth equals the space above the hero.
  useLayoutEffect(() => {
    const measure = () => {
      if (!page.current || !hero.current) return;
      const p = page.current.getBoundingClientRect();
      const h = hero.current.getBoundingClientRect();
      if (p.height <= 0) return;
      const above = h.top - p.top;
      setHorizon(Math.min(0.85, Math.max(0.35, (h.bottom - p.top + above) / p.height)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (page.current) ro.observe(page.current);
    if (hero.current) ro.observe(hero.current);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, []);

  return (
    <main className="landing" ref={page}>
      <div className="landing-canvas">{webgl && <IdleEarth quality={quality} horizon={horizon} sunlitTarget={promptButton} />}</div>
      <div className="landing-content">
        <section className="hero" ref={hero}>
          <h1>Your trip, seen from space.</h1>
          <p>
            Describe your flights, trains and ferries here, or hand them to your own AI agent. Watch the journey unfold in that day’s
            sunlight, then share a link.
          </p>
          <div className="hero-actions">
            <button ref={getStarted} className="get-started" onClick={() => setChatOpen(true)} aria-haspopup="dialog">
              Get started
            </button>
            <CopyPromptButton buttonRef={promptButton} />
          </div>
        </section>
      </div>
      <a
        className="acknowledgments-link"
        href="/acknowledgments"
        target="_blank"
        rel="noopener"
        aria-label="Acknowledgments (opens in a new tab)"
        title="Acknowledgments"
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 7.25v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="4.75" r="0.95" fill="currentColor" />
        </svg>
      </a>
      <ComposeChat open={chatOpen} onClose={() => setChatOpen(false)} />
    </main>
  );
}

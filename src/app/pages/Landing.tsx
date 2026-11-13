import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { IdleEarth } from '../render/IdleEarth';
import { initialQuality, webglAvailable } from '../device';

/**
 * The homepage's stage: the live Earth with the hero over it. Get started opens the chat beside it; the hero then
 * fades and the camera moves to put the whole globe in the middle of the space left, still turning under a drag.
 */
export function LandingStage({
  chatOpen,
  onGetStarted,
  onApproach,
  getStarted,
}: {
  chatOpen: boolean;
  onGetStarted: () => void;
  /** A pointer or focus reached Get started: a click is likely, so the chat's code can start loading. */
  onApproach: () => void;
  getStarted: RefObject<HTMLButtonElement | null>;
}) {
  const [webgl] = useState(webglAvailable);
  const [quality] = useState(initialQuality);
  const page = useRef<HTMLElement>(null);
  const hero = useRef<HTMLElement>(null);
  const [horizon, setHorizon] = useState(0.5);

  // Place Earth's top edge so the space between the hero and Earth equals the space above the hero: a fraction of the
  // part of the page inside the window, which the globe is framed for (on a phone the page reaches under Safari's
  // toolbar, IdleEarth.tsx).
  useLayoutEffect(() => {
    const measure = () => {
      if (!page.current || !hero.current || chatOpen) return;
      const p = page.current.getBoundingClientRect();
      const h = hero.current.getBoundingClientRect();
      const frame = Math.min(p.bottom, document.documentElement.clientHeight) - p.top;
      if (frame <= 0) return;
      const above = h.top - p.top;
      setHorizon(Math.min(0.85, Math.max(0.35, (h.bottom - p.top + above) / frame)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (page.current) ro.observe(page.current);
    if (hero.current) ro.observe(hero.current);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [chatOpen]);

  return (
    <main className="landing" ref={page} data-chat={chatOpen ? 'open' : 'closed'}>
      <div className="landing-canvas">
        {webgl && <IdleEarth quality={quality} horizon={horizon} centred={chatOpen} sunlitTarget={getStarted} sunlitFade={hero} wheelArea={page} />}
      </div>
      <div className="landing-content">
        <section className="hero" ref={hero} aria-hidden={chatOpen || undefined} inert={chatOpen || undefined}>
          <h1>Your trip, seen from space.</h1>
          <p>
            Describe your flights, trains and ferries here, or hand them to your own AI agent. Watch the journey unfold in that day’s sunlight,
            then share a link.
          </p>
          <div className="hero-actions">
            {/* The globe paints this button as an object lit by its Sun (SunlitButton). */}
            <button
              ref={getStarted}
              className="hero-cta"
              onPointerEnter={onApproach}
              onFocus={onApproach}
              onClick={onGetStarted}
              aria-controls="chat-panel"
              aria-expanded={chatOpen}
            >
              Get started
            </button>
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
    </main>
  );
}

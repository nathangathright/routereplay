import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IdleEarth } from '../render/IdleEarth';
import { initialQuality, webglAvailable } from '../device';

export function getStartedPrompt(origin: string): string {
  return `Help me create a journey in Route Replay. Read ${origin}/agent-docs and follow it. If your browser or web reader can't open it, fetch it with a direct HTTP request.`;
}

/** Copy text with the Clipboard API, falling back to a selection copy where it isn't allowed. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/** One button that copies the agent prompt; the label swaps in place without changing width. */
function CopyPromptButton({ buttonRef }: { buttonRef?: RefObject<HTMLButtonElement | null> }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    // A build can pin the public address (for example when the page is shown outside the site).
    const origin = (import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined) ?? location.origin;
    if (!(await copyText(getStartedPrompt(origin)))) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <>
      <button ref={buttonRef} className="copy-prompt" data-copied={copied} onClick={copy}>
        <span className="copy-prompt-states">
          <span className="copy-prompt-state">Copy agent prompt</span>
          <span className="copy-prompt-state" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Copied
          </span>
        </span>
      </button>
      <span className="visually-hidden" role="status">
        {copied ? 'Prompt copied. Paste it into your agent and describe your trip.' : ''}
      </span>
    </>
  );
}

export function Landing() {
  const [webgl] = useState(webglAvailable);
  const [quality] = useState(initialQuality);
  const page = useRef<HTMLElement>(null);
  const hero = useRef<HTMLElement>(null);
  // The globe paints this button as an object lit by its Sun (SunlitButton).
  const promptButton = useRef<HTMLButtonElement>(null);
  const [horizon, setHorizon] = useState(0.5);

  useEffect(() => {
    document.title = 'Route Replay: your journeys on a 3D Earth';
  }, []);

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
          <h1>Replay your journey across the Earth.</h1>
          <p>
            Your own agent turns an itinerary into an animated flight path with dated sunlight. Watch it, revise it by asking, and share a
            link.
          </p>
          <div className="hero-actions">
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
    </main>
  );
}

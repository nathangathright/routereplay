import { type RefObject, useEffect, useRef, useState } from 'react';

export function getStartedPrompt(origin: string): string {
  return `Help me create a journey in Route Replay. Read ${origin}/agent-docs and follow it. If your browser or web reader can't open it, fetch it with a direct HTTP request.`;
}

/** Copy text with the Clipboard API, falling back to a selection copy where it isn't allowed. */
export async function copyText(text: string): Promise<boolean> {
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
export function CopyPromptButton({ buttonRef, className = '' }: { buttonRef?: RefObject<HTMLButtonElement | null>; className?: string }) {
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
      <button ref={buttonRef} className={`copy-prompt ${className}`.trim()} data-copied={copied} onClick={copy}>
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

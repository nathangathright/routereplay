import { CheckIcon, CopyIcon } from 'lucide-react';
import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

export function getStartedPrompt(origin: string): string {
  return `Help me create a journey in Route Replay. Read ${origin}/agent-docs and follow it. If your browser or web reader can't open it, fetch it with a direct HTTP request.`;
}

/** The site's public address; a build can pin it (for example when the page is shown outside the site). */
export const publicOrigin = () => (import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined) ?? location.origin;

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

/**
 * A button that copies text it builds when pressed, then says so for two seconds: "Copied" with a check, and a
 * status line for screen readers. The label swaps in place, so the button keeps its width.
 */
export function CopyButton({
  getText,
  children,
  copiedMessage,
  onCopied,
  ...props
}: Omit<ComponentProps<typeof Button>, 'onClick'> & {
  getText: () => string;
  copiedMessage: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    if (!(await copyText(getText()))) return;
    setCopied(true);
    onCopied?.();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <>
      <Button type="button" data-copied={copied} onClick={() => void copy()} {...props}>
        <span className="grid">
          <span className="col-start-1 row-start-1 inline-flex items-center justify-center gap-2 transition-opacity data-[hidden=true]:opacity-0" data-hidden={copied}>
            <CopyIcon aria-hidden="true" />
            {children}
          </span>
          <span
            className="col-start-1 row-start-1 inline-flex items-center justify-center gap-2 transition-opacity data-[hidden=true]:opacity-0"
            data-hidden={!copied}
            aria-hidden="true"
          >
            <CheckIcon />
            Copied
          </span>
        </span>
      </Button>
      <span className="sr-only" role="status">
        {copied ? copiedMessage : ''}
      </span>
    </>
  );
}

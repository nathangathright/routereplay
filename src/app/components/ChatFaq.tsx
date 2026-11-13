import { XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { FAQ_CREDITS, answerParts, faq } from '../faq';
import { publicOrigin } from './CopyPrompt';

/** The questions and answers asked for: opened at one question, or at the top; and what to give focus back to. */
export interface FaqRequest {
  item: string | null;
  opener: HTMLElement | null;
}

function Paragraph({ text, className }: { text: string; className?: string }) {
  return (
    <p className={className}>
      {answerParts(text).map((part, i) =>
        typeof part === 'string' ? (
          part
        ) : (
          // A new tab, so a conversation on the homepage (kept only in the page) isn't lost.
          <a key={i} href={part.href} target="_blank" rel="noopener">
            {part.text}
          </a>
        ),
      )}
    </p>
  );
}

/**
 * The questions and answers, as a second drawer that slides over the chat (from the left beside the stage, up from
 * the bottom on phones, where it covers the scene's floating window too). Everything here is in the page: asking costs
 * no message and no model call.
 */
export function ChatFaq({ request, layout, onClose }: { request: FaqRequest | null; layout: 'rail' | 'drawer'; onClose: () => void }) {
  const open = request !== null;
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [sections] = useState(() => faq(new URL(publicOrigin()).host));
  const [expanded, setExpanded] = useState<string[]>([]);

  // Opening at a question opens its answer and brings it to the top; otherwise focus goes to the title.
  useEffect(() => {
    if (!request) return;
    const item = request.item;
    if (item) setExpanded((list) => (list.includes(item) ? list : [...list, item]));
    const frame = requestAnimationFrame(() => {
      const trigger = item ? root.current?.querySelector<HTMLElement>(`[data-faq="${item}"]`) : null;
      if (trigger && body.current) {
        // Not scrollIntoView: that would also scroll the clipped rail the drawer slides in from.
        body.current.scrollTop += trigger.getBoundingClientRect().top - body.current.getBoundingClientRect().top - 8;
        trigger.focus({ preventScroll: true });
      } else {
        heading.current?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [request]);

  // Closing gives focus back to what opened it, if it was in here.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (request) {
      opener.current = request.opener;
      return;
    }
    const active = document.activeElement;
    if (opener.current?.isConnected && (!active || active === document.body || root.current?.contains(active))) {
      opener.current.focus({ preventScroll: true });
    }
    opener.current = null;
  }, [request]);

  return (
    <div
      ref={root}
      id="chat-faq"
      role="region"
      aria-labelledby="chat-faq-title"
      // On phones it lives outside the chat (ChatPanel.tsx), so it brings the chat's typeface.
      className="chat-faq absolute inset-0 z-10 flex flex-col bg-sidebar font-sans"
      data-layout={layout}
      data-open={open}
      inert={!open || undefined}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div
        // On a phone the panel fills the screen, as the expanded drawer it covers does, so its bar clears the notch.
        className={`relative flex shrink-0 items-center gap-1 border-b border-sidebar-border pl-4 pr-2 ${
          layout === 'drawer' ? 'h-[calc(3.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]' : 'h-14'
        }`}
      >
        <h2 ref={heading} id="chat-faq-title" tabIndex={-1} className="mr-auto truncate font-heading text-sm font-medium outline-none">
          Questions and answers
        </h2>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Back to the chat" title="Back to the chat">
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      <div ref={body} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        {sections.map((section, si) => (
          <section key={section.title} aria-labelledby={`chat-faq-section-${si}`}>
            <h3 id={`chat-faq-section-${si}`} className="pt-5 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {section.title}
            </h3>
            <Accordion
              multiple
              hiddenUntilFound
              value={expanded.filter((id) => section.items.some((q) => q.id === id))}
              onValueChange={(value) => {
                const mine = new Set(section.items.map((q) => q.id));
                setExpanded((list) => [...list.filter((id) => !mine.has(id)), ...(value as string[])]);
              }}
            >
              {section.items.map((q) => (
                <AccordionItem key={q.id} value={q.id}>
                  <AccordionTrigger data-faq={q.id}>{q.question}</AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    {q.answer.map((p, i) => (
                      <Paragraph key={i} text={p} />
                    ))}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </section>
        ))}
        <Paragraph text={FAQ_CREDITS} className="pt-5 text-sm text-muted-foreground [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground" />
      </div>
    </div>
  );
}

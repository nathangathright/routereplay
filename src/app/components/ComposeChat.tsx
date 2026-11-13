import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SceneSpecV1 } from '../../shared/scene/types';
import {
  ApiFailure,
  type ComposeLeg,
  type ComposeLimits,
  type ComposeMessage,
  type ComposeQuestion,
  compose,
  createScene,
  getComposeLimits,
} from '../api';
import { CopyPromptButton } from './CopyPrompt';

/** The server's cap on a whole conversation (src/server/compose/index.ts). */
const MAX_CHARACTERS = 4000;
const TEXTAREA_MAX_PX = 160;

type Entry =
  /** `sent`: answered, so it's part of the conversation sent with later messages. */
  | { id: number; kind: 'user'; text: string; remaining: number | null; sent: boolean }
  | { id: number; kind: 'questions'; questions: ComposeQuestion[] }
  | { id: number; kind: 'ready'; legs: ComposeLeg[]; spec: SceneSpecV1 }
  | { id: number; kind: 'notice'; text: string }
  | { id: number; kind: 'limit'; limits: ComposeLimits };

let nextId = 1;

/** What the server reads back: the person's answered messages and its own replies, as plain text. */
function conversation(entries: Entry[]): ComposeMessage[] {
  const out: ComposeMessage[] = [];
  for (const e of entries) {
    if (e.kind === 'user' && e.sent) out.push({ role: 'user', content: e.text });
    else if (e.kind === 'questions') out.push({ role: 'assistant', content: e.questions.map((q) => q.question).join('\n') });
    else if (e.kind === 'ready') out.push({ role: 'assistant', content: `Ready to create:\n${e.legs.map((l) => `${l.route}, ${l.when}, ${l.by}`).join('\n')}` });
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * The homepage chat: a half-height drawer where a person without an agent describes a trip. Each message goes to
 * POST /api/v1/compose with the conversation so far; a complete journey offers a button that creates the draft with
 * POST /api/v1/scenes and opens it with the owner credential, as an agent's owner link would.
 */
export function ComposeChat({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [limits, setLimits] = useState<ComposeLimits | null>(null);
  const [creating, setCreating] = useState(false);

  // Open and close the modal dialog. Focus goes to the message box where typing is easy; on touch screens, to the
  // heading, so the keyboard doesn't cover the introduction straight away.
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      if (matchMedia('(pointer: fine)').matches) input.current?.focus();
      else heading.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  // The allowance, fetched when the drawer opens (it doesn't use a message).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    getComposeLimits()
      .then((r) => alive && r.body && setLimits(r.body.limits))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);

  // Messages come back when the limit's window resets.
  useEffect(() => {
    if (!open || !limits || limits.remaining > 0) return;
    const wait = Math.min(3_600_000, Math.max(1000, Date.parse(limits.resetsAt) - Date.now() + 1000));
    const t = setTimeout(() => {
      getComposeLimits()
        .then((r) => r.body && setLimits(r.body.limits))
        .catch(() => {});
    }, wait);
    return () => clearTimeout(t);
  }, [open, limits]);

  // Once nothing is left, say so in the thread, once, with the way forward.
  const exhausted = limits !== null && limits.remaining === 0;
  useEffect(() => {
    if (!exhausted || !limits) return;
    setEntries((list) => {
      const lastUser = list.findLastIndex((e) => e.kind === 'user');
      const lastLimit = list.findLastIndex((e) => e.kind === 'limit');
      return lastLimit > lastUser && lastLimit >= 0 ? list : [...list, { id: nextId++, kind: 'limit', limits }];
    });
  }, [exhausted, limits]);

  // On a phone the on-screen keyboard covers the bottom of the layout viewport; keep the sheet, and its message box,
  // above it and inside what's visible.
  useEffect(() => {
    const d = dialog.current;
    const vv = window.visualViewport;
    if (!open || !d || !vv) return;
    const update = () => {
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      d.style.setProperty('--keyboard', `${Math.round(covered)}px`);
      d.style.setProperty('--visible-height', `${Math.round(vv.height)}px`);
      const t = thread.current;
      if (t) t.scrollTop = t.scrollHeight;
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [open]);

  // New messages scroll into view.
  useLayoutEffect(() => {
    const t = thread.current;
    if (t) t.scrollTop = t.scrollHeight;
  }, [entries, pending]);

  const used = conversation(entries).reduce((n, m) => n + m.content.length, 0);
  const left = MAX_CHARACTERS - used - draft.length;
  const canSend = draft.trim().length > 0 && !pending && !exhausted && left >= 0;
  const latestReady = entries.findLast((e) => e.kind === 'ready')?.id;

  async function send() {
    if (!canSend) return;
    const text = draft.trim();
    const mine: Entry = { id: nextId++, kind: 'user', text, remaining: limits ? Math.max(0, limits.remaining - 1) : null, sent: false };
    const messages = [...conversation(entries), { role: 'user' as const, content: text }];
    setEntries((list) => [...list, mine]);
    setDraft('');
    if (input.current) input.current.style.height = '';
    setPending(true);
    const settle = (patch: Partial<Extract<Entry, { kind: 'user' }>>, reply: Entry | null, next: ComposeLimits | null) => {
      setEntries((list) => [...list.map((e) => (e.id === mine.id ? ({ ...e, ...patch } as Entry) : e)), ...(reply ? [reply] : [])]);
      if (next) setLimits(next);
    };
    try {
      const { body } = await compose(messages);
      const r = body!;
      settle(
        { sent: true, remaining: r.limits.remaining },
        r.status === 'ready' && r.legs
          ? { id: nextId++, kind: 'ready', legs: r.legs, spec: r.spec }
          : { id: nextId++, kind: 'questions', questions: r.questions },
        r.limits,
      );
    } catch (e) {
      const info = e instanceof ApiFailure ? e.info : null;
      const next = (info?.limits as ComposeLimits | undefined) ?? null;
      // Over the limit: the limit message says it all; anything else gets a short explanation.
      const text = !info
        ? 'I couldn’t reach Route Replay. Check your connection and try again.'
        : info.code === 'rate_limited'
          ? null
          : info.code === 'text_too_long'
            ? `That’s more than I can read at once: ${MAX_CHARACTERS.toLocaleString()} characters for the whole conversation. Start over with just the travel details.`
            : info.message;
      settle({ remaining: next?.remaining ?? null }, text ? { id: nextId++, kind: 'notice', text } : null, next);
    } finally {
      setPending(false);
    }
  }

  async function createDraft(spec: SceneSpecV1) {
    if (creating) return;
    setCreating(true);
    try {
      const { body } = await createScene(spec);
      // The draft page exchanges the credential after # for a session with its role, as it does for an agent's
      // preview link. The owner credential gives this browser what the creator gets: watch, edit, publish, export.
      location.assign(`/s/${body!.id}#k=${encodeURIComponent(body!.credentials.owner)}`);
    } catch (e) {
      setCreating(false);
      const message = e instanceof ApiFailure ? e.info.message : 'Check your connection and try again.';
      setEntries((list) => [...list, { id: nextId++, kind: 'notice', text: `I couldn’t create the draft. ${message}` }]);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends and Shift+Enter starts a new line, except while an input method is composing text.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  function grow() {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_PX)}px`;
  }

  function startOver() {
    setEntries([]);
    setDraft('');
    input.current?.focus();
  }

  return (
    <dialog
      ref={dialog}
      className="drawer chat-drawer"
      aria-labelledby="chat-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A tap on the backdrop (the dialog element itself, outside the sheet) closes it; the chat stays.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Trackpad scrolling here scrolls the chat; the globe behind turns only on the backdrop. */}
      <div className="chat-sheet" onWheel={(e) => e.stopPropagation()}>
        <div className="drawer-head chat-head">
          <h2 id="chat-title" ref={heading} tabIndex={-1}>
            Describe your trip
          </h2>
          <div className="chat-head-actions">
            {entries.some((e) => e.kind === 'user') && (
              <button className="chat-text-btn" onClick={startOver} disabled={pending}>
                Start over
              </button>
            )}
            <button className="icon-btn small" onClick={onClose} aria-label="Close">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <div className="chat-thread" ref={thread} role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation">
          <div className="chat-msg assistant">
            <p>
              Tell me about your trip and I’ll put it on the globe. Paste a booking confirmation, or list the flights, trains, buses, drives and
              ferries with their dates, local times and aircraft. I’ll ask about anything missing.
            </p>
            {limits && <p>You can send {plural(limits.perHour, 'message')} an hour.</p>}
            <p className="chat-fine">
              To read your itinerary, Route Replay sends the text to Cloudflare Workers AI, on the same network that hosts this site. Neither
              Cloudflare nor Route Replay keeps the text or uses it to train models.
            </p>
          </div>

          {entries.map((e) => {
            if (e.kind === 'user') {
              return (
                <div key={e.id} className="chat-msg user">
                  <p className="chat-text">{e.text}</p>
                  {e.remaining !== null && <p className="chat-meta">{plural(e.remaining, 'message')} remaining</p>}
                </div>
              );
            }
            if (e.kind === 'questions') {
              return (
                <div key={e.id} className="chat-msg assistant">
                  <p>{e.questions.length === 1 ? 'One more thing:' : 'A few things to fill in:'}</p>
                  <ul className="chat-list">
                    {e.questions.map((q) => (
                      <li key={q.question}>
                        {q.question}
                        {q.options && <span className="chat-options">{q.options.join(' · ')}</span>}
                      </li>
                    ))}
                  </ul>
                  <p className="chat-fine">Reply in your own words.</p>
                </div>
              );
            }
            if (e.kind === 'ready') {
              const live = e.id === latestReady;
              return (
                <div key={e.id} className="chat-msg assistant">
                  <p>{live ? 'Here’s your journey, in local times. Create a draft to watch it, or keep typing to change anything.' : 'Here’s your journey, in local times.'}</p>
                  <ol className="chat-legs">
                    {e.legs.map((l, i) => (
                      <li key={i}>
                        <strong>{l.route}</strong>
                        <span>{l.when}</span>
                        <span>{l.by}</span>
                      </li>
                    ))}
                  </ol>
                  {live && (
                    <>
                      <button className="chat-action" onClick={() => void createDraft(e.spec)} disabled={creating}>
                        {creating ? 'Creating…' : 'Create draft'}
                      </button>
                      <p className="chat-fine">It opens in this browser, where you can watch, publish and export it.</p>
                    </>
                  )}
                </div>
              );
            }
            if (e.kind === 'limit') {
              return (
                <div key={e.id} className="chat-msg assistant">
                  <p>
                    {e.limits.reached === 'everyone'
                      ? 'Route Replay has used up today’s messages for everyone.'
                      : `You’ve used the ${plural(e.limits.perHour, 'message')} this hour allows.`}{' '}
                    Your own AI agent can make the journey instead: copy this prompt into it, then describe your trip.
                  </p>
                  <CopyPromptButton className="chat-copy" />
                  <p className="chat-fine">You can send more here after {clock(e.limits.resetsAt)}.</p>
                </div>
              );
            }
            return (
              <div key={e.id} className="chat-msg assistant notice">
                <p>{e.text}</p>
              </div>
            );
          })}

          {pending && (
            <div className="chat-msg assistant pending">
              <span className="spinner" aria-hidden="true" />
              <p>Reading your itinerary…</p>
            </div>
          )}
        </div>

        <form
          className="chat-compose"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={input}
            rows={1}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              grow();
            }}
            onKeyDown={onKeyDown}
            placeholder={exhausted && limits ? `No messages left until ${clock(limits.resetsAt)}` : 'Paste an itinerary or describe your trip'}
            aria-label="Your trip"
            aria-describedby={left < 400 ? 'chat-left' : undefined}
            enterKeyHint="send"
            disabled={exhausted}
          />
          <button className="chat-send" type="submit" disabled={!canSend} aria-label="Send">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M8 13V3.5M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {left < 400 && (
            <p id="chat-left" className={`chat-left${left < 0 ? ' over' : ''}`}>
              {left < 0 ? `${plural(-left, 'character')} too long. Start over with just the travel details.` : `${plural(left, 'character')} left`}
            </p>
          )}
        </form>
      </div>
    </dialog>
  );
}

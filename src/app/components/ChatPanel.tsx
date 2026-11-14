import {
  BusIcon,
  CarIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleQuestionMarkIcon,
  EllipsisVerticalIcon,
  LinkIcon,
  LoaderCircleIcon,
  Minimize2Icon,
  Share2Icon,
  Trash2Icon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlaneIcon,
  PlusIcon,
  ShipIcon,
  TrainFrontIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Conversation, ConversationContent, ConversationFollow, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent } from '@/components/ai-elements/message';
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input';
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from '@/components/ui/questionnaire';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Progress } from '@/components/ui/progress';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import type { NormalizedSceneV1, SceneSpecV1 } from '../../shared/scene/types';
import { journeyTitle } from '../../shared/scene/title';
import { sceneSummary } from '../../shared/scene/summary';
import {
  ApiFailure,
  type ComposeLeg,
  type ComposeLimits,
  type ComposeMessage,
  type ComposeQuestion,
  type SceneView,
  compose,
  createScene,
  deleteScene,
  getComposeLimits,
  putScene,
} from '../api';
import type { ChatBridge, ChatState, Draft } from '../draft';
import { type ExportChoice, type ExportPhase, describeExport, exportRunning, runExport } from '../exportOptions';
import { ExportProgress, ExportQuestionnaire, ExportResult, PublishReply, type PublishState } from './ChatActions';
import { ChatFaq, type FaqRequest } from './ChatFaq';
import { CopyButton, copyText, getStartedPrompt, publicOrigin } from './CopyPrompt';
import { PRIVACY_QUESTION } from '../faq';

/** The server's cap on a whole conversation (src/server/compose/index.ts). */
const MAX_CHARACTERS = 4000;
/** Filled into the message box by "Try an example", to edit before sending. */
const EXAMPLE = 'BA 117 from London Heathrow to New York JFK on Sat 12 June 2027, 08:20 → 11:05, then AA 3 from JFK to Los Angeles on 14 June, 08:00 → 11:25.';

type Entry =
  /** `sent`: answered, so it's part of the conversation sent with later messages. */
  | { id: number; kind: 'user'; text: string; sent: boolean }
  | { id: number; kind: 'questions'; questions: ComposeQuestion[] }
  /**
   * `outcome`: whether the journey is being saved to the draft, or was. `conflict`: someone else saved first, so it
   * wasn't applied. `revision`: the draft revision the save made.
   */
  | { id: number; kind: 'ready'; legs: ComposeLeg[]; outcome: 'saving' | 'created' | 'updated' | 'unsaved' | 'conflict'; revision?: number }
  /**
   * The draft changed outside this chat: the trip as it is now. `by: 'agent'`: an agent here saved it through the
   * page's browser tools; otherwise an agent over HTTP or another window did.
   */
  | { id: number; kind: 'changed'; legs: ComposeLeg[]; revision: number; by?: 'agent' }
  | { id: number; kind: 'notice'; text: string }
  | { id: number; kind: 'limit'; limits: ComposeLimits }
  /** What the person asked for with a button in the suggestion row, shown as their message. */
  | { id: number; kind: 'action'; text: string }
  | ({ id: number; kind: 'publish' } & PublishState)
  | { id: number; kind: 'export'; scene: NormalizedSceneV1; choice: ExportChoice; phase: ExportPhase }
  /** What happened to a message, as AI Elements' Task: reading it, then what was found and saved. */
  | { id: number; kind: 'task'; characters: number; reading: boolean; failed?: boolean; found?: Found; questions?: number; ready?: number }
  /** A short note from the page itself, such as "Private link copied". */
  | { id: number; kind: 'info'; text: string };

/** What a reply found: the legs by how they were travelled, and the airports they were placed at. */
interface Found {
  kinds: Record<string, number>;
  airports: string[];
}

let nextId = 1;

const aircraftLine = (l: ComposeLeg) => (l.typical ? `${l.by} (typical)` : l.by);

/**
 * What the server reads back. Once there's a draft, the draft stands for everything said before it: its legs open
 * the conversation, as the traveller's own words (they are the traveller's trip, saved), followed by what's been
 * said since. That keeps a long conversation inside the character cap and includes any change an agent made.
 */
/**
 * Where a draft's conversation starts again: after the last journey the chat put on the draft (or tried to). A
 * reading that someone else's save overtook isn't a fresh start: its request still stands, to apply to their version.
 */
const sinceLastJourney = (entries: Entry[]) => entries.findLastIndex((e) => e.kind === 'ready' && e.outcome !== 'conflict') + 1;

function conversation(entries: Entry[], seed: string | null): ComposeMessage[] {
  const out: ComposeMessage[] = seed ? [{ role: 'user', content: seed }] : [];
  const from = seed ? sinceLastJourney(entries) : 0;
  for (const e of entries.slice(from)) {
    if (e.kind === 'user' && e.sent) out.push({ role: 'user', content: e.text });
    else if (e.kind === 'questions') out.push({ role: 'assistant', content: e.questions.map((q) => q.question).join('\n') });
    // The seed already has the trip as it is now; a reading of an older version would only pull back toward it.
    else if (e.kind === 'ready' && e.outcome !== 'conflict') out.push({ role: 'assistant', content: `Ready to create:\n${e.legs.map((l) => `${l.route}, ${l.when}, ${aircraftLine(l)}`).join('\n')}` });
  }
  return out;
}

/** The draft's journey as it is now, one leg per line, to open the conversation with. */
function draftSeed(draft: Draft): string | null {
  const view = draft.viewRef.current;
  if (!draft.sceneId || !view) return null;
  return `My trip as it is now:\n${sceneSummary(view.normalized)
    .map((l) => `${l.route}, ${l.when}, ${l.by}`)
    .join('\n')}`;
}

/**
 * A composed journey onto the draft: the new legs, with the draft's own title, look and weather. Timing that names
 * legs by id stays only while all those legs are still there.
 */
function onto(current: SceneSpecV1, next: SceneSpecV1): SceneSpecV1 {
  const ids = new Set(next.legs.map((l) => l.id));
  const p = current.presentation;
  const named = [...Object.keys(p?.legWeights ?? {}), ...Object.keys(p?.stopHolds ?? {})];
  const presentation = p && named.every((id) => ids.has(id)) ? p : p && { ...p, legWeights: undefined, stopHolds: undefined };
  return {
    ...current,
    title: current.title ?? next.title,
    legs: next.legs,
    ...(presentation ? { presentation: JSON.parse(JSON.stringify(presentation)) as typeof presentation } : {}),
  };
}

/**
 * What the person pastes into their own AI, which can look up schedules and timetables where this page can't: their
 * trip as they wrote it, what's missing, and an answer format they can paste back into the chat.
 */
export function aiRequest(trip: string[], questions: ComposeQuestion[], origin: string): string {
  return [
    `I'm making an animation of a trip with Route Replay (${new URL(origin).host}). It needs each leg's local date and times. Please help me fill in what's missing.`,
    '',
    'My trip, as I wrote it:',
    trip.join('\n\n'),
    '',
    'Still missing:',
    ...questions.map((q) => `- ${q.question}`),
    '',
    "Look up what you can: flight schedules and aircraft types for those dates, and train, bus and ferry timetables. Ask me for anything only I would know, such as which day I took a leg. If you can't find something, say so rather than guessing.",
    '',
    'Then write out the whole trip, one leg per line, in local times, with the aircraft type for each flight:',
    '<flight number>, <from> → <to>, <date with year>, <departure time> → <arrival time>, <aircraft type>',
    '<Train, Bus, Ferry or Drive>, <from> → <to>, <date with year>, <departure time> → <arrival time>',
    '',
    "I'll paste your answer back into Route Replay.",
  ].join('\n');
}

/** The person's answered messages since the draft (or all of them): their trip as they wrote it. */
const sentTrip = (entries: Entry[], seed: string | null) => [
  ...(seed ? [seed] : []),
  ...entries.slice(seed ? sinceLastJourney(entries) : 0).flatMap((e) => (e.kind === 'user' && e.sent ? [e.text] : [])),
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
/** A need as a line of its own: "Which London airport?", "Local departure and arrival times". */
const sentence = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}${/^(which|where)\b/.test(s) && !s.endsWith('?') ? '?' : ''}`;

// A draft's conversation, kept in this browser so it's there when the draft is opened again. The private link
// (a credential) is never stored, nor are notices.
const STORE = 'routereplay:chat:';
const stored = (e: Entry) => (e.kind === 'user' && e.sent) || e.kind === 'questions' || e.kind === 'ready' || e.kind === 'changed';
function loadEntries(sceneId: string): Entry[] {
  try {
    const raw = localStorage.getItem(STORE + sceneId);
    const list = raw ? (JSON.parse(raw) as { entries?: Entry[] }).entries : null;
    if (!Array.isArray(list)) return [];
    nextId = Math.max(nextId, ...list.map((e) => e.id + 1));
    return list.map((e) => (e.kind === 'ready' && e.outcome === 'saving' ? { ...e, outcome: 'unsaved' } : e));
  } catch {
    return [];
  }
}
function saveEntries(sceneId: string, entries: Entry[]) {
  try {
    localStorage.setItem(STORE + sceneId, JSON.stringify({ entries: entries.filter(stored) }));
  } catch {
    // Storage full or blocked: the conversation just won't be there next time.
  }
}

const LEG_ICONS: Record<string, typeof PlaneIcon> = { Train: TrainFrontIcon, Bus: BusIcon, Car: CarIcon, Ferry: ShipIcon };

function LegList({ legs }: { legs: ComposeLeg[] }) {
  return (
    <ItemGroup>
      {legs.map((l, i) => {
        const Icon = LEG_ICONS[l.by] ?? PlaneIcon;
        return (
          <Item key={i} variant="outline" size="sm" role="listitem">
            <ItemMedia variant="icon">
              <Icon aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{l.route}</ItemTitle>
              <ItemDescription>
                {l.when} · {aircraftLine(l)}
              </ItemDescription>
            </ItemContent>
          </Item>
        );
      })}
    </ItemGroup>
  );
}

/**
 * An agent working on the draft, as it reported over the draft's live socket (agent-docs: "Showing that you are
 * working"). It sits above the message box while it lasts; the scene shows it instead when the chat is out of view.
 */
function AgentActivity({ message }: { message: string }) {
  return (
    <Item variant="muted" size="sm" role="status">
      <ItemMedia>
        <Spinner aria-hidden="true" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Your agent is working</ItemTitle>
        {message && <ItemDescription>{message}</ItemDescription>}
      </ItemContent>
    </Item>
  );
}

/** Placeholder for a leg's free-text answer, from what it still needs. */
function hint(needs: string[]): string {
  const date = needs.includes('date');
  const times = needs.find((n) => n.startsWith('local'));
  const time = times === 'local departure and arrival times' ? '09:15 → 12:40' : times ? '09:15' : null;
  if (date && time) return `e.g. 14 Oct, ${time}`;
  if (date) return 'e.g. 14 Oct';
  if (time) return `e.g. ${time}`;
  return 'Your answer';
}

const KIND_NAMES: Record<string, [string, string]> = {
  flight: ['flight', 'flights'],
  train: ['train', 'trains'],
  bus: ['bus', 'buses'],
  car: ['drive', 'drives'],
  ferry: ['ferry', 'ferries'],
};

const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** The legs and airports in a reply's spec (complete or not). */
function foundIn(spec: SceneSpecV1): Found {
  const kinds: Record<string, number> = {};
  const airports = new Set<string>();
  for (const leg of spec.legs) {
    const kind = leg.mode ?? 'flight';
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    for (const code of [leg.from, leg.to]) if (code) airports.add(code);
  }
  return { kinds, airports: [...airports] };
}

/**
 * A message's work, as AI Elements' Task (shadcn's Trace): open while it runs, then a single line that opens to show
 * what was done. The steps are what the page knows happened: the request, then what the reply found, then the save.
 */
function WorkTrace({ task, saving }: { task: Extract<Entry, { kind: 'task' }>; saving?: Extract<Entry, { kind: 'ready' }>['outcome'] }) {
  const [open, setOpen] = useState<boolean>();
  const running = task.reading || saving === 'saving';
  const failed = task.failed || saving === 'unsaved';
  const overtaken = saving === 'conflict';
  const status = running ? 'running' : failed ? 'error' : undefined;
  const title = task.reading
    ? 'Reading your itinerary'
    : task.failed
      ? 'Couldn’t read your itinerary'
      : saving === 'saving'
        ? 'Saving the journey'
        : saving === 'unsaved'
          ? 'Couldn’t save the journey'
          : overtaken
            ? 'Read your itinerary; the trip changed meanwhile'
            : saving
            ? 'Read and saved your journey'
            : 'Read your itinerary';
  const kinds = task.found ? Object.entries(task.found.kinds).map(([k, n]) => `${n} ${KIND_NAMES[k]?.[n === 1 ? 0 : 1] ?? k}`) : [];
  return (
    <Trace>
      <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={status}>
            <TraceIcon>{running ? <LoaderCircleIcon className="animate-spin" /> : failed || overtaken ? <CircleAlertIcon /> : <CircleCheckIcon />}</TraceIcon>
            <TraceTitle>{title}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent keepMounted>
          <Trace>
            <TraceLine status={task.reading ? 'running' : task.failed ? 'error' : undefined}>
              <TraceTitle>{task.reading ? 'Sending to Cloudflare Workers AI' : 'Sent to Cloudflare Workers AI'}</TraceTitle>
              <TraceDescription>{plural(task.characters, 'character')}</TraceDescription>
            </TraceLine>
            {kinds.length > 0 && (
              <TraceLine>
                <TraceTitle>Found {list(kinds)}</TraceTitle>
              </TraceLine>
            )}
            {task.found && task.found.airports.length > 0 && (
              <TraceLine>
                <TraceTitle>Placed at {list(task.found.airports)}</TraceTitle>
              </TraceLine>
            )}
            {task.ready !== undefined && (
              <TraceLine>
                <TraceTitle>Used each airport’s time zone</TraceTitle>
              </TraceLine>
            )}
            {task.questions !== undefined && task.questions > 0 && (
              <TraceLine>
                <TraceTitle>{plural(task.questions, 'question')} still to answer</TraceTitle>
              </TraceLine>
            )}
            {saving && (
              <TraceLine status={saving === 'saving' ? 'running' : saving === 'unsaved' ? 'error' : undefined}>
                <TraceTitle>
                  {saving === 'saving'
                    ? 'Saving the draft'
                    : saving === 'created'
                      ? 'Made the draft'
                      : saving === 'updated'
                        ? 'Updated the draft'
                        : overtaken
                          ? 'Didn’t update the draft: it changed while this was read'
                          : 'Couldn’t save the draft'}
                </TraceTitle>
              </TraceLine>
            )}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

/**
 * AI Elements' Context, the usage chip: how much of this hour's messages this browser has left. The meter runs down
 * as messages are sent and fills again when the hour's window resets.
 */
function UsageChip({ limits }: { limits: ComposeLimits }) {
  const percent = Math.round((limits.remaining / limits.perHour) * 100);
  return (
    <HoverCard>
      <HoverCardTrigger delay={10} closeDelay={100} render={<Button variant="outline" size="sm" />}>
        {percent}% remaining
      </HoverCardTrigger>
      <HoverCardContent className="flex w-64 flex-col gap-3" side="top" align="start">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">Usage</span>
          <span className="text-muted-foreground">{percent}% remaining</span>
        </div>
        <Progress value={percent} aria-label="Messages remaining" />
        <div className="flex flex-col gap-1 text-sm">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Messages left this hour</span>
            <span>
              {limits.remaining} / {limits.perHour}
            </span>
          </div>
          {limits.remaining < limits.perHour && (
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">More messages</span>
              <span>after {clock(limits.resetsAt)}</span>
            </div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** One step of the questionnaire: a set of options to pick (an airport, the year), or what has to be typed. */
interface Step {
  name: string;
  /** The question it belongs to, and the need it answers (absent: the typed needs). */
  question: number;
  need?: number;
  title: string;
  description?: string;
  options?: string[];
  placeholder: string;
}

function stepsOf(questions: ComposeQuestion[]): Step[] {
  return questions.flatMap((q, qi) => {
    const title = q.about ?? q.question;
    const choiceNeeds = new Set(q.choices?.map((c) => c.need));
    const free = q.needs.filter((_, i) => !choiceNeeds.has(i));
    return [
      ...(q.choices ?? []).map((c) => ({
        name: `q${qi}-${c.need}`,
        question: qi,
        need: c.need,
        title,
        description: q.about ? sentence(q.needs[c.need]!) : undefined,
        options: c.options,
        placeholder: 'Something else',
      })),
      ...(free.length ? [{ name: `q${qi}`, question: qi, title, description: q.about ? sentence(free.join('; ')) : undefined, placeholder: hint(free) }] : []),
    ];
  });
}

/**
 * The latest questions as a questionnaire, one step at a time: options to pick (an airport, the year) and a box for
 * each leg's dates and times, any of which can be skipped. Sending turns the answers into one message, a line per
 * leg, as the person might have typed it.
 */
function QuestionsForm({ questions, disabled, onSend }: { questions: ComposeQuestion[]; disabled: boolean; onSend: (text: string) => void }) {
  const steps = stepsOf(questions);
  return (
    <Questionnaire
      items={steps.map((step) => ({ name: step.name, choices: step.options?.map((value) => ({ value })) }))}
      shortcuts="letters"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) return;
        const answers = new FormData(e.currentTarget);
        const lines = questions.flatMap((q, qi) => {
          const parts = steps
            .filter((step) => step.question === qi)
            .map((step) => String(answers.get(step.name) ?? '').trim())
            .filter(Boolean);
          if (!parts.length) return [];
          return [q.about ? `${q.about}: ${parts.join('; ')}` : `${q.question} ${parts.join('; ')}`];
        });
        if (lines.length) onSend(lines.join('\n'));
      }}
    >
      <QuestionnaireProgress />
      {steps.map((step) => (
        <QuestionnaireItem key={step.name} name={step.name}>
          <QuestionnaireTitle>{step.title}</QuestionnaireTitle>
          {step.description && <QuestionnaireDescription>{step.description}</QuestionnaireDescription>}
          <QuestionnaireChoices>
            {step.options?.map((option) => (
              <QuestionnaireChoice key={option} value={option}>
                {option}
              </QuestionnaireChoice>
            ))}
            <QuestionnaireInput aria-label={step.description ?? step.title} placeholder={step.placeholder} />
          </QuestionnaireChoices>
          <QuestionnaireError />
        </QuestionnaireItem>
      ))}
      <QuestionnaireActions>
        <QuestionnairePrevious />
        <QuestionnaireSkip />
        <QuestionnaireNext />
        <QuestionnaireSubmit disabled={disabled}>Send {questions.length > 1 ? 'answers' : 'answer'}</QuestionnaireSubmit>
      </QuestionnaireActions>
    </Questionnaire>
  );
}

export interface ChatPanelProps {
  draft: Draft;
  /** On the homepage until the chat makes a draft; then on the draft's page, editing it. */
  open: boolean;
  layout: 'rail' | 'drawer';
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /**
   * On phones, where the questions and answers go instead of over the chat: a layer above the scene's floating
   * window, so they cover it as well.
   */
  faqLayer: HTMLElement | null;
  /** Hide the rail, or close the homepage drawer. */
  onHide: () => void;
  /** Show the rail if it's hidden: an agent asked for something that's answered here (a watch link, a video). */
  onReveal: () => void;
  /** The chat made a draft: the page becomes it, opening it with the owner credential as an agent's link would. */
  onDraftCreated: (sceneId: string, ownerCredential: string) => void;
  /** From a draft, back to the homepage with a fresh chat. */
  onNewTrip: () => void;
  /** The draft was deleted: back to the homepage, without it in the history. */
  onDeleted: () => void;
}

/** On desktop, brings back a draft's hidden rail from the corner of the stage. It lives here to load with the chat. */
export function ShowChatButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="icon"
      className="studio-show-chat"
      onClick={onClick}
      aria-label="Show chat"
      title="Show chat"
      aria-controls="chat-panel"
      aria-expanded={false}
    >
      <PanelLeftOpenIcon aria-hidden="true" />
    </Button>
  );
}

/**
 * The chat beside the globe: a left rail on desktop, a drawer from the bottom on phones. Each message goes to
 * POST /api/v1/compose with the conversation so far. When the journey is complete, the chat saves it: the first
 * time as a new draft that this page becomes, then as new revisions of it.
 */
export function ChatPanel({ draft, open, layout, expanded, onExpandedChange, faqLayer, onHide, onReveal, onDraftCreated, onNewTrip, onDeleted }: ChatPanelProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [entries, setEntries] = useState<Entry[]>(() => (draft.sceneId ? loadEntries(draft.sceneId) : []));
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [limits, setLimits] = useState<ComposeLimits | null>(null);
  const inDraft = draft.sceneId !== null;
  // A conversation begun on the homepage keeps its introduction once it becomes a draft.
  const [startedHome] = useState(!inDraft);
  const ready = !inDraft || draft.load.kind === 'ready';

  // Keep a draft's conversation for next time.
  useEffect(() => {
    if (draft.sceneId && entries.some(stored)) saveEntries(draft.sceneId, entries);
  }, [draft.sceneId, entries]);

  // Focus goes to the message box where typing is easy; on touch screens, to the heading, so the keyboard doesn't
  // cover the introduction straight away. A homepage chat can mount already open (its code loads on first open, and
  // a new trip starts a fresh one), and that was the person's doing too; a draft's chat open with the page leaves
  // focus where it is.
  const wasOpen = useRef(open && inDraft);
  useEffect(() => {
    if (open && !wasOpen.current) {
      if (matchMedia('(pointer: fine)').matches) input.current?.focus({ preventScroll: true });
      else heading.current?.focus({ preventScroll: true });
    }
    wasOpen.current = open;
  }, [open]);

  // The allowance, fetched when the chat opens (it doesn't use a message).
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

  const seed = inDraft ? draftSeed(draft) : null;
  const used = conversation(entries, seed).reduce((n, m) => n + m.content.length, 0);
  const left = MAX_CHARACTERS - used - text.length;
  const busy = pending || entries.some((e) => e.kind === 'ready' && e.outcome === 'saving');
  const canSend = text.trim().length > 0 && !busy && !exhausted && left >= 0 && ready;
  // A reply's notes ("Your draft is updated") hold only until the trip changes again, here or elsewhere.
  const latestReady = entries.findLast((e) => e.kind === 'ready' || e.kind === 'changed')?.id;
  const origin = publicOrigin();

  const patch = (id: number, change: Partial<Entry>) => setEntries((list) => list.map((e) => (e.id === id ? ({ ...e, ...change } as Entry) : e)));
  const add = (...more: Entry[]) => setEntries((list) => [...list, ...more]);

  // Revisions saved outside this chat (an agent, another window, the page's browser tools) show in the thread, so the
  // conversation matches the trip on screen. The next message starts from it either way (draftSeed). `known` is the
  // latest revision the thread accounts for; the chat's own saves set it before they're adopted.
  const known = useRef<number | null>(null);
  // Revisions the page's browser tools saved, told to the chat before the page shows them (ChatBridge.agentSaved).
  const agentRevisions = useRef(new Set<number>());
  const shownRevision = draft.view?.revision ?? null;
  useEffect(() => {
    const v = draft.viewRef.current;
    if (!v || v.revision !== shownRevision) return;
    if (known.current === null) {
      // First sight of the draft: say if it changed since this browser's conversation last saw it.
      const seen = Math.max(0, ...entries.map((e) => (e.kind === 'ready' || e.kind === 'changed' ? (e.revision ?? 0) : 0)));
      known.current = seen > 0 && seen < v.revision ? seen : v.revision;
    }
    if (v.revision <= known.current) return;
    known.current = v.revision;
    const by = agentRevisions.current.has(v.revision) ? ('agent' as const) : undefined;
    add({ id: nextId++, kind: 'changed', legs: sceneSummary(v.normalized), revision: v.revision, ...(by ? { by } : {}) });
  }, [shownRevision]);

  /**
   * Save a complete journey: a new draft from the homepage, or a new revision of this one. `from` is the draft as it
   * was when the reading started (its trip was the seed), so a save made since then shows as a conflict.
   */
  async function save(spec: SceneSpecV1, entryId: number, from: SceneView | null) {
    try {
      if (!draft.sceneId) {
        const { body } = await createScene(spec);
        patch(entryId, { outcome: 'created', revision: body!.revision });
        onDraftCreated(body!.id, body!.credentials.owner);
        return;
      }
      const base = from ?? draft.viewRef.current!;
      try {
        const { body, etag } = await putScene(draft.sceneId, base.revision, onto(base.spec, spec));
        // The chat's own revision isn't a change from outside.
        known.current = body!.revision;
        draft.adopt(body!, etag);
        patch(entryId, { outcome: 'updated', revision: body!.revision });
      } catch (e) {
        // Someone (an agent, another window) saved while this was being read. This reading came from the version
        // before theirs, so saving it would quietly undo their change: leave it, show the trip as it is now, and
        // offer to apply the same request to it ("Apply my change again").
        if (!(e instanceof ApiFailure && e.info.code === 'revision_conflict')) throw e;
        patch(entryId, { outcome: 'conflict' });
        await draft.refresh();
      }
    } catch (e) {
      patch(entryId, { outcome: 'unsaved' });
      const message = e instanceof ApiFailure ? e.info.message : 'Check your connection and try again.';
      add({ id: nextId++, kind: 'notice', text: `I couldn’t ${draft.sceneId ? 'update' : 'create'} the draft. ${message}` });
    }
  }

  async function send(message: string) {
    const content = message.trim();
    if (!content || busy || exhausted || !ready) return;
    const mine: Entry = { id: nextId++, kind: 'user', text: content, sent: false };
    await read([...conversation(entries, draftSeed(draft)), { role: 'user' as const, content }], mine);
  }

  /** The request a save was overtaken by, read again onto the trip as it is now. It uses a message. */
  function retry() {
    if (busy || exhausted || !ready) return;
    void read(conversation(entries, draftSeed(draft)), { id: nextId++, kind: 'action', text: 'Apply my change again' });
  }

  /** Send the conversation to be read, shown as `mine` (the person's message, or the action that asked). */
  async function read(messages: ComposeMessage[], mine: Entry) {
    const from = draft.viewRef.current;
    const task: Entry = { id: nextId++, kind: 'task', characters: messages.reduce((n, m) => n + m.content.length, 0), reading: true };
    add(mine, task);
    setPending(true);
    try {
      const { body } = await compose(messages);
      const r = body!;
      setLimits(r.limits);
      const reply: Entry =
        r.status === 'ready' && r.legs
          ? { id: nextId++, kind: 'ready', legs: r.legs, outcome: 'saving' }
          : { id: nextId++, kind: 'questions', questions: r.questions };
      const found = foundIn(r.spec);
      setEntries((list) => [
        ...list.map((e) =>
          e.id === mine.id && mine.kind === 'user'
            ? { ...mine, sent: true }
            : e.id === task.id
              ? { ...task, reading: false, found, ...(reply.kind === 'ready' ? { ready: reply.id } : { questions: r.questions.length }) }
              : e,
        ),
        reply,
      ]);
      setPending(false);
      if (reply.kind === 'ready') await save(r.spec, reply.id, from);
    } catch (e) {
      const info = e instanceof ApiFailure ? e.info : null;
      const next = (info?.limits as ComposeLimits | undefined) ?? null;
      if (next) setLimits(next);
      // Over the limit: the limit message says it all; anything else gets a short explanation.
      const notice = !info
        ? 'I couldn’t reach Route Replay. Check your connection and try again.'
        : info.code === 'rate_limited'
          ? null
          : info.code === 'text_too_long'
            ? `That’s more than I can read at once: ${MAX_CHARACTERS.toLocaleString()} characters for the whole conversation. Start over with just the travel details.`
            : info.message;
      setEntries((list) => [
        ...list.map((e) => (e.id === task.id ? { ...task, reading: false, failed: true } : e)),
        ...(notice ? [{ id: nextId++, kind: 'notice' as const, text: notice }] : []),
      ]);
      setPending(false);
    }
  }

  /** A fresh conversation for another trip. Anything in the message box stays: it's often the new trip. */
  function startOver() {
    setEntries([]);
    input.current?.focus();
  }

  // The draft's actions, from the suggestion row: each shows as the person's message, answered in the chat.
  // An export runs here rather than in its reply, so its progress can take the message box's place.
  const exportJob = useRef<{ id: number; controller: AbortController } | null>(null);
  const exportFiles = useRef<string[]>([]);
  const runningExport = entries.find((e) => e.kind === 'export' && exportRunning(e.phase)) as Extract<Entry, { kind: 'export' }> | undefined;
  const exporting = runningExport !== undefined;
  useEffect(
    () => () => {
      // Leaving the conversation stops an export and lets go of the finished files.
      exportJob.current?.controller.abort();
      for (const url of exportFiles.current) URL.revokeObjectURL(url);
    },
    [],
  );

  function startExport(id: number, scene: NormalizedSceneV1, choice: ExportChoice) {
    exportJob.current?.controller.abort();
    const controller = new AbortController();
    exportJob.current = { id, controller };
    void runExport(scene, choice, controller.signal, (phase) => {
      if (exportJob.current?.controller !== controller) return;
      if (phase.kind === 'done') exportFiles.current.push(phase.url);
      if (!exportRunning(phase)) exportJob.current = null;
      patch(id, { phase } as Partial<Entry>);
    });
  }
  const view = draft.view;
  const publishedNow = view?.publications.find((p) => p.revision === view.revision);
  const publishing = entries.some((e) => e.kind === 'publish' && e.state === 'publishing');

  /**
   * Publish, from the suggestion row (the person's request, shown as their message) or from the browser tools (the
   * agent's, said in a line of its own), answered with the watch link either way.
   */
  async function publish(agent?: { revision: number }) {
    if (!view || (publishing && !agent)) return;
    const reply = { id: nextId++, kind: 'publish' as const, state: 'publishing' as const };
    add(agent ? { id: nextId++, kind: 'info', text: 'Your agent asked to publish your trip.' } : { id: nextId++, kind: 'action', text: publishLabel }, reply);
    try {
      const published = await draft.publish(agent?.revision);
      // Another link (to another version) existed before this one.
      const earlier = draft.viewRef.current?.publications.some((p) => p.id !== published.id) ?? false;
      patch(reply.id, { state: published.existing ? 'shared' : 'published', url: published.watchUrl, earlier } as Partial<Entry>);
      return published;
    } catch (e) {
      patch(reply.id, { state: 'failed', message: e instanceof ApiFailure ? e.info.message : 'Check your connection and try again.' } as Partial<Entry>);
      // The agent hears why; the person reads it in the reply.
      if (agent) throw e;
    }
  }

  function shareLink() {
    if (!view || !publishedNow) return;
    add(
      { id: nextId++, kind: 'action', text: 'Share link' },
      { id: nextId++, kind: 'publish', state: 'shared', url: publishedNow.watchUrl, earlier: view.publications.length > 1 },
    );
  }

  // A questionnaire takes the message box's place while it waits for answers, as an agent's ask-the-user tool
  // does: the latest questions, or the export's shape and quality. "Type instead" brings the box back.
  const [askExport, setAskExport] = useState(false);
  const [lastExport, setLastExport] = useState<ExportChoice | null>(null);
  const [typingFor, setTypingFor] = useState<number | null>(null);
  const [pasteAnswer, setPasteAnswer] = useState(false);
  const latest = entries.findLast((e) => e.kind === 'questions');
  const liveQuestions = latest?.kind === 'questions' && !entries.some((x) => x.id > latest.id && x.kind === 'user') ? latest : null;
  const dock = runningExport
    ? 'exporting'
    : askExport && view
      ? 'export'
      : liveQuestions && typingFor !== liveQuestions.id && !busy && !exhausted
        ? 'questions'
        : null;
  const answerChip = liveQuestions !== null && typingFor === liveQuestions.id && !busy && !exhausted;

  // The draft's actions are offered only when the draft on screen is settled: not while a message is being read or
  // saved, while questions about a change are open, while a change is being typed, while an agent is working on the
  // draft, or after a change that didn't save. Publishing or exporting then would capture a version about to change.
  const lastEntry = entries.at(-1);
  const lastReady = entries.findLast((e) => e.kind === 'ready' || e.kind === 'changed');
  const settled =
    inDraft &&
    view !== null &&
    !busy &&
    liveQuestions === null &&
    !text.trim() &&
    !draft.activity &&
    !(lastReady?.kind === 'ready' && lastReady.outcome === 'unsaved');
  const earlierLinks = (view?.publications.length ?? 0) > 0;
  /** Publish, or "Publish changes" once an earlier version has a watch link. */
  const publishLabel = earlierLinks ? 'Publish changes' : 'Publish';
  const offerPublish = settled && !publishedNow && !publishing && !!view?.capabilities.publish;
  // Share the published version's link, but not straight after the reply that shows it.
  const offerShare =
    settled && !!publishedNow && !(lastEntry?.kind === 'publish' && 'url' in lastEntry && lastEntry.url === publishedNow.watchUrl);
  // An export card has its own "Export another".
  const offerExport = settled && !exporting && lastEntry?.kind !== 'export';
  // It would replace what's being typed.
  const offerExample = !inDraft && entries.length === 0 && !text.trim();
  // Before a draft exists, once the person has said something and it isn't being read: a draft has New trip in its menu
  // instead. Not at the hour's limit, where it would only clear the limit's note and its prompt for their own agent.
  const offerStartOver = !inDraft && entries.some((e) => e.kind === 'user') && !busy && !exhausted;
  // A reading someone else's save overtook: apply the same request to the trip as it is now, until something's sent.
  const lastReading = entries.findLast((e) => e.kind === 'ready');
  const offerRetry =
    lastReading?.kind === 'ready' &&
    lastReading.outcome === 'conflict' &&
    !entries.some((x) => x.id > lastReading.id && (x.kind === 'user' || x.kind === 'action')) &&
    !busy &&
    !exhausted &&
    ready;

  function typeInstead(paste = false) {
    if (liveQuestions) setTypingFor(liveQuestions.id);
    setPasteAnswer(paste);
    requestAnimationFrame(() => input.current?.focus());
  }

  /** Export a video of the trip on screen, asked for in the questionnaire or (`byAgent`) through the browser tools. */
  function exportVideo(choice: ExportChoice, byAgent = false) {
    if (!view || exporting) return;
    setAskExport(false);
    setLastExport(choice);
    const id = nextId++;
    const asked: Entry = byAgent
      ? { id: nextId++, kind: 'info', text: `Your agent started a video export: ${describeExport(choice)}.` }
      : { id: nextId++, kind: 'action', text: `Export video: ${describeExport(choice)}` };
    add(asked, { id, kind: 'export', scene: view.normalized, choice, phase: { kind: 'checking' } });
    startExport(id, view.normalized, choice);
  }

  // The browser tools reach the chat through the draft (ChatBridge): what it's doing, so an agent waits rather than
  // change the trip under a message being read, and its Publish and Export, answered here in the thread. The bridge
  // is made once and reads the latest render through refs.
  const chatState = useRef<ChatState>({ changing: false, asking: false, typing: false, exporting: false });
  chatState.current = { changing: busy, asking: liveQuestions !== null, typing: !!text.trim(), exporting };
  const actions = useRef({ publish, exportVideo, onReveal, exportStatus: () => null as ExportPhase | null });
  actions.current = {
    publish,
    exportVideo,
    onReveal,
    exportStatus: () => (entries.findLast((e) => e.kind === 'export') as Extract<Entry, { kind: 'export' }> | undefined)?.phase ?? null,
  };
  useEffect(() => {
    const bridge: ChatBridge = {
      state: () => chatState.current,
      publish: async (revision) => {
        actions.current.onReveal();
        const published = await actions.current.publish({ revision });
        if (!published) throw new Error('The draft hasn’t loaded yet.');
        return published;
      },
      exports: {
        start(choice) {
          if (chatState.current.exporting) return { ok: false, code: 'export_running', message: 'An export is already running in the chat.' };
          if (!draft.viewRef.current) return { ok: false, code: 'not_ready', message: 'The draft hasn’t loaded yet.' };
          actions.current.onReveal();
          actions.current.exportVideo(choice, true);
          return { ok: true };
        },
        status: () => actions.current.exportStatus(),
      },
      agentSaved: (revision) => void agentRevisions.current.add(revision),
    };
    draft.chat.current = bridge;
    return () => {
      if (draft.chat.current === bridge) draft.chat.current = null;
    };
  }, [draft.chat, draft.viewRef]);

  // The trip's menu: a new trip, its links, and deleting it.
  const publicLink = publishedNow?.watchUrl ?? view?.publications[0]?.watchUrl ?? null;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const info = (text: string) => add({ id: nextId++, kind: 'info', text });

  async function copyPrivateLink() {
    if (!draft.privateLink) return;
    if (await copyText(draft.privateLink)) {
      info('Private link copied. It opens this draft anywhere, and anyone with it can edit, publish or delete the draft, so keep it to yourself.');
    }
  }

  async function sharePublicLink() {
    if (!publicLink || !view) return;
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.share) {
      try {
        await nav.share({ title: journeyTitle(view.normalized), url: publicLink });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
      }
    }
    if (await copyText(publicLink)) info(`Public link copied: ${publicLink}`);
  }

  async function deleteTrip() {
    if (!draft.sceneId || deleting) return;
    setDeleting(true);
    try {
      await deleteScene(draft.sceneId);
      try {
        localStorage.removeItem(STORE + draft.sceneId);
      } catch {
        // Nothing stored, or storage blocked.
      }
      setConfirmDelete(false);
      onDeleted();
    } catch (e) {
      setConfirmDelete(false);
      add({ id: nextId++, kind: 'notice', text: `I couldn’t delete the trip. ${e instanceof ApiFailure ? e.info.message : 'Check your connection and try again.'}` });
    } finally {
      setDeleting(false);
    }
  }

  const title = inDraft ? (view ? journeyTitle(view.normalized) : 'Your trip') : 'Describe your trip';
  const summary = inDraft && draft.view ? sceneSummary(draft.view.normalized) : null;
  const drawer = layout === 'drawer';
  const collapsed = drawer && !expanded;
  // A draft's menu: New trip, its links, Delete. Not on a collapsed phone bar, which a tap expands.
  const tripMenu = inDraft && view !== null && !collapsed;

  // The questions and answers, over the chat. Hiding or collapsing the chat closes them.
  const [faq, setFaq] = useState<FaqRequest | null>(null);
  const showFaq = (item: string | null, opener: HTMLElement) => setFaq({ item, opener });
  if (faq && (!open || collapsed)) setFaq(null);
  const faqPanel = <ChatFaq request={faq} layout={layout} onClose={() => setFaq(null)} />;

  return (
    <div className="chat-panel relative flex h-full min-h-0 flex-col font-sans" data-layout={layout} data-expanded={expanded}>
      <div
        // Filling a phone's screen, the bar sits below the status bar and notch. On a phone it's three columns of
        // equal sides, so the title stays centred whether or not the FAQ button shows: collapse, title and ⋮, FAQ.
        className={`chat-panel-head shrink-0 items-center gap-1 border-b border-sidebar-border transition-[height,padding] duration-300 ${
          drawer ? 'grid grid-cols-[2rem_minmax(0,1fr)_2rem] px-2' : 'flex pl-4 pr-2'
        } ${drawer && expanded ? 'h-[calc(3.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]' : 'h-14'}`}
        inert={faq !== null || undefined}
        onClick={(e) => {
          // On a phone, the bar itself opens the collapsed drawer.
          if (collapsed && !(e.target as HTMLElement).closest('button')) onExpandedChange(true);
        }}
      >
        {drawer && (
          <Button
            variant="ghost"
            size="icon-sm"
            // It says whether the drawer is open, but shouldn't look pressed the whole time it is: no fill for
            // aria-expanded, the stock hover kept.
            className="aria-expanded:bg-transparent aria-expanded:hover:bg-muted dark:aria-expanded:hover:bg-muted/50"
            onClick={() => onExpandedChange(!expanded)}
            aria-label={expanded ? 'Collapse chat' : 'Expand chat'}
            aria-expanded={expanded}
            aria-controls="chat-body"
          >
            {expanded ? <ChevronDownIcon aria-hidden="true" /> : <ChevronUpIcon aria-hidden="true" />}
          </Button>
        )}
        {/* With a menu, the title is the button that opens it: one target, the ⋮ right after the words. Desktop pulls it
            left by the button's padding so the words line up with the conversation below. */}
        <div className={`flex min-w-0 items-center ${drawer ? 'justify-center' : `mr-auto ${tripMenu ? '-ml-2.5' : ''}`}`}>
          <h2 ref={heading} id="chat-title" tabIndex={-1} className="flex min-w-0 font-heading text-sm font-medium outline-none">
            {tripMenu ? (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" className="max-w-full min-w-0 shrink" title="Trip options" />}>
                  <span className="truncate">{title}</span>
                  <EllipsisVerticalIcon data-icon="inline-end" aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-52" align={drawer ? 'center' : 'start'}>
                  <DropdownMenuItem onClick={onNewTrip}>
                    <PlusIcon />
                    New trip
                  </DropdownMenuItem>
                  {draft.privateLink && (
                    <DropdownMenuItem onClick={() => void copyPrivateLink()}>
                      <LinkIcon />
                      Copy private link
                    </DropdownMenuItem>
                  )}
                  {publicLink && (
                    <DropdownMenuItem onClick={() => void sharePublicLink()}>
                      <Share2Icon />
                      Share public link
                    </DropdownMenuItem>
                  )}
                  {view.capabilities.delete && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                        <Trash2Icon />
                        Delete trip
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <span className="truncate">{title}</span>
            )}
          </h2>
        </div>
        {/* An empty cell on a collapsed phone bar keeps the title centred. */}
        <div className="flex justify-end">
          {!collapsed && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => showFaq(null, e.currentTarget)}
              aria-label="Questions and answers"
              title="Questions and answers"
              aria-expanded={faq !== null}
              aria-controls="chat-faq"
            >
              <CircleQuestionMarkIcon aria-hidden="true" />
            </Button>
          )}
        </div>
        {!drawer && (
          <Button variant="ghost" size="icon-sm" onClick={onHide} aria-label="Hide chat" title="Hide chat">
            <PanelLeftCloseIcon aria-hidden="true" />
          </Button>
        )}
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={(o) => !deleting && setConfirmDelete(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this trip?</AlertDialogTitle>
            <AlertDialogDescription>
              The draft is deleted for everyone, and so are its watch links: anyone who opens one is told the journey was deleted. This can’t be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleting} onClick={() => void deleteTrip()}>
              {deleting ? 'Deleting…' : 'Delete trip'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div id="chat-body" className="chat-panel-body flex min-h-0 flex-1 flex-col" hidden={collapsed} inert={faq !== null || undefined}>
        {/* Trackpad scrolling here scrolls the chat; the globe turns only over the stage. */}
        {/* A new conversation opens at its first line; a restored one at its latest. */}
        <Conversation className="min-h-0" initial={entries.length ? 'instant' : false} aria-label="Conversation" aria-live="polite" aria-relevant="additions">
          <ConversationContent>
            <Message from="assistant">
              <MessageContent>
                {!startedHome ? (
                  <p>Tell me what to change, such as a time, an aircraft or another leg, and I’ll update the draft.</p>
                ) : (
                  <>
                    <p>Paste a booking confirmation, or list each flight, train, bus and ferry with local times if you have them, and I’ll put your trip on the globe.</p>
                    {entries.length === 0 && (
                      <>
                        <p>Using your own AI agent? Copy this prompt into it.</p>
                        <CopyButton
                          variant="outline"
                          className="self-start"
                          getText={() => getStartedPrompt(origin)}
                          copiedMessage="Prompt copied. Paste it into your agent and describe your trip."
                        >
                          Copy prompt for your agent
                        </CopyButton>
                      </>
                    )}
                  </>
                )}
                {inDraft && summary && entries.length === 0 && <LegList legs={summary} />}
                <p className="text-muted-foreground">
                  Cloudflare Workers AI reads what you send; neither Cloudflare nor Route Replay keeps it.{' '}
                  <button
                    type="button"
                    className="cursor-pointer text-inherit underline underline-offset-3 hover:text-foreground"
                    onClick={(e) => showFaq(PRIVACY_QUESTION, e.currentTarget)}
                    aria-controls="chat-faq"
                  >
                    More about privacy
                  </button>
                </p>
              </MessageContent>
            </Message>

            {entries.map((e) => {
              if (e.kind === 'user') {
                return (
                  <Message key={e.id} from="user">
                    <MessageContent className="whitespace-pre-wrap [overflow-wrap:anywhere]">{e.text}</MessageContent>
                  </Message>
                );
              }
              if (e.kind === 'questions') {
                const live = e.id === liveQuestions?.id;
                return (
                  <Message key={e.id} from="assistant">
                    <MessageContent>
                      <p>{e.questions.length === 1 ? 'One more thing:' : 'To draw your trip, I still need:'}</p>
                      <ul className="list-disc pl-5 text-muted-foreground">
                        {e.questions.map((q) => (
                          <li key={q.question}>
                            {q.about ? (
                              <>
                                <span className="font-medium text-foreground">{q.about}</span>: {q.needs.join('; ')}
                              </>
                            ) : (
                              q.question
                            )}
                          </li>
                        ))}
                      </ul>
                      {/* Times, timetables and places can be looked up; the person's own AI can do that, where this page can't. */}
                      {live && e.questions.some((q) => q.lookup) && (
                        <>
                          <p className="text-muted-foreground">Answer below, or let your own AI look these up and paste its answer.</p>
                          {/* Copying brings the message box back, ready for the AI's answer. */}
                          <CopyButton
                            variant="outline"
                            className="self-start"
                            getText={() => aiRequest(sentTrip(entries, seed), e.questions, origin)}
                            copiedMessage="Request copied. Paste it into your AI, then paste its answer here."
                            onCopied={() => typeInstead(true)}
                          >
                            Copy request for your AI
                          </CopyButton>
                        </>
                      )}
                    </MessageContent>
                  </Message>
                );
              }
              if (e.kind === 'ready' && e.outcome === 'conflict') {
                return (
                  <Message key={e.id} from="assistant">
                    <MessageContent>
                      <p>Your trip changed while I was reading that, so I didn’t apply it: it would have undone the other change.</p>
                    </MessageContent>
                  </Message>
                );
              }
              if (e.kind === 'changed') {
                return (
                  <Message key={e.id} from="assistant">
                    <MessageContent>
                      <p>
                        {e.by === 'agent'
                          ? 'Your agent changed your trip. Here it is now, in local times.'
                          : 'Your trip was changed outside this chat, by your agent or in another window. Here it is now, in local times.'}
                      </p>
                      <LegList legs={e.legs} />
                    </MessageContent>
                  </Message>
                );
              }
              if (e.kind === 'ready') {
                const live = e.id === latestReady;
                return (
                  <Message key={e.id} from="assistant">
                    <MessageContent>
                      <p>{e.outcome === 'updated' ? 'Here’s the journey now, in local times.' : 'Here’s your journey, in local times.'}</p>
                      <LegList legs={e.legs} />
                      {live && e.outcome === 'saving' && <Shimmer>{inDraft ? 'Updating your draft…' : 'Putting it on the globe…'}</Shimmer>}
                      {live && e.outcome === 'created' && <p>It’s on the globe. Keep typing to change anything.</p>}
                      {live && e.outcome === 'updated' && <p>Your draft is updated.</p>}
                      {live && e.legs.some((l) => l.typical) && (
                        <p className="text-muted-foreground">
                          Where you didn’t name the aircraft, I picked a typical one for the distance. Tell me the type to change it.
                        </p>
                      )}
                    </MessageContent>
                  </Message>
                );
              }
              if (e.kind === 'task') {
                const ready = e.ready !== undefined ? entries.find((x) => x.id === e.ready) : undefined;
                return (
                  <Message key={e.id} from="assistant">
                    <MessageContent>
                      <WorkTrace task={e} saving={ready?.kind === 'ready' ? ready.outcome : undefined} />
                    </MessageContent>
                  </Message>
                );
              }
              if (e.kind === 'info') {
                return (
                  <Message key={e.id} from="assistant">
                    <MessageContent>
                      <p className="text-muted-foreground">{e.text}</p>
                    </MessageContent>
                  </Message>
                );
              }
              if (e.kind === 'action') {
                return (
                  <Message key={e.id} from="user">
                    <MessageContent>{e.text}</MessageContent>
                  </Message>
                );
              }
              if (e.kind === 'publish') {
                return (
                  <Message key={e.id} from="assistant">
                    <MessageContent className="w-full">
                      <PublishReply reply={e} title={view ? journeyTitle(view.normalized) : 'Route Replay'} />
                    </MessageContent>
                  </Message>
                );
              }
              if (e.kind === 'export') {
                return (
                  <Message key={e.id} from="assistant">
                    <MessageContent className="w-full">
                      <ExportResult
                        phase={e.phase}
                        // The trip as it was exported, not as it is now.
                        title={journeyTitle(e.scene)}
                        onTryAgain={() => {
                          patch(e.id, { phase: { kind: 'checking' } } as Partial<Entry>);
                          startExport(e.id, e.scene, e.choice);
                        }}
                        onAgain={() => setAskExport(true)}
                      />
                    </MessageContent>
                  </Message>
                );
              }
              if (e.kind === 'limit') {
                return (
                  <Message key={e.id} from="assistant">
                    <MessageContent>
                      <p>
                        {e.limits.reached === 'everyone'
                          ? 'Route Replay has used up today’s messages for everyone.'
                          : `You’ve used the ${plural(e.limits.perHour, 'message')} this hour allows.`}{' '}
                        Your own AI agent can make the journey instead: copy this prompt into it, then describe your trip.
                      </p>
                      <CopyButton
                        className="self-start"
                        getText={() => getStartedPrompt(origin)}
                        copiedMessage="Prompt copied. Paste it into your agent and describe your trip."
                      >
                        Copy prompt for your agent
                      </CopyButton>
                      <p className="text-muted-foreground">You can send more here after {clock(e.limits.resetsAt)}.</p>
                    </MessageContent>
                  </Message>
                );
              }
              return (
                <Message key={e.id} from="assistant">
                  <MessageContent>
                    <Alert variant="destructive">
                      <CircleAlertIcon aria-hidden="true" />
                      <AlertDescription>{e.text}</AlertDescription>
                    </Alert>
                  </MessageContent>
                </Message>
              );
            })}

          </ConversationContent>
          <ConversationFollow when={entries.length} />
          <ConversationFollow when={expanded} />
          <ConversationScrollButton />
        </Conversation>

        <div
          data-chat-footer
          className="flex max-h-[75%] shrink-0 flex-col gap-2 overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-1"
        >
          {inDraft && draft.activity && <AgentActivity message={draft.activity.message} />}
          {dock === 'exporting' && runningExport ? (
            <div className="rounded-lg border p-4">
              <ExportProgress phase={runningExport.phase} onCancel={() => exportJob.current?.controller.abort()} />
            </div>
          ) : dock === 'questions' && liveQuestions ? (
            <div className="relative flex flex-col gap-4 rounded-lg border p-4">
              {/* Minimizing brings the message box back, as does copying the request for the person's AI in the thread;
                  "Answer the questions" reopens this. */}
              <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2" aria-label="Minimize questions" title="Minimize" onClick={() => typeInstead()}>
                <Minimize2Icon />
              </Button>
              <QuestionsForm key={liveQuestions.id} questions={liveQuestions.questions} disabled={busy || exhausted} onSend={(t) => void send(t)} />
            </div>
          ) : dock === 'export' ? (
            <div className="relative rounded-lg border p-4">
              <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2" aria-label="Minimize export" title="Minimize" onClick={() => setAskExport(false)}>
                <Minimize2Icon />
              </Button>
              <ExportQuestionnaire initial={lastExport} onSubmit={exportVideo} />
            </div>
          ) : (
            <>
              {(answerChip || offerRetry || offerPublish || offerShare || offerExport || offerExample || offerStartOver) && (
                <Suggestions>
                  {offerRetry && <Suggestion suggestion="Apply my change again" onClick={retry} />}
                  {/* Questions answered by typing can be brought back. */}
                  {answerChip && <Suggestion suggestion="Answer the questions" onClick={() => setTypingFor(null)} />}
                  {offerPublish && <Suggestion suggestion={publishLabel} onClick={() => void publish()} />}
                  {offerShare && <Suggestion suggestion="Share link" onClick={shareLink} />}
                  {offerExport && <Suggestion suggestion="Export video" onClick={() => setAskExport(true)} />}
                  {/* Before the first message: something to start from, filled into the box to edit before sending. */}
                  {offerExample && (
                    <Suggestion
                      suggestion={EXAMPLE}
                      onClick={(s) => {
                        setText(s);
                        input.current?.focus();
                      }}
                    >
                      Try an example
                    </Suggestion>
                  )}
                  {offerStartOver && <Suggestion suggestion="Start over" onClick={startOver} />}
                </Suggestions>
              )}
              <PromptInput
                onSubmit={() => {
                  if (!canSend) return;
                  const t = text;
                  setText('');
                  setPasteAnswer(false);
                  void send(t);
                }}
              >
                <PromptInputTextarea
                  ref={input}
                  rows={1}
                  value={text}
                  onChange={(e) => setText(e.currentTarget.value)}
                  placeholder={
                    exhausted && limits
                      ? `No messages left until ${clock(limits.resetsAt)}`
                      : pasteAnswer
                        ? 'Paste your AI’s answer'
                        : inDraft
                          ? 'Describe a change to your trip'
                          : 'Paste an itinerary or describe your trip'
                  }
                  aria-label={inDraft ? 'A change to your trip' : 'Your trip'}
                  aria-describedby={left < 0 ? 'chat-too-long' : undefined}
                  enterKeyHint="send"
                  disabled={exhausted}
                />
                <PromptInputFooter>
                  <div id="chat-left" className="flex min-w-0 items-center gap-2">
                    {limits && <UsageChip limits={limits} />}
                    {left < 0 && (
                      <p id="chat-too-long" className="text-xs text-destructive">
                        {plural(-left, 'character')} too long. {inDraft ? 'Send less at once.' : 'Start over with just the travel details.'}
                      </p>
                    )}
                  </div>
                  {/* Not disabled when there's nothing to send: the stock input group fades everything in it, the usage
                      chip too, while any control in it is disabled. Sending checks instead. */}
                  <PromptInputSubmit aria-label="Send" />
                </PromptInputFooter>
              </PromptInput>
            </>
          )}
        </div>
      </div>

      {drawer && faqLayer ? createPortal(faqPanel, faqLayer) : faqPanel}
    </div>
  );
}

/**
 * The draft's actions as chat replies: publishing (and sharing what's published), and exporting a video on this
 * device. The suggestion row above the message box starts them (ChatPanel.tsx).
 */
import { DownloadIcon, FilePlayIcon, LinkIcon, ShareIcon } from 'lucide-react';
import { useState } from 'react';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from '@/components/ui/questionnaire';
import type { AspectRatio } from '../../shared/scene/constants';
import type { ExportQuality } from '../export';
import { ASPECTS, type ExportChoice, type ExportPhase, QUALITIES, exportRunning, screenAspect } from '../exportOptions';
import { CopyButton } from './CopyPrompt';

export type PublishState =
  | { state: 'publishing' }
  /** `shared`: the link of a version published earlier, shown again. `earlier`: other versions have links too. */
  | { state: 'published' | 'shared'; url: string; earlier: boolean }
  | { state: 'failed'; message: string };

/** A reply to Publish (or Share link): the watch link, to open, copy or share. The trip's name over its address. */
export function PublishReply({ reply, title }: { reply: PublishState; title: string }) {
  if (reply.state === 'publishing') return <Shimmer>Publishing…</Shimmer>;
  if (reply.state === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTitle>Publishing failed</AlertTitle>
        <AlertDescription>{reply.message}</AlertDescription>
      </Alert>
    );
  }
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  return (
    <>
      <p>{reply.state === 'published' ? 'Published. Anyone with this link can watch it:' : 'Anyone with this link can watch this version:'}</p>
      <Item variant="outline" size="sm">
        <ItemMedia variant="icon">
          <LinkIcon aria-hidden="true" />
        </ItemMedia>
        <ItemContent className="min-w-0">
          {/* Both lines open the watch page; the copy and share buttons sit beside the link, not inside it. */}
          <a
            className="group/link flex min-w-0 flex-col gap-0.5 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            href={reply.url}
            target="_blank"
            rel="noopener"
          >
            <ItemTitle className="w-full">
              <span className="truncate group-hover/link:underline">{title}</span>
            </ItemTitle>
            <ItemDescription className="truncate text-xs">{reply.url.replace(/^https?:\/\//, '')}</ItemDescription>
          </a>
        </ItemContent>
        <ItemActions>
          <CopyButton variant="outline" size="icon-sm" aria-label="Copy link" getText={() => reply.url} copiedMessage="Watch link copied." />
          {nav.share && (
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Share"
              onClick={() => void nav.share!({ title, url: reply.url }).catch(() => undefined)}
            >
              <ShareIcon aria-hidden="true" />
            </Button>
          )}
        </ItemActions>
      </Item>
      {reply.earlier && <p className="text-muted-foreground">Earlier links keep showing the versions they were made from.</p>}
    </>
  );
}

/** The export's shape and quality, asked in place of the message box: two steps, with a choice already picked. */
export function ExportQuestionnaire({ initial, onSubmit }: { initial: ExportChoice | null; onSubmit: (choice: ExportChoice) => void }) {
  const [start] = useState<ExportChoice>(() => initial ?? { aspect: screenAspect(), quality: 'standard' });
  return (
    <Questionnaire
      items={[
        { name: 'shape', required: true, choices: ASPECTS.map((a) => ({ value: a.value })) },
        { name: 'quality', required: true, choices: QUALITIES.map((q) => ({ value: q.value })) },
      ]}
      shortcuts="letters"
      onSubmit={(e) => {
        e.preventDefault();
        const answers = new FormData(e.currentTarget);
        onSubmit({ aspect: String(answers.get('shape')) as AspectRatio, quality: String(answers.get('quality')) as ExportQuality });
      }}
    >
      <QuestionnaireProgress />
      <QuestionnaireItem name="shape" required>
        <QuestionnaireTitle>What shape should the video be?</QuestionnaireTitle>
        <QuestionnaireDescription>Landscape suits most screens; portrait suits phone stories.</QuestionnaireDescription>
        <QuestionnaireChoices>
          {ASPECTS.map((a) => (
            <QuestionnaireChoice key={a.value} value={a.value} defaultChecked={a.value === start.aspect}>
              <span className="font-medium">{a.label}</span>
              <span className="text-muted-foreground">{a.value}</span>
            </QuestionnaireChoice>
          ))}
        </QuestionnaireChoices>
      </QuestionnaireItem>
      <QuestionnaireItem name="quality" required>
        <QuestionnaireTitle>What quality?</QuestionnaireTitle>
        <QuestionnaireDescription>High quality takes longer to make, and the file is larger.</QuestionnaireDescription>
        <QuestionnaireChoices>
          {QUALITIES.map((q) => (
            <QuestionnaireChoice key={q.value} value={q.value} defaultChecked={q.value === start.quality}>
              <span className="font-medium">{q.label}</span>
              <span className="text-muted-foreground">{q.detail}</span>
            </QuestionnaireChoice>
          ))}
        </QuestionnaireChoices>
      </QuestionnaireItem>
      <QuestionnaireActions>
        <QuestionnairePrevious />
        <QuestionnaireNext />
        <QuestionnaireSubmit>Export</QuestionnaireSubmit>
      </QuestionnaireActions>
    </Questionnaire>
  );
}

/** A running export, in place of the message box: its progress, and Cancel. */
export function ExportProgress({ phase, onCancel }: { phase: ExportPhase; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-4" role="status" aria-live="polite">
      {phase.kind === 'exporting' ? (
        <div className="space-y-2">
          <Progress value={Math.round(phase.progress * 100)}>
            <ProgressLabel>Exporting</ProgressLabel>
            <ProgressValue />
          </Progress>
          <p className="text-sm text-muted-foreground">Keep this tab open and visible.</p>
        </div>
      ) : (
        <Shimmer className="text-sm">Checking this browser with a short test export…</Shimmer>
      )}
      <Button variant="outline" className="self-start" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/**
 * The exported video as a file to save: the trip's name over its size and frame. The whole row is the download link,
 * so it's easy to hit on a phone; the file keeps its descriptive name (`name`).
 */
function VideoFile({ title, url, name, size, width, height }: { title: string; url: string; name: string; size: number; width: number; height: number }) {
  const mb = `${(size / 1_048_576).toFixed(1)} MB`;
  return (
    <>
      <p>Your video is ready, made on this device. Nothing was uploaded.</p>
      <Item
        variant="outline"
        size="sm"
        render={<a href={url} download={name} title={name} aria-label={`Save video: ${title}, ${mb}, ${width} by ${height}`} />}
      >
        <ItemMedia variant="icon">
          <FilePlayIcon aria-hidden="true" />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full">
            <span className="truncate">{title}</span>
          </ItemTitle>
          <ItemDescription className="text-xs">
            {mb} · {width} × {height}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <span className={buttonVariants({ variant: 'outline', size: 'icon-sm' })} aria-hidden="true">
            <DownloadIcon />
          </span>
        </ItemActions>
      </Item>
    </>
  );
}

/** How an export went, as the reply in the chat: the file to save, or what stopped it. `title`: the trip's name. */
export function ExportResult({
  phase,
  title,
  onTryAgain,
  onAgain,
}: {
  phase: ExportPhase;
  title: string;
  onTryAgain: () => void;
  onAgain: () => void;
}) {
  if (exportRunning(phase)) return <Shimmer className="text-sm">Making the video on this device…</Shimmer>;
  return (
    <>
      {phase.kind === 'unsupported' && (
        <Alert>
          <AlertTitle>Video export isn’t available on this device</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5">
              {phase.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p>Playback and sharing still work.</p>
          </AlertDescription>
        </Alert>
      )}
      {phase.kind === 'done' && (
        <VideoFile title={title} url={phase.url} name={phase.name} size={phase.size} width={phase.width} height={phase.height} />
      )}
      {phase.kind === 'cancelled' && <p className="text-muted-foreground">Export cancelled.</p>}
      {phase.kind === 'failed' && (
        <Alert variant="destructive">
          <AlertTitle>Export failed</AlertTitle>
          <AlertDescription>{phase.message}. Playback and sharing are unaffected. You can try again.</AlertDescription>
        </Alert>
      )}
      {phase.kind !== 'unsupported' && (
        <div className="flex flex-wrap gap-2">
          {(phase.kind === 'cancelled' || phase.kind === 'failed') && (
            <Button variant="outline" onClick={onTryAgain}>
              Try again
            </Button>
          )}
          <Button variant="outline" onClick={onAgain}>
            {phase.kind === 'done' ? 'Export another' : 'Change shape or quality'}
          </Button>
        </div>
      )}
    </>
  );
}

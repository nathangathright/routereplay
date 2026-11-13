/**
 * The draft's actions as chat replies: publishing (and sharing what's published), and exporting a video on this
 * device. The suggestion row above the message box starts them (ChatPanel.tsx).
 */
import { ShareIcon } from 'lucide-react';
import { useState } from 'react';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
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
import type { NormalizedSceneV1 } from '../../shared/scene/types';
import type { ExportCheck, ExportQuality } from '../export';
import { ASPECTS, QUALITIES, fileName, screenAspect } from '../exportOptions';
import { CopyButton } from './CopyPrompt';

export type PublishState =
  | { state: 'publishing' }
  /** `shared`: the link of a version published earlier, shown again. `earlier`: other versions have links too. */
  | { state: 'published' | 'shared'; url: string; earlier: boolean }
  | { state: 'failed'; message: string };

/** A reply to Publish (or Share link): the watch link, to copy or share. */
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
      <a className="break-all text-foreground underline underline-offset-4" href={reply.url} target="_blank" rel="noopener">
        {reply.url}
      </a>
      <div className="flex flex-wrap gap-2">
        <CopyButton variant="outline" getText={() => reply.url} copiedMessage="Watch link copied.">
          Copy link
        </CopyButton>
        {nav.share && (
          <Button variant="outline" onClick={() => void nav.share!({ title, url: reply.url }).catch(() => undefined)}>
            <ShareIcon aria-hidden="true" />
            Share
          </Button>
        )}
      </div>
      {reply.earlier && <p className="text-muted-foreground">Earlier links keep showing the versions they were made from.</p>}
    </>
  );
}

/** Where an export is: running (checking, then exporting), or how it ended. */
export type ExportPhase =
  | { kind: 'checking' }
  | { kind: 'exporting'; progress: number }
  | { kind: 'unsupported'; reasons: string[] }
  | { kind: 'done'; url: string; name: string; size: number }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

export const exportRunning = (p: ExportPhase) => p.kind === 'checking' || p.kind === 'exporting';

/**
 * Export a video on this device: a capability check and a short test export, then the export. Reports each phase,
 * ending with done, unsupported, cancelled or failed. Failure or lack of support never affects playback or sharing.
 */
export async function runExport(scene: NormalizedSceneV1, choice: ExportChoice, signal: AbortSignal, report: (p: ExportPhase) => void) {
  try {
    report({ kind: 'checking' });
    const mod = await import('../export');
    const check: ExportCheck = await mod.checkExportSupport(choice);
    if (!check.ok) return report({ kind: 'unsupported', reasons: check.reasons });
    if (!(await mod.probeExport(scene, check, signal))) {
      return report({ kind: 'unsupported', reasons: ['A short test export did not produce a playable video on this device.'] });
    }
    report({ kind: 'exporting', progress: 0 });
    const blob = await mod.exportVideo(scene, check, (p) => report({ kind: 'exporting', progress: p }), signal);
    report({ kind: 'done', url: URL.createObjectURL(blob), name: fileName(scene, choice.aspect, check.container), size: blob.size });
  } catch (e) {
    report(signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', message: e instanceof Error ? e.message : String(e) });
  }
}

export interface ExportChoice {
  aspect: AspectRatio;
  quality: ExportQuality;
}

export const describeExport = (c: ExportChoice) => {
  const shape = ASPECTS.find((a) => a.value === c.aspect)!;
  const quality = QUALITIES.find((q) => q.value === c.quality)!;
  return `${shape.label} ${shape.value}, ${quality.label} ${quality.detail}`;
};

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

/** How an export went, as the reply in the chat: the file to save, or what stopped it. */
export function ExportResult({ phase, onTryAgain, onAgain }: { phase: ExportPhase; onTryAgain: () => void; onAgain: () => void }) {
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
      {phase.kind === 'done' && <p>Your video is ready: {(phase.size / 1_048_576).toFixed(1)} MB, made on this device. Nothing was uploaded.</p>}
      {phase.kind === 'cancelled' && <p className="text-muted-foreground">Export cancelled.</p>}
      {phase.kind === 'failed' && (
        <Alert variant="destructive">
          <AlertTitle>Export failed</AlertTitle>
          <AlertDescription>{phase.message}. Playback and sharing are unaffected. You can try again.</AlertDescription>
        </Alert>
      )}
      {phase.kind !== 'unsupported' && (
        <div className="flex flex-wrap gap-2">
          {phase.kind === 'done' && (
            <a className={buttonVariants()} href={phase.url} download={phase.name}>
              Save video
            </a>
          )}
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

import { useEffect, useRef, useState } from 'react';
import type { AspectRatio } from '../../shared/scene/constants';
import { ASPECTS, QUALITIES, fileName, screenAspect } from '../exportOptions';
import type { NormalizedSceneV1 } from '../../shared/scene/types';
import type { ExportCheck, ExportQuality } from '../export';

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'unsupported'; reasons: string[] }
  | { kind: 'exporting'; progress: number }
  | { kind: 'done'; url: string; name: string; size: number }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

/**
 * Bottom drawer for exporting a video on this device: pick quality and shape, then export. A capability
 * check and a short test export run first; failure or lack of support never affects playback or sharing.
 */
export function ExportDrawer({ scene, open, onClose }: { scene: NormalizedSceneV1; open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [quality, setQuality] = useState<ExportQuality>('standard');
  const [aspect, setAspect] = useState<AspectRatio>(screenAspect);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const busy = phase.kind === 'checking' || phase.kind === 'exporting';

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // A finished file's object URL is released when replaced or when the drawer goes away.
  useEffect(() => () => {
    if (phase.kind === 'done') URL.revokeObjectURL(phase.url);
  }, [phase]);

  /** Changing a choice after an export offers a fresh Export button. */
  function choose(set: () => void) {
    set();
    if (!busy) setPhase({ kind: 'idle' });
  }

  async function start() {
    const controller = new AbortController();
    abort.current = controller;
    const options = { aspect, quality };
    try {
      setPhase({ kind: 'checking' });
      const mod = await import('../export');
      const check: ExportCheck = await mod.checkExportSupport(options);
      if (!check.ok) {
        setPhase({ kind: 'unsupported', reasons: check.reasons });
        return;
      }
      const probeOk = await mod.probeExport(scene, check, controller.signal);
      if (!probeOk) {
        setPhase({ kind: 'unsupported', reasons: ['A short test export did not produce a playable video on this device.'] });
        return;
      }
      setPhase({ kind: 'exporting', progress: 0 });
      const blob = await mod.exportVideo(scene, check, (p) => setPhase({ kind: 'exporting', progress: p }), controller.signal);
      setPhase({ kind: 'done', url: URL.createObjectURL(blob), name: fileName(scene, aspect, check.container), size: blob.size });
    } catch (e) {
      if (controller.signal.aborted) setPhase({ kind: 'cancelled' });
      else setPhase({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
    } finally {
      abort.current = null;
    }
  }

  return (
    <dialog
      ref={dialog}
      className="drawer"
      aria-labelledby="export-title"
      onCancel={(e) => {
        // Escape closes the drawer unless an export is running.
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        // A tap on the backdrop (the dialog element itself, outside the sheet) closes it.
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="drawer-sheet">
        <div className="drawer-head">
          <h2 id="export-title">Export video</h2>
          <button className="icon-btn small" onClick={onClose} disabled={busy} aria-label="Close">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <fieldset className="choice" disabled={busy}>
          <legend>Quality</legend>
          <div className="choice-options">
            {QUALITIES.map((q) => (
              <label key={q.value} className="choice-option">
                <input type="radio" name="quality" value={q.value} checked={quality === q.value} onChange={() => choose(() => setQuality(q.value))} />
                <span>
                  {q.label} <span className="choice-detail">{q.detail}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="choice" disabled={busy}>
          <legend>Aspect ratio</legend>
          <div className="choice-options">
            {ASPECTS.map((a) => (
              <label key={a.value} className="choice-option">
                <input type="radio" name="aspect" value={a.value} checked={aspect === a.value} onChange={() => choose(() => setAspect(a.value))} />
                <span>
                  <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                    <rect x={(18 - a.w) / 2} y={(18 - a.h) / 2} width={a.w} height={a.h} rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                  {a.label} <span className="choice-detail">{a.value}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="drawer-status" role="status" aria-live="polite">
          {phase.kind === 'checking' && <p className="note">Checking this browser and running a short test export…</p>}
          {phase.kind === 'exporting' && (
            <>
              <div className="progress" aria-label="Export progress">
                <div style={{ width: `${Math.round(phase.progress * 100)}%` }} />
              </div>
              <p className="note">{Math.round(phase.progress * 100)}% · keep this tab open and visible</p>
            </>
          )}
          {phase.kind === 'unsupported' && (
            <>
              <p className="note">Video export isn’t available on this device. Playback and sharing still work.</p>
              <ul className="note">
                {phase.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </>
          )}
          {phase.kind === 'done' && (
            <p className="note">{(phase.size / 1_048_576).toFixed(1)} MB · made on this device, nothing uploaded</p>
          )}
          {phase.kind === 'cancelled' && <p className="note">Export cancelled.</p>}
          {phase.kind === 'failed' && <p className="note">Export failed: {phase.message}. Playback and sharing are unaffected. You can try again.</p>}
        </div>

        {phase.kind === 'exporting' || phase.kind === 'checking' ? (
          <button className="drawer-action" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        ) : phase.kind === 'done' ? (
          <a className="drawer-action primary" href={phase.url} download={phase.name}>
            Save video
          </a>
        ) : (
          <button className="drawer-action primary" onClick={start}>
            Export
          </button>
        )}
      </div>
    </dialog>
  );
}

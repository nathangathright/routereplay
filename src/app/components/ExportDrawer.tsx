import { useEffect, useRef } from 'react';
import { ASPECTS, type ExportJob, QUALITIES, exportRunning } from '../exportOptions';

/**
 * Bottom drawer for exporting a video on this device: pick quality and shape, then export. A capability
 * check and a short test export run first; failure or lack of support never affects playback or sharing. The export
 * itself is the stage's job (useExportJob), so the page's browser tools can start one here too.
 */
export function ExportDrawer({ job, open, onClose }: { job: ExportJob; open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { choice, phase } = job;
  const busy = phase !== null && exportRunning(phase);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

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
                <input type="radio" name="quality" value={q.value} checked={choice.quality === q.value} onChange={() => job.choose({ quality: q.value })} />
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
                <input type="radio" name="aspect" value={a.value} checked={choice.aspect === a.value} onChange={() => job.choose({ aspect: a.value })} />
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
          {phase?.kind === 'checking' && <p className="note">Checking this browser and running a short test export…</p>}
          {phase?.kind === 'exporting' && (
            <>
              <div className="progress" aria-label="Export progress">
                <div style={{ width: `${Math.round(phase.progress * 100)}%` }} />
              </div>
              <p className="note">{Math.round(phase.progress * 100)}% · keep this tab open and visible</p>
            </>
          )}
          {phase?.kind === 'unsupported' && (
            <>
              <p className="note">Video export isn’t available on this device. Playback and sharing still work.</p>
              <ul className="note">
                {phase.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </>
          )}
          {phase?.kind === 'done' && (
            <p className="note">{(phase.size / 1_048_576).toFixed(1)} MB · made on this device, nothing uploaded</p>
          )}
          {phase?.kind === 'cancelled' && <p className="note">Export cancelled.</p>}
          {phase?.kind === 'failed' && <p className="note">Export failed: {phase.message}. Playback and sharing are unaffected. You can try again.</p>}
        </div>

        {busy ? (
          <button className="drawer-action" onClick={job.cancel}>
            Cancel
          </button>
        ) : phase?.kind === 'done' ? (
          <a className="drawer-action primary" href={phase.url} download={phase.name}>
            Save video
          </a>
        ) : (
          <button className="drawer-action primary" onClick={() => job.start()}>
            Export
          </button>
        )}
      </div>
    </dialog>
  );
}

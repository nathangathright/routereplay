import { forwardRef, useCallback, useMemo, useState, type ReactNode } from 'react';
import type { NormalizedSceneV1 } from '../../shared/scene/types';
import { buildTimeline, evaluate } from '../../shared/timeline/evaluate';
import { ExportDrawer } from './ExportDrawer';
import { JourneyPlayer, type JourneyPlayerHandle, type QualityMode, webglAvailable } from './JourneyPlayer';
import { RouteSummary } from './RouteSummary';

/**
 * Player, quality control, export, and the accessible route summary. Falls back to the
 * summary when WebGL is unavailable or the context is lost.
 */
export const JourneyView = forwardRef<JourneyPlayerHandle, { scene: NormalizedSceneV1; actions?: ReactNode; autoPlay?: boolean }>(
  function JourneyView({ scene, actions, autoPlay }, ref) {
    const [webgl] = useState(webglAvailable);
    const [qualityMode, setQualityMode] = useState<QualityMode>('auto');
    const [downgraded, setDowngraded] = useState(false);
    const [contextLost, setContextLost] = useState(false);
    const [mountKey, setMountKey] = useState(0);
    const [currentLeg, setCurrentLeg] = useState(0);
    const [exporting, setExporting] = useState(false);
    const timeline = useMemo(() => buildTimeline(scene), [scene]);

    const onFrame = useCallback(
      (frame: number) => {
        const leg = evaluate(timeline, frame / timeline.fps).legIndex;
        setCurrentLeg((prev) => (prev === leg ? prev : leg));
      },
      [timeline],
    );
    const onContextLost = useCallback(() => setContextLost(true), []);
    const onDowngrade = useCallback(() => setDowngraded(true), []);

    return (
      <>
        {webgl ? (
          <div style={{ position: 'relative' }}>
            <JourneyPlayer
              key={mountKey}
              ref={ref}
              scene={scene}
              qualityMode={qualityMode}
              onFrame={onFrame}
              onContextLost={onContextLost}
              onQualityDowngrade={onDowngrade}
              autoPlay={autoPlay}
            />
            {contextLost && (
              <div className="overlay" role="alert">
                <div>
                  <p>The 3D view stopped because the graphics device was reset. The route is listed below.</p>
                  <button
                    className="btn primary"
                    onClick={() => {
                      setContextLost(false);
                      setQualityMode('low');
                      setMountKey((k) => k + 1);
                    }}
                  >
                    Restore 3D view
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="panel" role="note">
            This browser can’t display the 3D globe (WebGL 2 is unavailable). The route is listed below.
          </div>
        )}
        <div className="toolbar">
          <div className="toolbar-group">{actions}</div>
          {webgl && (
            <div className="toolbar-group">
              <label className="note" htmlFor="quality">
                Quality
              </label>
              <select
                id="quality"
                className="select"
                value={qualityMode}
                onChange={(e) => {
                  setQualityMode(e.target.value as QualityMode);
                  setDowngraded(false);
                }}
              >
                <option value="auto">Auto</option>
                <option value="low">Low</option>
                <option value="standard">Standard</option>
              </select>
              <button className="btn small" onClick={() => setExporting(true)}>
                Export video
              </button>
              <ExportDrawer scene={scene} open={exporting} onClose={() => setExporting(false)} />
            </div>
          )}
        </div>
        {downgraded && qualityMode === 'auto' && (
          <p className="status-line">Switched to low quality for smoother playback. Timing is unchanged.</p>
        )}
        <RouteSummary scene={scene} currentLeg={currentLeg} />
      </>
    );
  },
);

import { useEffect, useState } from 'react';
import { ApiFailure, type PublicationView, getPublication } from '../api';
import { journeyTitle } from '../../shared/scene/title';
import { Icon, JourneyStage, ShareButton } from '../components/JourneyStage';

type State = { kind: 'loading' } | { kind: 'ready'; pub: PublicationView } | { kind: 'deleted' } | { kind: 'missing' } | { kind: 'error'; message: string };

export function Watch({ publicationId }: { publicationId: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    getPublication(publicationId)
      .then((r) => setState({ kind: 'ready', pub: r.body! }))
      .catch((e: unknown) => {
        if (e instanceof ApiFailure && e.info.status === 410) setState({ kind: 'deleted' });
        else if (e instanceof ApiFailure && e.info.status === 404) setState({ kind: 'missing' });
        else setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
  }, [publicationId]);

  useEffect(() => {
    if (state.kind === 'ready') document.title = `${journeyTitle(state.pub.scene)} · Route Replay`;
  }, [state]);

  if (state.kind === 'loading') {
    return (
      <div className="center-state" aria-busy="true">
        <p>Loading journey…</p>
      </div>
    );
  }
  if (state.kind !== 'ready') {
    const text =
      state.kind === 'deleted'
        ? { h: 'This journey was deleted', p: 'Its owner removed it, so it can no longer be watched.' }
        : state.kind === 'missing'
          ? { h: 'Journey not found', p: 'Check that the link was copied completely.' }
          : { h: 'Something went wrong', p: state.message };
    return (
      <div className="center-state">
        <div>
          <h1>{text.h}</h1>
          <p>{text.p}</p>
          <a className="btn" href="/">
            Make your own journey
          </a>
        </div>
      </div>
    );
  }
  const { scene, watchUrl } = state.pub;
  const title = journeyTitle(scene);
  return (
    <JourneyStage
      scene={scene}
      corner={
        <>
          <h1 className="visually-hidden">{title}</h1>
          <a className="icon-btn watch-new" href="/" aria-label="Make your own journey" title="Make your own">
            {Icon.plus}
          </a>
        </>
      }
      action={<ShareButton url={watchUrl} title={title} />}
    />
  );
}

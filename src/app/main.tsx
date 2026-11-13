import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { Studio } from './Studio';
import './index.css';

// The watch page carries Remotion; the homepage does not need it.
const Watch = lazy(() => import('./pages/Watch').then((m) => ({ default: m.Watch })));

const loading = (
  <div className="center-state" aria-busy="true">
    <p>Loading…</p>
  </div>
);

function App() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const watch = /^\/w\/([a-z0-9]{12})$/.exec(path);
  if (watch)
    return (
      <Suspense fallback={loading}>
        <Watch publicationId={watch[1]!} />
      </Suspense>
    );
  // The homepage and drafts share one workspace, so a chat can become its draft without reloading. Only / and
  // /s/<id> get here: unknown paths are answered with public/404.html (wrangler.toml not_found_handling).
  const draft = /^\/s\/([a-z0-9]{16})$/.exec(path);
  return <Studio initialSceneId={draft ? draft[1]! : null} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

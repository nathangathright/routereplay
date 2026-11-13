import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { Landing } from './pages/Landing';
import './styles.css';

// Player pages carry Remotion; the landing page does not need it.
const Preview = lazy(() => import('./pages/Preview').then((m) => ({ default: m.Preview })));
const Watch = lazy(() => import('./pages/Watch').then((m) => ({ default: m.Watch })));

const loading = (
  <div className="center-state" aria-busy="true">
    <p>Loading…</p>
  </div>
);

function App() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const draft = /^\/s\/([a-z0-9]{16})$/.exec(path);
  if (draft)
    return (
      <Suspense fallback={loading}>
        <Preview sceneId={draft[1]!} />
      </Suspense>
    );
  const watch = /^\/w\/([a-z0-9]{12})$/.exec(path);
  if (watch)
    return (
      <Suspense fallback={loading}>
        <Watch publicationId={watch[1]!} />
      </Suspense>
    );
  // Only / gets here: unknown paths are answered with public/404.html (wrangler.toml not_found_handling).
  return <Landing />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

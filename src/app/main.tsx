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

function NotFound() {
  return (
    <div className="center-state">
      <div>
        <h1>Page not found</h1>
        <p>This address doesn’t match a Route Replay page.</p>
        <a className="btn" href="/">
          Route Replay home
        </a>
      </div>
    </div>
  );
}

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
  if (path === '/') return <Landing />;
  return <NotFound />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

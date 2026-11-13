import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type ProxyOptions, defineConfig } from 'vite';

// Exports are silent, so the web renderer never loads its audio encoders; don't ship them (src/app/noAudioEncoders.ts).
const noAudioEncoders = fileURLToPath(new URL('./src/app/noAudioEncoders.ts', import.meta.url));

/**
 * During `npm run dev`, API and document routes (and the live-update WebSocket) go to `npm run dev:worker`, which
 * portless serves at https://routereplay.localhost (with a branch subdomain in a git worktree). The Worker only
 * accepts cookie-authenticated writes and sockets from its own origin, so requests arrive as if from there.
 */
function workerProxy(): Record<string, ProxyOptions> {
  const worker = execFileSync('portless', ['get', 'routereplay'], { encoding: 'utf8' }).trim();
  const route: ProxyOptions = {
    target: worker,
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on('proxyReq', (req) => req.getHeader('origin') && req.setHeader('origin', worker));
      proxy.on('proxyReqWs', (req) => req.setHeader('origin', worker));
    },
  };
  return {
    '/api': { ...route, ws: true },
    '/agent-docs': route,
    '/acknowledgments': route,
    '/llms.txt': route,
    '/schemas': route,
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@mediabunny/aac-encoder': noAudioEncoders,
      '@mediabunny/flac-encoder': noAudioEncoders,
      '@mediabunny/mp3-encoder': noAudioEncoders,
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  // portless gives Vite its port and address (https://vite.routereplay.localhost).
  server: command === 'serve' ? { proxy: workerProxy() } : undefined,
}));

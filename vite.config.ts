import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Exports are silent, so the web renderer never loads its audio encoders; don't ship them (src/app/noAudioEncoders.ts).
const noAudioEncoders = fileURLToPath(new URL('./src/app/noAudioEncoders.ts', import.meta.url));

export default defineConfig({
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
  server: {
    port: 5173,
    // During `vite` development, API/doc routes (and the live-update WebSocket) go to `wrangler dev` on 8788.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8788', ws: true },
      '/agent-docs': 'http://127.0.0.1:8788',
      '/acknowledgments': 'http://127.0.0.1:8788',
      '/llms.txt': 'http://127.0.0.1:8788',
      '/schemas': 'http://127.0.0.1:8788',
    },
  },
});

/**
 * Stands in for Remotion's optional audio encoders (@mediabunny/aac-encoder, flac-encoder, mp3-encoder).
 * Route Replay videos are silent: every export passes `muted: true`, and the web renderer only loads an
 * encoder when audio is enabled. Aliasing them here (vite.config.ts) keeps their WebAssembly builds of
 * FFmpeg's AAC encoder, LAME, and libFLAC out of the deployed files.
 */
const unavailable = (): never => {
  throw new Error('Route Replay exports silent video; audio encoders are not included.');
};

export const registerAacEncoder = unavailable;
export const registerFlacEncoder = unavailable;
export const registerMp3Encoder = unavailable;

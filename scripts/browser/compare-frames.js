/**
 * Browser check: compare decoded frames of an exported video with the live preview
 * at the same frame numbers. Run in a preview page opened with ?debug (dpr 1, readable
 * canvas), after an export finished, with WebMCP tools captured in window.__tools.
 *
 * Usage (devtools/evaluate): await compareFrames([0, 120, 300])
 * Returns per-frame mean absolute difference (0–255) and PSNR (dB).
 */
async function compareFrames(frames) {
  const link = document.querySelector('a[download]');
  if (!link) throw new Error('Export a video first.');
  const video = document.createElement('video');
  video.muted = true;
  video.src = link.href;
  await new Promise((r, j) => { video.onloadeddata = r; video.onerror = j; });
  const W = video.videoWidth, H = video.videoHeight;
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c.getContext('2d', { willReadFrequently: true }); };
  const a = mk(), b = mk();
  const results = [];
  for (const f of frames) {
    video.currentTime = (f + 0.5) / 30;
    await new Promise((r) => { video.onseeked = r; });
    a.drawImage(video, 0, 0, W, H);
    await window.__tools.seek_scene.execute({ seconds: f / 30 });
    await new Promise((r) => setTimeout(r, 700));
    const canvas = document.querySelector('.player-shell canvas');
    b.drawImage(canvas, 0, 0, W, H);
    const da = a.getImageData(0, 0, W, H).data, db = b.getImageData(0, 0, W, H).data;
    let sum = 0, sq = 0, n = 0;
    for (let i = 0; i < da.length; i += 4) for (let k = 0; k < 3; k++) { const d = da[i + k] - db[i + k]; sum += Math.abs(d); sq += d * d; n++; }
    const mse = sq / n;
    results.push({ frame: f, meanAbsDiff: +(sum / n).toFixed(2), psnr: +(10 * Math.log10(255 * 255 / Math.max(mse, 1e-9))).toFixed(1) });
  }
  return results;
}

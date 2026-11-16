#!/usr/bin/env node
/**
 * Hardware tiers draw the same moment (docs/decisions.md, "Hardware tiers"). Against a local server, this creates and
 * publishes three test journeys, captures the paused watch page (?debug: one pixel per pixel, readable canvas) at
 * 2–9 s for each tier and sample count, and checks:
 *
 * - Same moment across tiers: each tier against laptop at the same samples, both downsampled to 1/8, must stay at or
 *   above 30 dB PSNR with mean luminance within ±3 %. A different moment moves the camera and fails it.
 * - With --export: each export against the preview at the same tier and samples, decoded, at or above 41 dB (the
 *   milestone-one check, H.264's loss). Phones export at laptop settings, so only laptop and desktop are exported.
 *
 *   node --use-system-ca scripts/browser/tier-compare.mjs --base https://<branch>.routereplay.localhost \
 *     [--tiers phone,laptop,desktop] [--samples 1,8] [--export] [--out dir] [--journeys lowsun,noon,globe,airport,night]
 *
 * It creates drafts and publications, so run it against a local server, not production. Needs Chrome; the GPU flags
 * keep it off the software renderer, which would be phone tier.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base');
if (!base) throw new Error('--base is required');
const tiers = arg('tiers', 'phone,laptop,desktop').split(',');
const samplesList = arg('samples', '1').split(',').map(Number);
const out = arg('out', path.join(process.cwd(), '.cache', 'tier-compare'));
const exporting = process.argv.includes('--export');
const executablePath = arg('executable', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
fs.mkdirSync(out, { recursive: true });

/** The journeys the budgets in docs/budgets.md were measured with. */
const JOURNEYS = {
  lowsun: { title: 'London–Frankfurt, low Sun over broken cloud', legs: [{ id: 'lhr-fra', from: 'LHR', to: 'FRA', departure: '2026-11-10T14:40:00+00:00', arrival: '2026-11-10T16:50:00+01:00', aircraft: 'A320' }] },
  noon: { title: 'Singapore–Hong Kong, midday over cloud', legs: [{ id: 'sin-hkg', from: 'SIN', to: 'HKG', departure: '2026-11-05T11:00:00+08:00', arrival: '2026-11-05T14:50:00+08:00', aircraft: 'A359' }] },
  globe: { title: 'London–Johannesburg, the whole globe', legs: [{ id: 'lhr-jnb', from: 'LHR', to: 'JNB', departure: '2026-11-05T06:00:00+00:00', arrival: '2026-11-05T19:00:00+02:00', aircraft: 'B77W' }] },
  // Extras, by name only: labels beside the aircraft at the closest framing, and city lights at night.
  airport: { title: 'London–Amsterdam, the airport close-up', legs: [{ id: 'lhr-ams', from: 'LHR', to: 'AMS', departure: '2026-11-05T10:00:00+00:00', arrival: '2026-11-05T12:20:00+01:00', aircraft: 'A320' }] },
  night: { title: 'New York–Boston, city lights', legs: [{ id: 'jfk-bos', from: 'JFK', to: 'BOS', departure: '2026-11-05T20:00:00-05:00', arrival: '2026-11-05T21:15:00-05:00', aircraft: 'A320' }] },
};
const names = arg('journeys', 'lowsun,noon,globe').split(',');
const SECONDS = [2, 3, 4, 5, 6, 7, 8, 9];
const FPS = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, p, { token, body } = {}) {
  const headers = { 'user-agent': 'routereplay-tier-compare/1.0' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function publish(name) {
  const j = JOURNEYS[name];
  const c = await call('POST', '/api/v1/scenes', { body: { schemaVersion: 1, title: j.title, environment: { weather: 'clouds' }, legs: j.legs } });
  if (c.status !== 201) throw new Error(`${name}: create ${c.status} ${JSON.stringify(c.json).slice(0, 300)}`);
  const p = await call('POST', `/api/v1/scenes/${c.json.id}/publications`, { token: c.json.credentials.owner, body: { revision: 1 } });
  if (p.status !== 201) throw new Error(`${name}: publish ${p.status} ${JSON.stringify(p.json).slice(0, 300)}`);
  return { draft: c.json.id, owner: c.json.credentials.owner, watch: p.json.id };
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  acceptInsecureCerts: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1280,800'],
});

async function open(url) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  // The page's own browser tools, without a WebMCP browser: control_playback seeks, export_video exports.
  await page.evaluateOnNewDocument(() => {
    window.__tools = {};
    document.modelContext = { registerTool: (t) => void (window.__tools[t.name] = t), unregisterTool: (n) => void delete window.__tools[n] };
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
  await page.waitForFunction(() => window.__tools?.control_playback && document.querySelector('canvas'), { timeout: 60000 });
  await sleep(2000);
  return { page, errors };
}

async function capture(page, seconds) {
  await page.evaluate((s) => window.__tools.control_playback.execute({ seconds: s, playing: false }), seconds);
  await sleep(800);
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 60000 }).catch(() => {});
  await sleep(1200);
  return page.evaluate(() => {
    const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return c.toDataURL('image/png');
  });
}

/** Image statistics, worked out in a blank page so the script needs no image library. */
const lab = await browser.newPage();
await lab.setContent('<!doctype html><title>lab</title>');
async function compare(a, b) {
  return lab.evaluate(async (a, b) => {
    const load = (src) => new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = src; });
    const pixels = async (src) => {
      const img = src.startsWith('data:') ? await load(src) : src;
      const c = document.createElement('canvas');
      c.width = img.width ?? img.videoWidth;
      c.height = img.height ?? img.videoHeight;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      return { w: c.width, h: c.height, d: g.getImageData(0, 0, c.width, c.height).data };
    };
    const [A, B] = [await pixels(a), await pixels(b)];
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const psnr = (sq, n) => +(10 * Math.log10((255 * 255) / Math.max(sq / n, 1e-9))).toFixed(1);
    let sq = 0, abs = 0, n = 0, ya = 0, yb = 0;
    for (let i = 0; i < A.d.length; i += 4) {
      for (let k = 0; k < 3; k++) { const d = A.d[i + k] - B.d[i + k]; sq += d * d; abs += Math.abs(d); n++; }
      ya += 0.2126 * lin(A.d[i]) + 0.7152 * lin(A.d[i + 1]) + 0.0722 * lin(A.d[i + 2]);
      yb += 0.2126 * lin(B.d[i]) + 0.7152 * lin(B.d[i + 1]) + 0.0722 * lin(B.d[i + 2]);
    }
    // Downsampled to 1/8 by averaging 8 × 8 blocks.
    const S = 8, W = Math.floor(A.w / S), H = Math.floor(A.h / S);
    let sq8 = 0, n8 = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 3; k++) {
      let sa = 0, sb = 0;
      for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) { const i = ((y * S + dy) * A.w + x * S + dx) * 4 + k; sa += A.d[i]; sb += B.d[i]; }
      const d = (sa - sb) / (S * S); sq8 += d * d; n8++;
    }
    const pixelsN = n / 3;
    return { psnr: psnr(sq, n), meanAbsDiff: +(abs / n).toFixed(2), psnr8: psnr(sq8, n8), luminance: +(ya / pixelsN).toFixed(4), luminanceRatio: +((ya / Math.max(yb, 1e-9))).toFixed(4) };
  }, a, b);
}

const report = { base, tiers, samples: samplesList, journeys: {}, failures: [] };
try {
  for (const name of names) {
    const ids = await publish(name);
    const shots = {}; // `${tier}@${samples}` → data URLs by second
    const entry = (report.journeys[name] = { watch: ids.watch, preview: {}, acrossTiers: {}, exports: {} });
    for (const samples of samplesList) {
      for (const tier of tiers) {
        const key = `${tier}@${samples}`;
        const { page, errors } = await open(`${base}/w/${ids.watch}?debug&tier=${tier}&samples=${samples}`);
        shots[key] = {};
        for (const s of SECONDS) {
          shots[key][s] = await capture(page, s);
          fs.writeFileSync(path.join(out, `${name}-${tier}-${samples}-${s}s.png`), Buffer.from(shots[key][s].split(',')[1], 'base64'));
        }
        entry.preview[key] = { errors: errors.slice(0, 3) };
        if (exporting && tier !== 'phone') {
          // The page's own export, at this tier and sample count (pinned by ?debug and ?samples).
          const t0 = Date.now();
          await page.evaluate(() => window.__tools.export_video.execute({ aspect: '16:9', quality: 'standard' }));
          await page.waitForSelector('a[download]', { timeout: 600000 });
          const seconds = (Date.now() - t0) / 1000;
          const state = await page.evaluate(async () => (await window.__tools.get_scene.execute({})).page?.export ?? null);
          const video = await page.evaluate(() => document.querySelector('a[download]').href);
          // Decode in the page that made it (the blob URL belongs to it), one frame at a time.
          const frames = [];
          for (const s of SECONDS) {
            const data = await page.evaluate(async (src, f) => {
              const v = document.createElement('video');
              v.muted = true;
              v.src = src;
              await new Promise((r, j) => { v.onloadeddata = r; v.onerror = j; });
              v.currentTime = (f + 0.5) / 30;
              await new Promise((r) => { v.onseeked = r; });
              const c = document.createElement('canvas');
              c.width = v.videoWidth;
              c.height = v.videoHeight;
              c.getContext('2d').drawImage(v, 0, 0);
              return c.toDataURL('image/png');
            }, video, s * FPS);
            fs.writeFileSync(path.join(out, `${name}-${tier}-${samples}-${s}s-export.png`), Buffer.from(data.split(',')[1], 'base64'));
            const r = await compare(data, shots[key][s]);
            frames.push({ s, psnr: r.psnr, meanAbsDiff: r.meanAbsDiff });
            if (r.psnr < 41) report.failures.push(`${name} ${key} export ${s}s: ${r.psnr} dB`);
          }
          entry.exports[key] = { seconds, state, frames };
        }
        await page.close();
      }
      for (const tier of tiers) {
        if (tier === 'laptop') continue;
        const rows = [];
        for (const s of SECONDS) {
          const r = await compare(shots[`${tier}@${samples}`][s], shots[`laptop@${samples}`][s]);
          rows.push({ s, ...r });
          if (r.psnr8 < 30) report.failures.push(`${name} ${tier}@${samples} vs laptop ${s}s: ${r.psnr8} dB at 1/8`);
          if (Math.abs(r.luminanceRatio - 1) > 0.03) report.failures.push(`${name} ${tier}@${samples} vs laptop ${s}s: luminance ×${r.luminanceRatio}`);
        }
        entry.acrossTiers[`${tier}@${samples}`] = rows;
      }
    }
    // Samples against one sample, at each tier: what jittered samples change.
    if (samplesList.length > 1 && samplesList.includes(1)) {
      entry.samplesVsOne = {};
      for (const tier of tiers) {
        for (const samples of samplesList.filter((n) => n > 1)) {
          const rows = [];
          for (const s of SECONDS) rows.push({ s, ...(await compare(shots[`${tier}@${samples}`][s], shots[`${tier}@1`][s])) });
          entry.samplesVsOne[`${tier}@${samples}`] = rows;
        }
      }
    }
    // Delete the journey and its publication.
    await call('DELETE', `/api/v1/scenes/${ids.draft}`, { token: ids.owner }).catch(() => {});
  }
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
const summary = Object.fromEntries(
  Object.entries(report.journeys).map(([name, j]) => [
    name,
    {
      acrossTiers: Object.fromEntries(Object.entries(j.acrossTiers).map(([k, rows]) => [k, { psnr8Min: Math.min(...rows.map((r) => r.psnr8)), luminance: [Math.min(...rows.map((r) => r.luminanceRatio)), Math.max(...rows.map((r) => r.luminanceRatio))] }])),
      exports: Object.fromEntries(Object.entries(j.exports).map(([k, e]) => [k, { seconds: e.seconds, samples: e.state?.samples, msPerFrame: e.state?.msPerFrame, psnrMin: Math.min(...e.frames.map((f) => f.psnr)) }])),
      samplesVsOne: j.samplesVsOne && Object.fromEntries(Object.entries(j.samplesVsOne).map(([k, rows]) => [k, { psnrMin: Math.min(...rows.map((r) => r.psnr)), psnrMax: Math.max(...rows.map((r) => r.psnr)) }])),
    },
  ]),
);
console.log(JSON.stringify({ out, summary, failures: report.failures }, null, 1));
process.exitCode = report.failures.length ? 1 : 0;

#!/usr/bin/env node
/**
 * Real-browser playback and export check against a watch URL.
 *
 *   node scripts/browser/export-check.mjs --browser firefox --url https://routereplay-web.pages.dev/w/<id>
 *   node scripts/browser/export-check.mjs --browser chrome  --url ...
 *
 * Opens the page, confirms WebGL playback advances, runs the Export flow (capability check,
 * probe, full export), and reports the container, size, decoded dimensions, and duration.
 */
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const browserName = arg('browser', 'chrome');
const url = arg('url');
if (!url) throw new Error('--url is required');
const executablePath =
  arg('executable') ??
  (browserName === 'firefox'
    ? '/Applications/Firefox.app/Contents/MacOS/firefox'
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

const browser = await puppeteer.launch({
  browser: browserName === 'firefox' ? 'firefox' : 'chrome',
  executablePath,
  headless: true,
  args: browserName === 'firefox' ? [] : ['--window-size=1280,900'],
  defaultViewport: { width: 1280, height: 900 },
});
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  const version = await browser.version();
  const result = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100 && !document.querySelector('.player-shell canvas'); i++) await sleep(200);
    const shell = document.querySelector('.player-shell');
    if (!shell) return { error: 'no player', text: document.body.innerText.slice(0, 300) };
    const webgl2 = !!document.createElement('canvas').getContext('webgl2');
    const label = () => {
      shell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 600, clientY: 400 }));
      return shell.innerText.match(/\d:\d\d \/ \d:\d\d/)?.[0] ?? null;
    };
    const before = label();
    shell.querySelector('button')?.click();
    await sleep(3000);
    const after = label();
    shell.querySelector('button')?.click();
    const t0 = performance.now();
    [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Export video'))?.click();
    let panel = '';
    for (let i = 0; i < 240; i++) {
      await sleep(1000);
      panel = [...document.querySelectorAll('.panel')].find((p) => p.textContent.includes('Export video'))?.innerText.replace(/\s+/g, ' ') ?? '';
      if (/Save |isn’t available|failed|cancelled/.test(panel)) break;
    }
    const link = document.querySelector('a[download]');
    let decoded = null;
    if (link) {
      const v = document.createElement('video');
      v.muted = true;
      v.src = link.href;
      decoded = await new Promise((r) => {
        v.onloadedmetadata = () => r({ width: v.videoWidth, height: v.videoHeight, duration: +v.duration.toFixed(2) });
        v.onerror = () => r({ error: 'decode failed' });
        setTimeout(() => r({ error: 'decode timeout' }), 15000);
      });
    }
    return {
      webgl2,
      playback: { before, after },
      exportSeconds: Math.round((performance.now() - t0) / 1000),
      panel,
      file: link?.getAttribute('download') ?? null,
      decoded,
    };
  });
  console.log(JSON.stringify({ browser: version, url, ...result, consoleErrors: consoleErrors.slice(0, 5) }, null, 2));
} finally {
  await browser.close();
}

#!/usr/bin/env node
/**
 * Capture the link-preview images (Open Graph / Twitter cards) from the homepage globe.
 *
 *   node scripts/browser/share-cards.mjs [--origin https://routereplay.video] [--out public/share]
 *
 * Writes 1200×630 JPEGs: home.jpg (tagline over the globe) and journey.jpg (the globe alone, used
 * for every watch page so it doesn't compete with the journey's title in the preview). The globe
 * is lit for the moment of capture. Chat apps cache images by URL, so rename the files (and the
 * references in index.html and src/server/share.ts) when replacing them.
 */
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const origin = arg('origin', 'https://routereplay.video');
const out = arg('out', 'public/share');
const executablePath = arg('executable', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const W = 1200;
const H = 630;

// Hidden before first paint: the globe draws the prompt button itself (SunlitButton) and keeps the
// last place it measured, so hiding the button after load leaves an empty pill on the Earth.
const cards = [
  { file: 'home.jpg', css: '.hero p, .hero-actions, .acknowledgments-link { display: none !important; }' },
  { file: 'journey.jpg', css: '.landing-content, .acknowledgments-link { display: none !important; }' },
];

await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: [`--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 2 },
});
try {
  for (const card of cards) {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument((css) => {
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
      });
    }, card.css);
    await page.goto(`${origin}/`, { waitUntil: 'networkidle0', timeout: 60_000 });
    // Let the standard textures and clouds replace the first low-quality frame.
    await new Promise((r) => setTimeout(r, 8000));
    // Rendered at 2× and scaled down, for clean edges at 1200×630.
    await page.screenshot({
      path: `${out}/${card.file}`,
      type: 'jpeg',
      quality: 82,
      clip: { x: 0, y: 0, width: W, height: H, scale: 0.5 },
    });
    console.log(`${out}/${card.file}`);
    await page.close();
  }
} finally {
  await browser.close();
}

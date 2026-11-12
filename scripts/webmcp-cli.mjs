#!/usr/bin/env node
/**
 * Drive Route Replay's WebMCP tools through Chrome's native WebMCP implementation
 * (Chrome 151+ with --enable-features=WebMCP) via Puppeteer's WebMCP API, the way an
 * agent connected to the browser discovers and calls page tools.
 *
 *   node scripts/webmcp-cli.mjs launch <preview-url>   # starts headless Chrome on :9333
 *   node scripts/webmcp-cli.mjs tools                  # list tools on the Route Replay tab
 *   node scripts/webmcp-cli.mjs call <tool> '<json>'   # execute a tool and print its result
 *   node scripts/webmcp-cli.mjs shot <file.png>        # screenshot the tab
 *   node scripts/webmcp-cli.mjs close
 *
 * CHROME_PATH overrides the Chrome executable (default: macOS Google Chrome).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const PORT = 9333;
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [cmd, ...args] = process.argv.slice(2);

async function connect() {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find((p) => /\/(s|w)\//.test(p.url())) ?? pages[0];
  return { browser, page };
}

async function waitForTools(page, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const tools = page.webmcp?.tools() ?? [];
    if (tools.length) return tools;
    await new Promise((r) => setTimeout(r, 250));
  }
  return page.webmcp?.tools() ?? [];
}

if (cmd === 'launch') {
  const url = args[0];
  if (!url) throw new Error('launch <url>');
  const profile = mkdtempSync(path.join(tmpdir(), 'rr-webmcp-'));
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--enable-features=WebMCP',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
      url,
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const { browser, page } = await connect();
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 30000 }).catch(() => undefined);
  const native = await page.evaluate(() => typeof document.modelContext?.registerTool === 'function');
  console.log(JSON.stringify({ launched: true, pid: child.pid, url: page.url(), nativeWebMCP: native }, null, 2));
  await browser.disconnect();
} else if (cmd === 'tools') {
  const { browser, page } = await connect();
  const tools = await waitForTools(page);
  console.log(
    JSON.stringify(
      tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
      null,
      2,
    ),
  );
  await browser.disconnect();
} else if (cmd === 'call') {
  const [name, json = '{}'] = args;
  const { browser, page } = await connect();
  const tools = await waitForTools(page);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`No tool named ${name}. Available: ${tools.map((t) => t.name).join(', ')}`);
  const result = await tool.execute(JSON.parse(json));
  let output = result.output;
  try {
    output = typeof output === 'string' ? JSON.parse(output) : output;
  } catch {}
  console.log(JSON.stringify({ status: result.status, errorText: result.errorText, output }, null, 2));
  await browser.disconnect();
} else if (cmd === 'shot') {
  const { browser, page } = await connect();
  await page.screenshot({ path: args[0] ?? 'webmcp.png' });
  console.log(`saved ${args[0] ?? 'webmcp.png'}`);
  await browser.disconnect();
} else if (cmd === 'close') {
  const { browser } = await connect();
  await browser.close();
  console.log('closed');
} else {
  console.error('Usage: launch <url> | tools | call <tool> <json> | shot <file> | close');
  process.exit(2);
}

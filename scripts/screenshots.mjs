#!/usr/bin/env node
/**
 * Regenerate the user-guide screenshots:  npm run docs:shots
 *
 * Serves the production build (dist/, built first when missing), drives the
 * app through its states in headless Chromium and writes PNGs to docs/images.
 * Deterministic enough for documentation: fixed viewport, fixed waits, the
 * default patch, and the recorder/export paths exercised for real.
 *
 * Plain JavaScript so it runs without the TypeScript loader.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launchChromium } from './lib/launchBrowser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'docs', 'images');
const VIEWPORT = { width: 1500, height: 950 };
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log('no build found: running npm run build');
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
fs.mkdirSync(OUT, { recursive: true });

const server = await new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const p = path.join(DIST, url === '/' ? 'index.html' : url);
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const url = `http://localhost:${server.address().port}/`;

const { browser, label } = await launchChromium(chromium, { args: ['--autoplay-policy=no-user-gesture-required'] });
console.log(`using ${label}`);
const written = [];

/** Screenshot helper: whole page, a clip, or an element (with padding). */
async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${name}.png`);
  if (opts.selector) {
    const box = await page.locator(opts.selector).first().boundingBox();
    const pad = opts.pad ?? 8;
    await page.screenshot({
      path: file,
      clip: {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: Math.min(VIEWPORT.width - Math.max(0, box.x - pad), box.width + 2 * pad),
        height: Math.min(VIEWPORT.height - Math.max(0, box.y - pad), box.height + 2 * pad),
      },
    });
  } else if (opts.clip) {
    await page.screenshot({ path: file, clip: opts.clip });
  } else {
    await page.screenshot({ path: file });
  }
  written.push(path.relative(ROOT, file));
}

const HEADER = { x: 0, y: 0, width: VIEWPORT.width, height: 66 };
const HEADER_RIGHT = { x: 560, y: 0, width: 940, height: 66 };
const panel = (heading) => `xpath=//*[self::h3 or self::span][contains(normalize-space(.), "${heading}")]/ancestor::div[contains(@class, "rounded-xl")][1]`;
const moduleCard = (title) => `xpath=//*[contains(normalize-space(.), "${title}") and contains(@class, "font-bold")]/ancestor::div[contains(@class, "absolute")][1]`;

try {
  const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(url);
  await page.waitForFunction(() => typeof window.tropicflowEngine !== 'undefined');
  await page.waitForTimeout(500);

  // 1. Overview, idle.
  await shot(page, 'app-overview');
  await shot(page, 'header-idle', { clip: HEADER });
  await shot(page, 'modular-canvas', { selector: '.tropical-grid', pad: 0 });
  await shot(page, 'module-clock', { selector: moduleCard('TROPIC CLOCK') });
  await shot(page, 'module-delay', { selector: moduleCard('TROPICAL TAPE DELAY') });

  // 2. Playing: sequencer, keyboard, visualizer come alive; chamber with balls.
  await page.click('text=START GROOVE');
  await page.waitForTimeout(1200);
  await shot(page, 'sequencer', { selector: panel('16-STEP TROPICAL GROOVE MATRIX') });
  await shot(page, 'keyboard', { selector: panel('TROPICAL SOUNDBOARD') });
  await shot(page, 'visualizer', { selector: panel('JUNGLE ANALYZER') });
  await page.click('[data-testid="chamber-drop"]');
  await page.waitForTimeout(250);
  await page.click('[data-testid="chamber-drop"]');
  await page.waitForTimeout(350);
  await shot(page, 'gravity-chamber', { selector: moduleCard('GRAVITY CHAMBER') });
  await page.click('[data-testid="chamber-mapping-toggle"]');
  await page.waitForTimeout(200);
  await shot(page, 'chamber-mapping', { selector: moduleCard('GRAVITY CHAMBER') });
  await page.click('[data-testid="chamber-mapping-toggle"]');
  await page.click('[data-testid="chamber-clear"]');
  await shot(page, 'app-playing');

  // 3. Recording.
  await page.click('text=STOP ENGINE');
  await page.waitForTimeout(300);
  await page.fill('[data-testid="rec-max"]', '2');
  await page.check('[data-testid="rec-arm"]');
  await shot(page, 'header-armed', { clip: HEADER_RIGHT });
  await page.click('text=START GROOVE');
  await page.waitForFunction(() => window.tropicflowEngine.recorder.getElapsedSeconds() > 3.2);
  await shot(page, 'header-recording', { clip: HEADER_RIGHT });
  await page.click('text=STOP ENGINE');
  await page.waitForFunction(() => window.tropicflowEngine.getLastTake() !== null && !window.tropicflowEngine.recorder.isRecording());
  await page.waitForTimeout(200);
  await shot(page, 'header-take', { clip: HEADER_RIGHT });

  // 4. Export dialog: WAV, OGG with a range, progress (realtime fallback so it is visible).
  const modalClip = async () => {
    const box = await page.locator('[role="dialog"]').boundingBox();
    return { x: box.x - 16, y: box.y - 16, width: box.width + 32, height: box.height + 32 };
  };
  await page.click('[data-testid="export-open"]');
  await page.waitForSelector('[data-testid="export-modal"]');
  await shot(page, 'export-wav', { clip: await modalClip() });
  await page.click('[data-testid="format-ogg"]');
  await page.fill('[data-testid="export-start"]', '0.5');
  await page.fill('[data-testid="export-duration"]', '2');
  await shot(page, 'export-ogg', { clip: await modalClip() });
  await page.click('[data-testid="export-cancel"]');
  await page.waitForSelector('[data-testid="export-modal"]', { state: 'detached' });

  await page.evaluate(() => {
    window.__AE = window.AudioEncoder;
    window.AudioEncoder = undefined;
  });
  await page.click('[data-testid="export-open"]');
  await page.waitForSelector('[data-testid="export-modal"]');
  await page.click('[data-testid="format-ogg"]');
  const running = page.click('[data-testid="export-run"]');
  await page.waitForSelector('[data-testid="export-progress"]');
  await page.waitForTimeout(1500);
  await shot(page, 'export-progress', { clip: await modalClip() });
  await Promise.all([page.waitForEvent('download', { timeout: 60000 }), running]);
  await page.waitForSelector('[data-testid="export-modal"]', { state: 'detached' });
  await page.evaluate(() => {
    window.AudioEncoder = window.__AE;
  });

  // 5. Bounce.
  await page.click('[data-testid="bounce"]');
  await page.waitForSelector('[data-testid="export-modal"]');
  await shot(page, 'bounce-dialog', { clip: await modalClip() });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="export-run"]')]);
  await dl.path();
  await page.waitForSelector('[data-testid="export-modal"]', { state: 'detached' });
  await shot(page, 'header-bounce', { clip: HEADER_RIGHT });
  await context.close();

  // 6. Insecure context (no AudioWorklet): REC disabled with a reason.
  const ctx2 = await browser.newContext({ viewport: VIEWPORT });
  const p2 = await ctx2.newPage();
  await p2.addInitScript(() => {
    Object.defineProperty(BaseAudioContext.prototype, 'audioWorklet', { configurable: true, get: () => undefined });
    window.AudioWorkletNode = undefined;
    Object.defineProperty(window, 'isSecureContext', { configurable: true, get: () => false });
  });
  await p2.goto(url);
  await p2.waitForFunction(() => typeof window.tropicflowEngine !== 'undefined');
  await shot(p2, 'header-insecure', { clip: HEADER_RIGHT });
  await ctx2.close();
} finally {
  await browser.close();
  server.close();
}

console.log(`wrote ${written.length} screenshots to ${path.relative(ROOT, OUT)}/:`);
for (const f of written) console.log(`  ${f}`);

/**
 * Drives a headless Chromium (via Playwright) to render TROPICFLOW configs
 * with the browser's own OfflineAudioContext - the most faithful "what the
 * user would hear" path available outside a real listening test.
 */
import { build } from 'vite';
import { chromium, type Browser, type Page } from 'playwright';
import { launchChromium } from './launchBrowser.mjs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RenderConfig, ScoreEvent } from '../../src/core/render/RenderConfig.ts';
import type { WavBitDepth } from '../../src/core/render/WavCodec.ts';
/// <reference path=\"../../src/types/window.d.ts\" />

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE_DIR = path.join(ROOT, '.tropicflow-cache');
const HARNESS_ENTRY = path.join(ROOT, 'src/harness/render-harness.ts');
const HARNESS_OUT = path.join(CACHE_DIR, 'render-harness.js');

export interface BrowserRenderResult {
  wav: Buffer;
  /** Pre-compressor tap (see RenderResult.tapChannels). */
  tapWav: Buffer;
  score: ScoreEvent[];
  sampleRate: number;
  frames: number;
  patternEnd: number;
  busLatency: number;
  /** Ogg Opus of the master output when `oggKbps` was given. */
  ogg?: Buffer;
  oggEngine?: string;
}

export interface HarnessCapabilities {
  secureContext: boolean;
  audioWorklet: boolean;
  opusEngine: 'webcodecs' | 'mediarecorder' | null;
}

/** Bundle the harness (cached until any source file is newer than the bundle). */
export async function buildHarness(): Promise<string> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (fs.existsSync(HARNESS_OUT)) {
    const bundleTime = fs.statSync(HARNESS_OUT).mtimeMs;
    if (newestMtime(path.join(ROOT, 'src')) <= bundleTime) return HARNESS_OUT;
  }
  // Bundle with Vite (already a dependency of the app) - no extra bundler needed.
  await build({
    configFile: false,
    root: ROOT,
    logLevel: 'silent',
    build: {
      lib: { entry: HARNESS_ENTRY, name: 'TropicflowHarness', formats: ['iife'], fileName: () => path.basename(HARNESS_OUT) },
      outDir: CACHE_DIR,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      target: 'es2022',
    },
  });
  return HARNESS_OUT;
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    const t = entry.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs;
    if (t > newest) newest = t;
  }
  return newest;
}

/**
 * The harness page is served from http://localhost so it is a *secure
 * context*: WebCodecs (Opus export) and AudioWorklet are hidden on about:blank.
 */
function serveBlankPage(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

export class BrowserRenderer {
  private readonly browser: Browser;
  private readonly page: Page;
  private readonly server: http.Server;

  private constructor(browser: Browser, page: Page, server: http.Server) {
    this.browser = browser;
    this.page = page;
    this.server = server;
  }

  public static async create(): Promise<BrowserRenderer> {
    const bundlePath = await buildHarness();
    const { browser, label } = await launchChromium(chromium);
    if (process.env.TROPICFLOW_VERBOSE) console.log(`[harness] using ${label}`);
    const server = await serveBlankPage();
    const port = (server.address() as { port: number }).port;
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.error('[harness pageerror]', err.message));
    await page.goto(`http://localhost:${port}/`);
    await page.addScriptTag({ content: fs.readFileSync(bundlePath, 'utf8') });
    await page.waitForFunction(() => typeof window.tropicflow !== 'undefined');
    return new BrowserRenderer(browser, page, server);
  }

  public async capabilities(): Promise<HarnessCapabilities> {
    return this.page.evaluate(() => window.tropicflow.capabilities());
  }

  public async presets(): Promise<string[]> {
    return this.page.evaluate(() => window.tropicflow.presets);
  }

  public async presetConfig(name: string): Promise<RenderConfig> {
    return this.page.evaluate((n) => window.tropicflow.presetConfig(n), name);
  }

  public async render(config: RenderConfig, bitDepth: WavBitDepth = 32, oggKbps?: number): Promise<BrowserRenderResult> {
    const result = await this.page.evaluate(
      ([cfg, depth, kbps]) => window.tropicflow.render(cfg as RenderConfig, depth as WavBitDepth, kbps as number | undefined),
      [config, bitDepth, oggKbps] as const
    );
    return {
      wav: Buffer.from(result.wavBase64, 'base64'),
      tapWav: Buffer.from(result.tapWavBase64, 'base64'),
      score: result.score,
      sampleRate: result.sampleRate,
      frames: result.frames,
      patternEnd: result.patternEnd,
      busLatency: result.busLatency,
      ogg: result.oggBase64 ? Buffer.from(result.oggBase64, 'base64') : undefined,
      oggEngine: result.oggEngine,
    };
  }

  public async close(): Promise<void> {
    await this.browser.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

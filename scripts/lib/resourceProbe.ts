/**
 * Resource probe for the built app in headless Chromium.
 *
 * One snapshot combines three layers:
 *   - Browser: Chrome DevTools Protocol `Performance.getMetrics` after a
 *     forced GC - `AudioHandlers` is Blink's own count of live Web Audio
 *     nodes, plus heap, DOM nodes, listeners and cumulative main-thread time.
 *   - Processes: browser-level `SystemInfo.getProcessInfo` - CPU time of the
 *     renderer(s), the GPU process and the audio service.
 *   - App: what the rack says it holds (`tropicflowEngine.rack.inspect()`),
 *     which JS chunks were fetched (lazy loading), and the sequencer's
 *     scheduling margins (did the main thread keep up?).
 *
 * Counters are deterministic and can be asserted; CPU numbers in headless
 * CI are noisy and should only be reported. Used by tests/e2e/profile.test.ts
 * and scripts/profile-modules.ts.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import type { RackInspection } from '../../src/core/modules/ModuleContract.ts';
/// <reference path=\"../../src/types/window.d.ts\" />

export interface ProcessCpu {
  renderer: number;
  gpu: number;
  audioService: number;
  browser: number;
}

export interface ResourceSnapshot {
  label: string;
  /** Wall clock, ms (performance.now() of this process). */
  at: number;
  /** Blink's count of live Web Audio handlers (nodes) in the page. */
  audioHandlers: number;
  audioWorkletProcessors: number;
  jsHeapUsed: number;
  jsHeapTotal: number;
  domNodes: number;
  jsEventListeners: number;
  arrayBufferContents: number;
  /** Cumulative seconds spent in main-thread tasks / scripts since the page loaded. */
  taskDuration: number;
  scriptDuration: number;
  /** Cumulative CPU seconds per process kind. */
  cpu: ProcessCpu;
  /** JS chunks fetched so far (name -> transfer size). */
  chunks: Record<string, number>;
  /** Per-module accounting from the rack (null before the rack exists). */
  rack: RackInspection | null;
}

/** What happened between two snapshots. */
export interface ResourceWindow {
  from: string;
  to: string;
  wallSeconds: number;
  /** Fraction of wall time the main thread was busy (0..1). */
  mainThreadBusy: number;
  scriptBusy: number;
  /** CPU seconds per wall second, per process kind. */
  rendererCpu: number;
  gpuCpu: number;
  audioServiceCpu: number;
  heapDelta: number;
  audioHandlersDelta: number;
  /** Sequencer steps scheduled in the window and the tightest lookahead margin (s). */
  stepsScheduled: number;
  minStepMargin: number | null;
  /** Notes the engine played in the window (every module, every source). */
  notesPlayed: number;
}

export interface ScenarioReport {
  scenario: string;
  idle: ResourceSnapshot;
  running: ResourceSnapshot;
  afterStop: ResourceSnapshot;
  playing: ResourceWindow;
}

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };

/** Serve a built `dist/` on a random port (same as ui.test.ts). */
export function serveDist(root: string): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0];
      const p = path.join(root, url === '/' ? 'index.html' : url);
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    server.listen(0, () => resolve(server));
  });
}

interface ProcessInfo {
  type: string;
  id: number;
  cpuTime: number;
}

export class ResourceProbe {
  private readonly page: Page;
  private readonly cdp: CDPSession;
  private readonly browserCdp: CDPSession | null;

  private constructor(page: Page, cdp: CDPSession, browserCdp: CDPSession | null) {
    this.page = page;
    this.cdp = cdp;
    this.browserCdp = browserCdp;
  }

  static async attach(page: Page, browser: Browser): Promise<ResourceProbe> {
    const context: BrowserContext = page.context();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.enable');
    let browserCdp: CDPSession | null = null;
    try {
      browserCdp = await browser.newBrowserCDPSession();
      await browserCdp.send('SystemInfo.getProcessInfo');
    } catch {
      browserCdp = null; // not every Chromium build exposes SystemInfo; CPU fields stay 0
    }
    await page.evaluate(() => {
      const w = window as unknown as { __tfSteps?: Array<{ audioTime: number; margin: number }>; __tfNotes?: number; __tfStepsOff?: () => void };
      if (w.__tfSteps) return;
      w.__tfSteps = [];
      w.__tfNotes = 0;
      const engine = window.tropicflowEngine;
      w.__tfStepsOff = engine.subscribeSteps((_step, audioTime) => {
        w.__tfSteps!.push({ audioTime, margin: audioTime - engine.ctx.currentTime });
      });
      engine.subscribeNotes(() => {
        w.__tfNotes!++;
      });
    });
    return new ResourceProbe(page, cdp, browserCdp);
  }

  /**
   * Read the browser metrics after everything that was released has really
   * gone: Blink destroys AudioHandlers and React removes listeners on deferred
   * tasks *after* V8's GC, so one collectGarbage + read can catch an
   * intermediate value. GC, wait, re-read until two consecutive readings
   * agree on the node / listener counts (bounded).
   */
  private async settledMetrics(): Promise<Record<string, number>> {
    let previous: Record<string, number> | null = null;
    for (let i = 0; i < 12; i++) {
      await this.cdp.send('HeapProfiler.collectGarbage');
      await this.page.waitForTimeout(150);
      const { metrics } = await this.cdp.send('Performance.getMetrics');
      const m = Object.fromEntries(metrics.map((x) => [x.name, x.value])) as Record<string, number>;
      if (previous && previous.AudioHandlers === m.AudioHandlers && previous.JSEventListeners === m.JSEventListeners && previous.Nodes === m.Nodes) return m;
      previous = m;
    }
    return previous!;
  }

  /** Force a GC and read every layer. */
  async snapshot(label: string): Promise<ResourceSnapshot> {
    const m = await this.settledMetrics();
    const cpu = await this.processCpu();
    const app = await this.page.evaluate(() => {
      const chunks: Record<string, number> = {};
      for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
        if (e.name.endsWith('.js')) chunks[e.name.split('/').pop()!] = e.transferSize || e.decodedBodySize;
      }
      const engine = window.tropicflowEngine as { rack?: { inspect?: () => RackInspection } };
      return { chunks, rack: engine.rack?.inspect?.() ?? null };
    });
    return {
      label,
      at: performance.now(),
      audioHandlers: m.AudioHandlers ?? 0,
      audioWorkletProcessors: m.AudioWorkletProcessors ?? 0,
      jsHeapUsed: m.JSHeapUsedSize ?? 0,
      jsHeapTotal: m.JSHeapTotalSize ?? 0,
      domNodes: m.Nodes ?? 0,
      jsEventListeners: m.JSEventListeners ?? 0,
      arrayBufferContents: m.ArrayBufferContents ?? 0,
      taskDuration: m.TaskDuration ?? 0,
      scriptDuration: m.ScriptDuration ?? 0,
      cpu,
      chunks: app.chunks,
      rack: app.rack,
    };
  }

  /** Drop the recorded step margins and the note count (call before the window you want to judge). */
  async resetSteps(): Promise<void> {
    await this.page.evaluate(() => {
      const w = window as unknown as { __tfSteps: unknown[]; __tfNotes: number };
      w.__tfSteps = [];
      w.__tfNotes = 0;
    });
  }

  /** Notes played since the last reset. */
  async notesPlayed(): Promise<number> {
    return this.page.evaluate(() => (window as unknown as { __tfNotes: number }).__tfNotes);
  }

  async steps(): Promise<Array<{ audioTime: number; margin: number }>> {
    return this.page.evaluate(() => (window as unknown as { __tfSteps: Array<{ audioTime: number; margin: number }> }).__tfSteps);
  }

  /** Differences between two snapshots, normalised to wall time. */
  async window(a: ResourceSnapshot, b: ResourceSnapshot): Promise<ResourceWindow> {
    const wallSeconds = Math.max(1e-3, (b.at - a.at) / 1000);
    const steps = await this.steps();
    return {
      from: a.label,
      to: b.label,
      wallSeconds,
      mainThreadBusy: (b.taskDuration - a.taskDuration) / wallSeconds,
      scriptBusy: (b.scriptDuration - a.scriptDuration) / wallSeconds,
      rendererCpu: (b.cpu.renderer - a.cpu.renderer) / wallSeconds,
      gpuCpu: (b.cpu.gpu - a.cpu.gpu) / wallSeconds,
      audioServiceCpu: (b.cpu.audioService - a.cpu.audioService) / wallSeconds,
      heapDelta: b.jsHeapUsed - a.jsHeapUsed,
      audioHandlersDelta: b.audioHandlers - a.audioHandlers,
      stepsScheduled: steps.length,
      minStepMargin: steps.length ? Math.min(...steps.map((s) => s.margin)) : null,
      notesPlayed: await this.notesPlayed(),
    };
  }

  /**
   * A full scenario: idle snapshot, play the groove for `playMs`, snapshot
   * while running, stop, snapshot again. The caller has already put the rack
   * into the state under test.
   */
  async runScenario(scenario: string, playMs: number, settleMs: number = 500): Promise<ScenarioReport> {
    await this.page.waitForTimeout(settleMs);
    const idle = await this.snapshot(`${scenario}:idle`);
    await this.resetSteps();
    await this.page.click('text=START GROOVE');
    await this.page.waitForTimeout(playMs);
    const running = await this.snapshot(`${scenario}:running`);
    const playing = await this.window(idle, running);
    await this.page.click('text=STOP ENGINE');
    await this.page.waitForTimeout(settleMs);
    const afterStop = await this.snapshot(`${scenario}:stopped`);
    return { scenario, idle, running, afterStop, playing };
  }

  private async processCpu(): Promise<ProcessCpu> {
    const cpu: ProcessCpu = { renderer: 0, gpu: 0, audioService: 0, browser: 0 };
    if (!this.browserCdp) return cpu;
    const { processInfo } = (await this.browserCdp.send('SystemInfo.getProcessInfo')) as { processInfo: ProcessInfo[] };
    for (const p of processInfo) {
      // Only this page's browser exists, so summing the renderers is the page (plus an idle about:blank).
      if (p.type === 'renderer') cpu.renderer += p.cpuTime;
      else if (p.type === 'GPU') cpu.gpu += p.cpuTime;
      else if (p.type === 'browser') cpu.browser += p.cpuTime;
      else if (/audio/i.test(p.type)) cpu.audioService += p.cpuTime;
    }
    return cpu;
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/** Fixed-width table of scenario reports for the console. */
export function formatReports(reports: ScenarioReport[]): string {
  const rows: string[][] = [
    ['scenario', 'modules', 'audio nodes', 'worklets', 'heap idle', 'listeners', 'chunks', 'main busy', 'renderer', 'gpu', 'audio svc', 'min margin'],
  ];
  for (const r of reports) {
    const modules = r.idle.rack ? String(r.idle.rack.modules.length) : '?';
    rows.push([
      r.scenario,
      modules,
      `${r.idle.audioHandlers} / ${r.running.audioHandlers}`,
      String(r.idle.audioWorkletProcessors),
      mb(r.idle.jsHeapUsed),
      String(r.idle.jsEventListeners),
      `${Object.keys(r.idle.chunks).length} (${mb(Object.values(r.idle.chunks).reduce((a, b) => a + b, 0))})`,
      pct(r.playing.mainThreadBusy),
      pct(r.playing.rendererCpu),
      pct(r.playing.gpuCpu),
      pct(r.playing.audioServiceCpu),
      r.playing.minStepMargin === null ? '-' : `${(r.playing.minStepMargin * 1000).toFixed(0)} ms`,
    ]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ')).join('\n');
}

/** "audio nodes 44 -> 12 (-73%)" style lines for a scenario against a baseline scenario. */
export function formatDelta(baseline: ScenarioReport, current: ScenarioReport): string[] {
  const line = (name: string, a: number, b: number, fmt: (x: number) => string = (x) => String(x)) => {
    const rel = a === 0 ? '' : ` (${b >= a ? '+' : ''}${(((b - a) / a) * 100).toFixed(0)}%)`;
    return `${name}: ${fmt(a)} -> ${fmt(b)}${rel}`;
  };
  return [
    line('audio nodes (idle)', baseline.idle.audioHandlers, current.idle.audioHandlers),
    line('heap (idle)', baseline.idle.jsHeapUsed, current.idle.jsHeapUsed, mb),
    line('listeners (idle)', baseline.idle.jsEventListeners, current.idle.jsEventListeners),
    line('js fetched', Object.values(baseline.idle.chunks).reduce((a, b) => a + b, 0), Object.values(current.idle.chunks).reduce((a, b) => a + b, 0), mb),
    line('main thread busy', baseline.playing.mainThreadBusy, current.playing.mainThreadBusy, pct),
    line('renderer cpu', baseline.playing.rendererCpu, current.playing.rendererCpu, pct),
    line('gpu cpu', baseline.playing.gpuCpu, current.playing.gpuCpu, pct),
  ];
}

// ---------------------------------------------------------------------------
// Scenarios (shared by the e2e test and the CLI)
// ---------------------------------------------------------------------------

export interface ProfileScenario {
  name: string;
  /** A preset name (`?rack=<name>`, see RACK_PRESETS) or a list = start empty and add exactly these module types. */
  rack: 'default' | 'full' | string[];
  /** Needs `rack.editable` (add / remove / clear): skipped until the rack can be edited. */
  needsEditableRack: boolean;
}

/** Modules of the default rack that make a bare groove: clock, drums, master. */
const CORE = ['clock', 'percussion', 'master'];

export const PROFILE_SCENARIOS: ProfileScenario[] = [
  { name: 'all', rack: 'full', needsEditableRack: false },
  { name: 'default', rack: 'default', needsEditableRack: false },
  { name: 'none', rack: [], needsEditableRack: true },
  { name: 'core', rack: CORE, needsEditableRack: true },
  { name: 'chamber', rack: [...CORE, 'chamber'], needsEditableRack: true },
  { name: 'bridge', rack: [...CORE, 'midi', 'sensor'], needsEditableRack: true },
];

/**
 * A fresh page in the scenario's rack state. Lists start from `?rack=empty`
 * so only the code of the added modules is ever fetched; the default patch's
 * cables are applied (those whose jacks exist) so the groove sounds.
 */
export async function openScenario(context: BrowserContext, base: string, scenario: ProfileScenario): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${base}/?rack=${typeof scenario.rack === 'string' ? scenario.rack : 'empty'}`);
  await page.waitForFunction(() => typeof window.tropicflowEngine !== 'undefined');
  if (typeof scenario.rack !== 'string') {
    await page.evaluate(async (types: string[]) => {
      const engine = window.tropicflowEngine;
      for (const type of types) await engine.addModule(type);
      engine.applyPatch(engine.defaultCables());
    }, scenario.rack);
    // Card bodies are lazy: wait until every card rendered its body (or has none).
    await page.waitForFunction(() => !document.body.textContent?.includes('loading…'));
  }
  return page;
}

export async function rackIsEditable(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const engine = window.tropicflowEngine as { rack?: { inspect?: () => RackInspection } };
    return engine.rack?.inspect?.().editable ?? false;
  });
}

export interface ProfileFile {
  /** ISO date. */
  recordedAt: string;
  /** Chromium version string. */
  browser: string;
  playMs: number;
  reports: ScenarioReport[];
}

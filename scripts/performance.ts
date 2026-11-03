#!/usr/bin/env node
/**
 * Performance of the built app against the size of the rack:
 *
 *   npm run test:performance                      2, 4, 8 and 16 modules
 *   npm run test:performance -- --sizes 4,8,32    your own sizes
 *   npm run test:performance -- --play-ms 8000 --json out/perf.json
 *   npm run test:performance -- --repeat 3          median of 3 runs per size (CPU figures are noisy)
 *
 * For every size a fresh page starts empty (`?rack=empty`), the modules are
 * added (clock and master first, then the instruments round-robin, so every
 * rack makes sound), every instrument is wired to the clock and the master
 * bus, and the groove plays for a few seconds while the probe samples the
 * browser (live Web Audio nodes, heap, main-thread / renderer / GPU / audio
 * service CPU, scheduling margin). One ASCII table is printed. Needs a build
 * (npm run build) and a browser (npm run setup).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { launchChromium } from './lib/launchBrowser.mjs';
import { ResourceProbe, type ScenarioReport, serveDist } from './lib/resourceProbe.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.TROPICFLOW_DIST || path.join(ROOT, 'dist');

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const sizes = opt('--sizes', '2,4,8,16').split(',').map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
const playMs = Number(opt('--play-ms', '4000'));
const repeat = Math.max(1, Number(opt('--repeat', '1')));
const jsonOut = opt('--json', '');

/** Clock and master first (transport + output), then instruments round-robin: every size makes sound. */
const ORDER = ['clock', 'master'];
const INSTRUMENTS = ['marimba', 'percussion', 'synth', 'delay', 'chamber', 'midi', 'sensor'];
export function rackOfSize(n: number): string[] {
  const types: string[] = [];
  for (let i = 0; i < n; i++) types.push(i < ORDER.length ? ORDER[i] : INSTRUMENTS[(i - ORDER.length) % INSTRUMENTS.length]);
  return types;
}

/** Short label of a rack: "clk mst mrm×3 perc×2 ...". */
function describe(types: string[]): string {
  const short: Record<string, string> = { clock: 'clk', master: 'mst', marimba: 'mrm', percussion: 'drm', synth: 'syn', delay: 'dly', chamber: 'chm', midi: 'midi', sensor: 'sns' };
  const counts = new Map<string, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Array.from(counts, ([t, c]) => (c > 1 ? `${short[t] ?? t}×${c}` : short[t] ?? t)).join(' ');
}

/** Build the rack in the page and wire it: default cables for the canonical instances, clock -> every trigger-in, every audio-out -> master. */
async function buildRack(page: Page, types: string[]): Promise<void> {
  await page.evaluate(async (types: string[]) => {
    const engine = window.tropicflowEngine;
    for (const type of types) await engine.addModule(type);
    const nodes = engine.getNodes();
    const cables = engine.defaultCables();
    const has = (id: string) => nodes.some((n) => n.inputs.some((p) => p.id === id) || n.outputs.some((p) => p.id === id));
    let k = 0;
    for (const node of nodes) {
      for (const p of node.inputs) {
        if (p.type === 'trigger-in' && has('clk-trig-1') && !cables.some((c) => c.fromPortId === 'clk-trig-1' && c.toPortId === p.id)) {
          cables.push({ id: `perf-${++k}`, fromNodeId: 'clock-1', fromPortId: 'clk-trig-1', toNodeId: node.id, toPortId: p.id, color: '#70E000' });
        }
      }
      for (const p of node.outputs) {
        if (p.type === 'audio-out' && has('mst-in-l') && !cables.some((c) => c.fromPortId === p.id && c.toPortId === 'mst-in-l')) {
          cables.push({ id: `perf-${++k}`, fromNodeId: node.id, fromPortId: p.id, toNodeId: 'master-1', toPortId: 'mst-in-l', color: '#FF9E00' });
        }
      }
    }
    engine.applyPatch(cables);
  }, types);
  await page.waitForFunction(() => !document.body.textContent?.includes('loading…'));
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
  const rule = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  return [rule, line(rows[0]), rule, ...rows.slice(1).map(line), rule].join('\n');
}

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`no build at ${DIST}; run "npm run build" first`);
  process.exit(1);
}

const server = await serveDist(DIST);
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const { browser, label } = await launchChromium(chromium, { args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
console.log(`browser: ${label} (${browser.version()}); ${playMs} ms of groove per size${repeat > 1 ? `, median of ${repeat} runs` : ''}`);

const results: Array<{ size: number; types: string[]; report: ScenarioReport }> = [];
for (const size of sizes) {
  process.stdout.write(`${size} modules ... `);
  const types = rackOfSize(size);
  const runs: ScenarioReport[] = [];
  for (let i = 0; i < repeat; i++) {
    const page = await context.newPage();
    await page.goto(`${base}/?rack=empty`);
    await page.waitForFunction(() => typeof window.tropicflowEngine !== 'undefined');
    await buildRack(page, types);
    const probe = await ResourceProbe.attach(page, browser);
    runs.push(await probe.runScenario(`${size}`, playMs));
    await page.close();
  }
  // The run with the median main-thread load represents the size.
  runs.sort((a, b) => a.playing.mainThreadBusy - b.playing.mainThreadBusy);
  results.push({ size, types, report: runs[Math.floor(runs.length / 2)] });
  console.log('done');
}
await browser.close();
server.close();

const rows: string[][] = [
  ['modules', 'rack', 'audio nodes idle/play', 'heap idle', 'js fetched', 'notes/s', 'main busy', 'renderer', 'gpu', 'audio svc', 'min margin'],
];
for (const { size, types, report: r } of results) {
  rows.push([
    String(size),
    describe(types),
    `${r.idle.audioHandlers} / ${r.running.audioHandlers}`,
    mb(r.idle.jsHeapUsed),
    mb(Object.values(r.idle.chunks).reduce((a, b) => a + b, 0)),
    (r.playing.notesPlayed / r.playing.wallSeconds).toFixed(1),
    pct(r.playing.mainThreadBusy),
    pct(r.playing.rendererCpu),
    pct(r.playing.gpuCpu),
    pct(r.playing.audioServiceCpu),
    r.playing.minStepMargin === null ? '-' : `${(r.playing.minStepMargin * 1000).toFixed(0)} ms`,
  ]);
}
console.log();
console.log(table(rows));
console.log('\nCPU columns are the share of one core over the window; "min margin" is how far ahead of the audio clock the tightest step was scheduled (the lookahead is 100 ms; negative = late).');

if (jsonOut) {
  fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
  fs.writeFileSync(jsonOut, JSON.stringify({ recordedAt: new Date().toISOString(), browser: browser.version(), playMs, results }, null, 2) + '\n');
  console.log(`written ${jsonOut}`);
}

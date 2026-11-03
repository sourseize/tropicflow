/**
 * Resource profile of the built app per rack configuration (see
 * docs/PLUGIN_ARCHITECTURE_PLAN.md, "Resource profiling in e2e").
 *
 * Deterministic counters (live Web Audio nodes, listeners, fetched JS) are
 * asserted against tests/golden/profile-baseline.json so the plugin split
 * cannot regress silently; CPU and heap are reported only (headless CI is
 * noisy). The full picture is written to .tropicflow-cache/profile.json;
 * `npm run profile:modules` prints the same table for humans.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { launchChromium } from '../../scripts/lib/launchBrowser.mjs';
import {
  PROFILE_SCENARIOS,
  type ProfileFile,
  ResourceProbe,
  type ScenarioReport,
  formatDelta,
  formatReports,
  openScenario,
  rackIsEditable,
  serveDist,
} from '../../scripts/lib/resourceProbe.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = process.env.TROPICFLOW_DIST || path.join(ROOT, 'dist');
const BASELINE = path.join(ROOT, 'tests/golden/profile-baseline.json');
const OUT = path.join(ROOT, '.tropicflow-cache/profile.json');
const PLAY_MS = 4000;

const hasBuild = fs.existsSync(path.join(DIST, 'index.html'));

describe('resource profile per rack configuration', { skip: hasBuild ? false : `no build at ${DIST}; run "npm run build" first` }, () => {
  let server: http.Server;
  let browser: Browser;
  let context: BrowserContext;
  let base: string;
  let editable = false;
  const reports: ScenarioReport[] = [];
  const baseline: ProfileFile | null = fs.existsSync(BASELINE) ? (JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as ProfileFile) : null;
  const baselineFor = (name: string) => baseline?.reports.find((r) => r.scenario === name) ?? null;

  before(async () => {
    server = await serveDist(DIST);
    base = `http://localhost:${(server.address() as { port: number }).port}`;
    ({ browser } = await launchChromium(chromium, { args: ['--autoplay-policy=no-user-gesture-required'] }));
    context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await openScenario(context, base, PROFILE_SCENARIOS[0]);
    editable = await rackIsEditable(page);
    await page.close();
  });

  after(async () => {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const file: ProfileFile = { recordedAt: new Date().toISOString(), browser: browser?.version() ?? '', playMs: PLAY_MS, reports };
    fs.writeFileSync(OUT, JSON.stringify(file, null, 2) + '\n');
    await browser?.close();
    server?.close();
  });

  for (const scenario of PROFILE_SCENARIOS) {
    test(`scenario "${scenario.name}"`, async (t) => {
      if (scenario.needsEditableRack && !editable) {
        t.skip('the rack cannot be edited yet (phase 2 of the plugin plan)');
        return;
      }
      // A fresh page per scenario: fetched chunks and counters describe exactly this rack.
      const page: Page = await openScenario(context, base, scenario);
      const probe = await ResourceProbe.attach(page, browser);
      const report = await probe.runScenario(scenario.name, PLAY_MS);
      const late = (await probe.steps()).filter((s) => s.margin < 0).length;
      await page.close();
      reports.push(report);
      t.diagnostic(formatReports([report]).split('\n').join(' | '));

      assert.ok(report.playing.stepsScheduled > 0, 'the groove ran');
      // Counters are valid either way; the CPU figures only describe the engine when the machine kept up.
      if (late > 0) t.diagnostic(`main thread stalled ${late}x during the run (min margin ${(report.playing.minStepMargin! * 1000).toFixed(0)} ms): CPU figures are not representative`);

      // Rack accounting: what the ledgers hold is back to idle after STOP.
      if (report.idle.rack) {
        assert.deepEqual(report.afterStop.rack!.total, report.idle.rack.total, 'no module resource leaked across a run');
      }

      const ref = baselineFor(scenario.name);
      if (ref) {
        for (const line of formatDelta(ref, report)) t.diagnostic(`vs baseline: ${line}`);
        // Deterministic counters must not grow past the recorded baseline.
        assert.ok(report.idle.audioHandlers <= ref.idle.audioHandlers, `idle Web Audio nodes ${report.idle.audioHandlers} > baseline ${ref.idle.audioHandlers}`);
        const bytes = (r: ScenarioReport) => Object.values(r.idle.chunks).reduce((a, b) => a + b, 0);
        // Code-split chunks carry a little overhead each; "all" fetches every one of them.
        assert.ok(bytes(report) <= bytes(ref) * 1.15, `JS fetched ${bytes(report)} B is more than 15% above the baseline ${bytes(ref)} B`);
      }
    });
  }

  test('editable rack: "none" holds nothing and counters are monotonic in the module set', async (t) => {
    if (!editable) {
      t.skip('the rack cannot be edited yet (phase 2 of the plugin plan)');
      return;
    }
    const by = Object.fromEntries(reports.map((r) => [r.scenario, r]));
    const none = by.none;
    assert.deepEqual(none.idle.rack!.total, { audioNodes: 0, timers: 0, animationLoops: 0, streams: 0, listeners: 0 });
    assert.equal(Object.keys(none.idle.chunks).length, 1, 'an empty rack fetches only the main chunk');
    // Blink's handler count includes a few transient nodes (+-2); the ledgers are exact.
    const TOLERANCE = 2;
    const order = ['none', 'core', 'chamber', 'default', 'all'];
    for (let i = 1; i < order.length; i++) {
      const a = by[order[i - 1]];
      const b = by[order[i]];
      assert.ok(a.idle.rack!.total.audioNodes <= b.idle.rack!.total.audioNodes, `${order[i - 1]} holds no more nodes than ${order[i]}`);
      assert.ok(a.idle.audioHandlers <= b.idle.audioHandlers + TOLERANCE, `${order[i - 1]} (${a.idle.audioHandlers} nodes) <= ${order[i]} (${b.idle.audioHandlers})`);
      assert.ok(Object.keys(a.idle.chunks).length <= Object.keys(b.idle.chunks).length, 'chunks are only fetched when a module needs them');
    }
    assert.ok(by.bridge.idle.audioHandlers >= by.core.idle.audioHandlers - TOLERANCE);
    assert.ok(by.all.idle.audioHandlers > by.none.idle.audioHandlers, 'the default rack holds more nodes than an empty one');
  });

  test('churn: clearing and resetting the rack repeatedly leaks nothing', async (t) => {
    if (!editable) {
      t.skip('the rack cannot be edited yet (phase 2 of the plugin plan)');
      return;
    }
    const page = await openScenario(context, base, PROFILE_SCENARIOS[0]);
    const probe = await ResourceProbe.attach(page, browser);
    const bodiesLoaded = () => page.waitForFunction(() => !document.body.textContent?.includes('loading…'));
    const cycle = async () => {
      await page.click('[data-testid="reset-patch"]');
      await bodiesLoaded();
      await page.waitForTimeout(200);
      await page.click('[data-testid="clear-all"]');
      await page.waitForTimeout(200);
    };
    // The context must render for disconnected nodes with a tail (the delay's 2 s) to be freed: play once.
    await page.click('text=START GROOVE');
    await page.waitForTimeout(300);
    await page.click('text=STOP ENGINE');
    // Warm-up cycles: React keeps one previously rendered subtree around (a bounded, one-time cost that
    // shows on the second clear); what must not happen is growth per cycle.
    await cycle();
    await cycle();
    await page.waitForTimeout(2500);
    const first = await probe.snapshot('churn:warm');
    const CYCLES = 5;
    for (let i = 0; i < CYCLES; i++) await cycle();
    await page.waitForTimeout(2500);
    const last = await probe.snapshot(`churn:${CYCLES}`);
    assert.deepEqual(last.rack!.total, first.rack!.total, 'the rack holds nothing after every clear');
    assert.ok(Math.abs(last.audioHandlers - first.audioHandlers) <= 2, `Web Audio nodes after ${CYCLES} reset/clear cycles: ${first.audioHandlers} -> ${last.audioHandlers}`);
    assert.ok(Math.abs(last.jsEventListeners - first.jsEventListeners) <= 4, `DOM listeners after ${CYCLES} cycles: ${first.jsEventListeners} -> ${last.jsEventListeners}`);
    assert.ok(Math.abs(last.domNodes - first.domNodes) <= 50, `DOM nodes after ${CYCLES} cycles: ${first.domNodes} -> ${last.domNodes}`);
    t.diagnostic(`after ${CYCLES} cycles: audio nodes ${first.audioHandlers} -> ${last.audioHandlers}, listeners ${first.jsEventListeners} -> ${last.jsEventListeners}, DOM nodes ${first.domNodes} -> ${last.domNodes}, heap ${first.jsHeapUsed} -> ${last.jsHeapUsed} B`);
    await page.close();
  });

  test('summary', (t) => {
    for (const line of formatReports(reports).split('\n')) t.diagnostic(line);
  });
});

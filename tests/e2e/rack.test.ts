/**
 * Rack editing in the built app: ADD MODULE (browser), remove (×), CLEAR
 * ALL, RESET PATCH, second instances, hot-plugging while playing, and lazy
 * loading of card bodies. Serves `dist/` like ui.test.ts.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { launchChromium } from '../../scripts/lib/launchBrowser.mjs';
import { serveDist } from '../../scripts/lib/resourceProbe.ts';
import type { RackInspection } from '../../src/core/modules/ModuleContract.ts';
/// <reference path=\"../../src/types/window.d.ts\" />

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = process.env.TROPICFLOW_DIST || path.join(ROOT, 'dist');
const hasBuild = fs.existsSync(path.join(DIST, 'index.html'));

type Win = Window & { __notes: Array<{ track: string; source: string; time: number }>; __notesOff?: () => void };

describe('rack editing (built app in headless Chromium)', { skip: hasBuild ? false : `no build at ${DIST}; run "npm run build" first` }, () => {
  let server: http.Server;
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let base: string;
  const errors: string[] = [];

  const open = async (query = '') => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
    });
    await p.goto(`${base}/${query}`);
    await p.waitForFunction(() => typeof window.tropicflowEngine !== 'undefined');
    return p;
  };

  before(async () => {
    server = await serveDist(DIST);
    base = `http://localhost:${(server.address() as { port: number }).port}`;
    ({ browser } = await launchChromium(chromium, { args: ['--autoplay-policy=no-user-gesture-required'] }));
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    page = await open();
  });

  after(async () => {
    await browser?.close();
    server?.close();
  });

  const inspect = (p: Page = page) => p.evaluate(() => window.tropicflowEngine.rack.inspect() as RackInspection);
  const moduleIds = (p: Page = page) => p.evaluate(() => window.tropicflowEngine.rack.list().map((m) => m.id));
  const patchIds = (p: Page = page) => p.evaluate(() => window.tropicflowEngine.getPatch().map((c) => `${c.fromPortId}->${c.toPortId}`));
  const cardCount = (p: Page = page) => p.locator('[data-testid^="module-"][data-module-type]').count();
  const recordNotes = (p: Page = page) =>
    p.evaluate(() => {
      const w = window as unknown as Win;
      w.__notesOff?.();
      w.__notes = [];
      w.__notesOff = window.tropicflowEngine.subscribeNotes((n) => w.__notes.push({ track: n.track, source: n.source, time: n.time }));
    });
  const notes = (p: Page = page) => p.evaluate(() => (window as unknown as Win).__notes);
  const cardChunks = (p: Page) =>
    p.evaluate(() => (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter((e) => /\/Card-[^/]*\.js$/.test(e.name)).length);

  test('the default rack (four tropical modules + the chamber) is loaded and editable; every card has a remove control', async () => {
    assert.equal(await cardCount(), 5);
    const info = await inspect();
    assert.equal(info.editable, true);
    assert.deepEqual(info.modules.map((m) => m.id), ['clock-1', 'marimba-1', 'percussion-1', 'master-1', 'chamber-1']);
    assert.deepEqual(await patchIds(), [
      'clk-trig-1->mrm-trig-in',
      'clk-trig-1->perc-trig-in',
      'perc-audio-out->mst-in-l',
      'mrm-audio-out->mst-in-l',
      'chm-trig-out->perc-trig-in',
      'chm-trig-out->mrm-trig-in',
    ]);
    assert.equal(await page.locator('[data-testid^="module-remove-"]').count(), 5);
    // The fixed panels say what is missing: the synth row has no module, the soundboard no bridge.
    assert.equal(await page.locator('[data-missing-module="true"]').count(), 1);
    assert.ok(await page.isVisible('[data-testid="keys-no-bridge"]'));
  });

  test('the FULL STUDIO preset loads every module with the historical wiring; RESET PATCH returns to the default', async () => {
    await page.click('[data-testid="add-module"]');
    await page.click('[data-testid="load-preset-full"]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="module-sensor-1"]');
    assert.equal(await cardCount(), 9);
    assert.deepEqual(await moduleIds(), ['clock-1', 'marimba-1', 'percussion-1', 'synth-1', 'delay-1', 'chamber-1', 'midi-1', 'sensor-1', 'master-1']);
    assert.equal((await patchIds()).length, 15);
    assert.equal(await page.locator('[data-missing-module="true"]').count(), 0);
    assert.equal(await page.locator('[data-testid="keys-no-bridge"]').count(), 0);
    await page.click('[data-testid="reset-patch"]');
    await page.waitForSelector('[data-testid="module-sensor-1"]', { state: 'detached' });
    assert.equal(await cardCount(), 5);
    assert.equal((await patchIds()).length, 6);
  });

  test('removing a module with × cuts its cables, stops it being triggered and frees its resources', async () => {
    const before = await inspect();
    const perc = before.modules.find((m) => m.id === 'percussion-1')!;
    assert.ok(perc.audioNodes >= 1, 'the drums hold at least their output node');
    await page.click('[data-testid="module-remove-percussion-1"]');
    await page.waitForSelector('[data-testid="module-percussion-1"]', { state: 'detached' });
    assert.equal(await cardCount(), 4);
    const ids = await patchIds();
    assert.ok(!ids.some((id) => id.includes('perc-')), `no cable touches the drums: ${ids.join(', ')}`);
    assert.equal(ids.length, 3, 'the three cables touching the drums are gone, the rest stays');
    assert.equal(await page.evaluate(() => window.tropicflowEngine.isTriggerTarget('percussion')), false);
    const after = await inspect();
    assert.equal(after.modules.length, 4);
    assert.equal(after.total.audioNodes, before.total.audioNodes - perc.audioNodes);
    // The fixed sequencer panel shows the missing instruments instead of crashing.
    assert.equal(await page.locator('[data-missing-module="true"]').count(), 4, 'kick / snare / hihat (+ the synth row) audition buttons are marked');
  });

  test('RESET PATCH restores the default rack exactly: same modules, same cables, canonical jack ids', async () => {
    await page.click('[data-testid="reset-patch"]');
    await page.waitForSelector('[data-testid="module-percussion-1"]');
    assert.equal(await cardCount(), 5);
    assert.deepEqual(await moduleIds(), ['clock-1', 'marimba-1', 'percussion-1', 'master-1', 'chamber-1']);
    assert.equal((await patchIds()).length, 6);
    assert.ok((await patchIds()).includes('clk-trig-1->perc-trig-in'));
    assert.equal(await page.locator('[data-missing-module="true"]').count(), 1);
  });

  test('CLEAR ALL empties the rack: no cards, no cables, nothing held, the groove plays silence', async () => {
    await page.click('[data-testid="clear-all"]');
    await page.waitForSelector('[data-testid="empty-rack"]');
    assert.equal(await cardCount(), 0);
    assert.deepEqual(await patchIds(), []);
    const info = await inspect();
    assert.equal(info.modules.length, 0);
    assert.deepEqual(info.total, { audioNodes: 0, timers: 0, animationLoops: 0, streams: 0, listeners: 0 });
    assert.ok(await page.isVisible('[data-testid="keys-no-bridge"]'), 'the soundboard says a MIDI BRIDGE is needed');

    await recordNotes();
    await page.click('text=START GROOVE');
    await page.waitForFunction(() => window.tropicflowEngine.clock.getCurrentStep() > 8);
    assert.deepEqual(await notes(), [], 'the transport runs but nothing sounds');
    await page.click('text=STOP ENGINE');
  });

  test('ADD MODULE lists every plugin; adding while playing builds a working groove from nothing', async () => {
    await page.click('[data-testid="add-module"]');
    await page.waitForSelector('[data-testid="module-browser"]');
    assert.equal(await page.locator('[data-testid^="browser-module-"]').count(), 9);
    assert.equal(await page.locator('[data-testid^="load-preset-"]').count(), 2);
    await page.click('[data-testid="add-module-clock"]');
    await page.click('[data-testid="add-module-marimba"]');
    await page.click('[data-testid="add-module-master"]');
    assert.equal(await page.textContent('[data-testid="browser-count-marimba"]'), 'in rack ×1');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="module-browser"]', { state: 'detached' });
    assert.deepEqual(await moduleIds(), ['clock-1', 'marimba-1', 'master-1']);
    assert.equal(await cardCount(), 3);
    // Canonical ids: the cables of the default patch that fit this rack apply as-is.
    await page.evaluate(() => window.tropicflowEngine.applyPatch(window.tropicflowEngine.defaultCables()));
    assert.deepEqual(await patchIds(), ['clk-trig-1->mrm-trig-in', 'mrm-audio-out->mst-in-l']);

    await recordNotes();
    await page.click('text=START GROOVE');
    await page.waitForFunction(() => window.tropicflowEngine.clock.getCurrentStep() > 8);
    const played = await notes();
    assert.ok(played.length >= 3, `marimba notes were played: ${played.length}`);
    assert.ok(played.every((n) => n.track === 'marimba' && n.source === 'sequencer'));

    // Hot-plug the drums while playing: they join the running transport and sound from the next steps.
    await page.click('[data-testid="add-module"]');
    await page.click('[data-testid="add-module-percussion"]');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.tropicflowEngine.applyPatch([...window.tropicflowEngine.getPatch(), ...window.tropicflowEngine.defaultCables()]));
    await page.waitForFunction(() => (window as unknown as Win).__notes.some((n) => n.track === 'kick'), undefined, { timeout: 5000 });
    await page.click('text=STOP ENGINE');
  });

  test('a second instance of a type gets suffixed jack ids and sounds on its own cable', async () => {
    await page.click('[data-testid="add-module"]');
    await page.click('[data-testid="add-module-marimba"]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="module-marimba-2"]');
    const ports = await page.evaluate(() => window.tropicflowEngine.getNodes().find((n) => n.id === 'marimba-2')!);
    assert.deepEqual(ports.inputs.map((p) => p.id), ['mrm-trig-in@marimba-2', 'mrm-cv-in@marimba-2']);
    assert.deepEqual(ports.outputs.map((p) => p.id), ['mrm-audio-out@marimba-2']);
    assert.ok(await page.isVisible('[data-port-id="mrm-trig-in@marimba-2"]'));

    // Patch clock -> marimba-2 by dragging, then both marimbas fire on every marimba step.
    const from = (await page.locator('[data-port-id="clk-trig-1"]').boundingBox())!;
    const to = (await page.locator('[data-port-id="mrm-trig-in@marimba-2"]').boundingBox())!;
    await page.mouse.move(from.x + 8, from.y + 8);
    await page.mouse.down();
    await page.mouse.move(to.x + 8, to.y + 8, { steps: 10 });
    await page.mouse.up();
    assert.ok((await patchIds()).includes('clk-trig-1->mrm-trig-in@marimba-2'));
    await recordNotes();
    await page.click('text=START GROOVE');
    await page.waitForFunction(() => (window as unknown as Win).__notes.filter((n) => n.track === 'marimba').length >= 4);
    await page.click('text=STOP ENGINE');
    const marimbaNotes = (await notes()).filter((n) => n.track === 'marimba');
    const byTime = new Map<number, number>();
    for (const n of marimbaNotes) byTime.set(n.time, (byTime.get(n.time) ?? 0) + 1);
    assert.ok(Array.from(byTime.values()).every((c) => c === 2), `every marimba step sounds twice (two modules): ${JSON.stringify(marimbaNotes)}`);

    // Removing the second one leaves the first untouched.
    await page.click('[data-testid="module-remove-marimba-2"]');
    await page.waitForSelector('[data-testid="module-marimba-2"]', { state: 'detached' });
    assert.ok(!(await patchIds()).some((id) => id.includes('@marimba-2')));
    assert.ok((await patchIds()).includes('clk-trig-1->mrm-trig-in'));
  });

  test('card bodies are loaded lazily: an empty start fetches no card code until a module is added', async () => {
    const fresh = await open('?rack=empty');
    assert.equal(await cardCount(fresh), 0);
    assert.equal(await cardChunks(fresh), 0, 'no card chunk was fetched');
    await fresh.click('[data-testid="add-module"]');
    await fresh.click('[data-testid="add-module-marimba"]');
    await fresh.keyboard.press('Escape');
    await fresh.waitForSelector('[data-testid="module-marimba-1"] [data-port-id="mrm-trig-in"]');
    await fresh.waitForFunction(() => document.querySelector('[data-testid="module-marimba-1"]')?.textContent?.includes('MALLET'));
    assert.equal(await cardChunks(fresh), 1, 'exactly the marimba card chunk');
    await fresh.click('[data-testid="add-module"]');
    await fresh.click('[data-testid="add-module-chamber"]');
    await fresh.keyboard.press('Escape');
    await fresh.waitForSelector('[data-testid="chamber-drop"]');
    assert.equal(await cardChunks(fresh), 2, 'plus the chamber card chunk');
    await fresh.close();
  });

  test('no page errors occurred', () => {
    assert.deepEqual(errors, []);
  });
});

/**
 * UI end-to-end test: drives the built app in headless Chromium.
 *
 * Serves the production build (`npm run build` -> dist/) or the directory in
 * TROPICFLOW_DIST. Skips when no build is present.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { launchChromium } from '../../scripts/lib/launchBrowser.mjs';
import { decodeWav } from '../../src/core/render/WavCodec.ts';
import { verifyScore } from '../../src/core/analysis/AudioAnalysis.ts';
import type { ScoreEvent } from '../../src/core/render/RenderConfig.ts';
/// <reference path=\"../../src/types/window.d.ts\" />

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = process.env.TROPICFLOW_DIST || path.join(ROOT, 'dist');
const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };

function serve(root: string): Promise<http.Server> {
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

const hasBuild = fs.existsSync(path.join(DIST, 'index.html'));

describe('UI (built app in headless Chromium)', { skip: hasBuild ? false : `no build at ${DIST}; run "npm run build" first` }, () => {
  let server: http.Server;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  before(async () => {
    server = await serve(DIST);
    const port = (server.address() as { port: number }).port;
    ({ browser } = await launchChromium(chromium, { args: ['--autoplay-policy=no-user-gesture-required'] }));
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
    });
    await page.goto(`http://localhost:${port}/`);
    await page.waitForFunction(() => typeof window.tropicflowEngine !== 'undefined');
  });

  after(async () => {
    await browser?.close();
    server?.close();
  });

  const patchIds = () => page.evaluate(() => window.tropicflowEngine.getPatch().map((c) => `${c.fromPortId}->${c.toPortId}`));

  test('starting the groove advances the clock and fires steps', async () => {
    await page.click('text=START GROOVE');
    await page.waitForFunction(() => window.tropicflowEngine.clock.getCurrentStep() > 4);
    assert.ok(await page.isVisible('text=STOP ENGINE'));
  });

  test('double-clicking a jack unplugs it and the module stops being triggered', async () => {
    assert.ok((await patchIds()).includes('clk-trig-1->perc-trig-in'));
    await page.dblclick('[data-port-id="perc-trig-in"]');
    assert.ok(!(await patchIds()).includes('clk-trig-1->perc-trig-in'));
    assert.equal(await page.evaluate(() => window.tropicflowEngine.isTriggerTarget('percussion')), false);
  });

  test('dragging from an output jack to an input jack creates a cable', async () => {
    const from = (await page.locator('[data-port-id="clk-trig-1"]').boundingBox())!;
    const to = (await page.locator('[data-port-id="perc-trig-in"]').boundingBox())!;
    await page.mouse.move(from.x + 8, from.y + 8);
    await page.mouse.down();
    await page.mouse.move(to.x + 8, to.y + 8, { steps: 10 });
    await page.mouse.up();
    assert.ok((await patchIds()).includes('clk-trig-1->perc-trig-in'));
    assert.equal(await page.evaluate(() => window.tropicflowEngine.isTriggerTarget('percussion')), true);
  });

  test('illegal cables (trigger -> audio input) are rejected', async () => {
    const before = await patchIds();
    const from = (await page.locator('[data-port-id="clk-trig-1"]').boundingBox())!;
    const to = (await page.locator('[data-port-id="mst-in-l"]').boundingBox())!;
    await page.mouse.move(from.x + 8, from.y + 8);
    await page.mouse.down();
    await page.mouse.move(to.x + 8, to.y + 8, { steps: 10 });
    await page.mouse.up();
    assert.deepEqual(await patchIds(), before);
  });

  test('BOUNCE WAV downloads a WAV whose notes verify against the SCORE download', async () => {
    const [wavDownload] = await Promise.all([page.waitForEvent('download'), page.click('text=BOUNCE WAV')]);
    assert.match(wavDownload.suggestedFilename(), /^tropicflow-\d+bpm-2bars\.wav$/);
    const wavBuf = fs.readFileSync((await wavDownload.path())!);
    const [scoreDownload] = await Promise.all([page.waitForEvent('download'), page.click('text=SCORE')]);
    const scoreFile = JSON.parse(fs.readFileSync((await scoreDownload.path())!, 'utf8')) as { score: ScoreEvent[] };

    const wav = decodeWav(wavBuf);
    assert.equal(wav.channels.length, 2);
    assert.equal(scoreFile.score.length, 64);
    const v = verifyScore(wav.channels, wav.sampleRate, scoreFile.score, { signal: 'master' });
    assert.equal(v.failures.length, 0, v.failures.map((f) => f.reason).join('\n'));
  });

  test('gravity chamber: DROP adds a ball, hits produce notes while playing, CLEAR empties it', async () => {
    await page.evaluate(() => {
      (window as unknown as { __chamberNotes: unknown[] }).__chamberNotes = [];
      window.tropicflowEngine.subscribeNotes((n) => {
        if (n.source === 'chamber') (window as unknown as { __chamberNotes: unknown[] }).__chamberNotes.push({ t: n.time, track: n.track });
      });
    });
    assert.ok(await page.evaluate(() => window.tropicflowEngine.clock.getIsPlaying()));
    await page.click('[data-testid="chamber-drop"]');
    await page.click('[data-testid="chamber-drop"]');
    assert.equal(await page.evaluate(() => window.tropicflowEngine.chamber.getBalls().length), 2);
    await page.waitForFunction(
      () => (window as unknown as { __chamberNotes: unknown[] }).__chamberNotes.length >= 3,
      undefined,
      { timeout: 8000 }
    );
    const notes = await page.evaluate(() => (window as unknown as { __chamberNotes: Array<{ track: string }> }).__chamberNotes);
    assert.ok(notes.every((n) => ['kick', 'snare', 'hihat', 'marimba', 'synth'].includes(n.track)));
    await page.click('[data-testid="chamber-clear"]');
    assert.equal(await page.evaluate(() => window.tropicflowEngine.chamber.getBalls().length), 0);
  });

  test('gravity chamber canvas: click drops at x, shift+click adds a peg, alt+click removes it', async () => {
    const box = (await page.locator('[data-testid="gravity-chamber"]').boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
    const balls = await page.evaluate(() => window.tropicflowEngine.chamber.getBalls().map((b) => b.x));
    assert.equal(balls.length, 1);
    assert.ok(Math.abs(balls[0] - 0.2) < 0.02, `dropped at x=${balls[0]}`);

    const pegsBefore = await page.evaluate(() => window.tropicflowEngine.chamber.physics.getPegs().length);
    await page.keyboard.down('Shift');
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.3);
    await page.keyboard.up('Shift');
    const pegs = await page.evaluate(() => window.tropicflowEngine.chamber.physics.getPegs().map((p) => ({ id: p.id, x: p.x, y: p.y })));
    assert.equal(pegs.length, pegsBefore + 1);
    const added = pegs[pegs.length - 1];
    assert.ok(Math.abs(added.x - 0.8) < 0.02 && Math.abs(added.y - 0.3) < 0.02);

    await page.keyboard.down('Alt');
    await page.mouse.click(box.x + (added.x / 1) * box.width, box.y + (added.y / 1) * box.height);
    await page.keyboard.up('Alt');
    assert.equal(await page.evaluate(() => window.tropicflowEngine.chamber.physics.getPegs().length), pegsBefore);
    await page.click('[data-testid="chamber-clear"]');
  });

  test('gravity chamber: ctrl+drag draws a ramp, wheel changes a peg note, alt+click removes the ramp', async () => {
    const box = (await page.locator('[data-testid="gravity-chamber"]').boundingBox())!;
    const pt = (x: number, y: number) => ({ x: box.x + x * box.width, y: box.y + y * box.height });
    const before = await page.evaluate(() => window.tropicflowEngine.chamber.physics.getSegments().length);
    await page.keyboard.down('Control');
    const a = pt(0.1, 0.8);
    const b = pt(0.45, 0.9);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Control');
    const segs = await page.evaluate(() => window.tropicflowEngine.chamber.physics.getSegments().map((s) => ({ ...s })));
    assert.equal(segs.length, before + 1);
    const seg = segs[segs.length - 1];
    assert.ok(Math.abs(seg.x1 - 0.1) < 0.02 && Math.abs(seg.y2 - 0.9) < 0.02, JSON.stringify(seg));

    // Wheel up over the first peg raises its note by one.
    const peg = await page.evaluate(() => ({ ...window.tropicflowEngine.chamber.physics.getPegs()[0] }));
    const pp = pt(peg.x, peg.y);
    await page.mouse.move(pp.x, pp.y);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(50);
    const after = await page.evaluate(() => window.tropicflowEngine.chamber.physics.getPegs()[0].note);
    assert.equal(after, peg.note + 1);

    // Alt+click on the ramp removes it.
    const mid = pt((seg.x1 + seg.x2) / 2, (seg.y1 + seg.y2) / 2);
    await page.keyboard.down('Alt');
    await page.mouse.click(mid.x, mid.y);
    await page.keyboard.up('Alt');
    assert.equal(await page.evaluate(() => window.tropicflowEngine.chamber.physics.getSegments().length), before);
  });

  test('collision mapper panel: remapping the floor to snare changes what a floor hit plays', async () => {
    await page.click('text=RESET PATCH'); // earlier tests unplugged the chamber -> drums cable
    await page.click('[data-testid="chamber-clear"]');
    await page.click('[data-testid="chamber-mapping-toggle"]');
    await page.selectOption('[data-testid="mapping-floor"]', 'snare');
    await page.selectOption('[data-testid="mapping-scale"]', 'minor pentatonic');
    await page.selectOption('[data-testid="mapping-root"]', 'A3');
    const mapping = await page.evaluate(() => window.tropicflowEngine.chamber.getConfig().mapping);
    assert.equal(mapping.floor.track, 'snare');
    assert.deepEqual(mapping.scale, [0, 3, 5, 7, 10]);
    assert.equal(mapping.rootHz, 220);

    // Silence pegs and walls so only floor hits remain, drop a ball and wait for its first hit.
    for (const key of ['peg', 'left', 'right', 'ceiling', 'ball', 'segment']) {
      await page.selectOption(`[data-testid="mapping-${key}"]`, 'none');
    }
    await page.evaluate(() => {
      (window as unknown as { __floorNotes: unknown[] }).__floorNotes = [];
      window.tropicflowEngine.subscribeNotes((n) => {
        if (n.source === 'chamber') (window as unknown as { __floorNotes: unknown[] }).__floorNotes.push(n.track);
      });
    });
    await page.click('[data-testid="chamber-drop"]');
    await page.waitForFunction(() => (window as unknown as { __floorNotes: unknown[] }).__floorNotes.length >= 1, undefined, { timeout: 8000 });
    const tracks = await page.evaluate(() => (window as unknown as { __floorNotes: string[] }).__floorNotes);
    assert.ok(tracks.every((t) => t === 'snare'), `got ${tracks.join(',')}`);
    await page.click('[data-testid="chamber-clear"]');
    await page.selectOption('[data-testid="mapping-floor"]', 'kick');
    for (const key of ['left', 'right', 'ceiling', 'ball']) await page.selectOption(`[data-testid="mapping-${key}"]`, key === 'left' ? 'hihat' : key === 'right' ? 'hihat-open' : 'snare');
    await page.selectOption('[data-testid="mapping-peg"]', 'marimba');
    await page.selectOption('[data-testid="mapping-segment"]', 'synth');
    await page.click('[data-testid="chamber-mapping-toggle"]');
  });

  test('DROP with ON BAR waits for the next bar start', async () => {
    await page.click('[data-testid="chamber-clear"]');
    await page.click('[data-testid="chamber-drop-sync"]');
    assert.equal(await page.evaluate(() => window.tropicflowEngine.chamber.getConfig().dropSync), 'bar');
    await page.click('[data-testid="chamber-drop"]');
    // Either still queued, or a bar boundary already passed and released it.
    const state = await page.evaluate(() => ({
      pending: window.tropicflowEngine.chamber.pendingBarDropCount(),
      balls: window.tropicflowEngine.chamber.getBalls().length,
    }));
    assert.ok((state.pending === 1 && state.balls === 0) || (state.pending === 0 && state.balls === 1), JSON.stringify(state));
    await page.waitForFunction(() => window.tropicflowEngine.chamber.getBalls().length === 1, undefined, { timeout: 6000 });
    const ball = await page.evaluate(() => ({ ...window.tropicflowEngine.chamber.getBalls()[0] }));
    const barLen = (60 / (await page.evaluate(() => window.tropicflowEngine.clock.getBpm()))) * 4;
    const start = await page.evaluate(() => window.tropicflowEngine.clock.getStartTime());
    const k = (ball.bornAt - start) / barLen;
    assert.ok(Math.abs(k - Math.round(k)) < 1e-6, `ball born ${k} bars after start`);
    await page.click('[data-testid="chamber-drop-sync"]');
    await page.click('[data-testid="chamber-clear"]');
  });

  test('EXPORT downloads the chamber JSON and IMPORT restores it', async () => {
    await page.keyboard.down('Shift');
    const box = (await page.locator('[data-testid="gravity-chamber"]').boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.15);
    await page.keyboard.up('Shift');
    const pegsBefore = await page.evaluate(() => window.tropicflowEngine.chamber.physics.getPegs().map((p) => p.id));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="chamber-export"]')]);
    const file = (await dl.path())!;
    const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { chamber: { physics: { pegs: unknown[] } } };
    assert.equal(json.chamber.physics.pegs.length, pegsBefore.length);

    await page.click('[data-testid="chamber-clear"]');
    await page.evaluate(() => window.tropicflowEngine.chamber.physics.removePeg(window.tropicflowEngine.chamber.physics.getPegs()[0].id));
    assert.equal(await page.evaluate(() => window.tropicflowEngine.chamber.physics.getPegs().length), pegsBefore.length - 1);
    await page.setInputFiles('[data-testid="chamber-import-input"]', file);
    await page.waitForFunction((n) => window.tropicflowEngine.chamber.physics.getPegs().length === n, pegsBefore.length);
    assert.deepEqual(await page.evaluate(() => window.tropicflowEngine.chamber.physics.getPegs().map((p) => p.id)), pegsBefore);
  });

  test('stopping the engine resets the clock; no page errors occurred', async () => {
    await page.click('text=STOP ENGINE');
    assert.equal(await page.evaluate(() => window.tropicflowEngine.clock.getIsPlaying()), false);
    assert.deepEqual(errors, []);
  });
});

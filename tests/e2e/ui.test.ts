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
import { inspectOggOpus } from '../../src/core/export/OggOpus.ts';
import type { ScoreEvent } from '../../src/core/render/RenderConfig.ts';
import { realtimeWasHealthy, type StepMargin } from './lib/realtime.ts';
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
    await page.goto(`http://localhost:${port}/?rack=full`);
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

  test('BOUNCE opens the export dialog; the WAV it saves verifies against the SCORE download', async () => {
    await page.click('[data-testid="bounce"]');
    await page.waitForSelector('[data-testid="export-modal"]');
    assert.match(await page.textContent('[data-testid="export-modal"]') ?? '', /BOUNCE 2 BARS/);
    const [wavDownload] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="export-run"]')]);
    assert.match(wavDownload.suggestedFilename(), /^tropicflow-\d+bpm-2bars\.wav$/);
    await page.waitForSelector('[data-testid="export-modal"]', { state: 'detached' });
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
    // Earlier tests unplugged the chamber -> drums cable: back to the full studio (RESET PATCH loads the smaller default rack).
    await page.evaluate(() => window.tropicflowEngine.loadPreset('full'));
    await page.waitForSelector('[data-testid="chamber-clear"]');
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

  // -------------------------------------------------------------------------
  // Live recording (REC checkbox) + export dialog
  // -------------------------------------------------------------------------

  type Captured = { time: number; track: string; frequency?: number; velocity: number; source: ScoreEvent['source'] };
  const takeInfo = () =>
    page.evaluate(() => {
      const t = window.tropicflowEngine.getLastTake();
      return t && { durationSeconds: t.durationSeconds, sampleRate: t.sampleRate, channels: t.channels.length, startContextTime: t.startContextTime, syncExact: t.syncExact, bpm: t.bpm, recordedAt: t.recordedAt };
    });

  test('REC + START records what you hear; STOP finalises a take whose notes verify against what was scheduled', async (t) => {
    await page.click('text=STOP ENGINE');
    await page.waitForTimeout(1500); // let the tape delay tail of the previous groove die out
    await page.evaluate(() => {
      (window as unknown as { __takeNotes: unknown[] }).__takeNotes = [];
      window.tropicflowEngine.subscribeNotes((n) =>
        (window as unknown as { __takeNotes: unknown[] }).__takeNotes.push({ time: n.time, track: n.track, frequency: n.frequency, velocity: n.velocity, source: n.source })
      );
      // Realtime health: how far ahead of the audio clock each step was scheduled. The clock
      // works 100 ms ahead on a 25 ms timer, so a margin near or below zero means the main
      // thread stalled and the note was played late through no fault of the engine.
      (window as unknown as { __margins: unknown[] }).__margins = [];
      window.tropicflowEngine.subscribeSteps((_s, audioTime) =>
        (window as unknown as { __margins: unknown[] }).__margins.push({ audioTime, margin: audioTime - window.tropicflowEngine.ctx.currentTime })
      );
    });
    assert.match((await page.textContent('[data-testid="rec-status"]')) ?? '', /NO TAKE/);
    await page.check('[data-testid="rec-arm"]');
    assert.equal(await page.evaluate(() => window.tropicflowEngine.isRecordArmed()), true);
    assert.match((await page.textContent('[data-testid="rec-status"]')) ?? '', /ARMED/);

    await page.click('text=START GROOVE');
    await page.waitForFunction(() => window.tropicflowEngine.recorder.isRecording());
    await page.waitForFunction(() => window.tropicflowEngine.recorder.getElapsedSeconds() > 2.5);
    assert.match((await page.textContent('[data-testid="rec-status"]')) ?? '', /00:0\d\s*\/ 01:00/);
    await page.click('text=STOP ENGINE');
    await page.waitForFunction(() => window.tropicflowEngine.getLastTake() !== null && !window.tropicflowEngine.recorder.isRecording());

    const take = (await takeInfo())!;
    assert.equal(take.channels, 2);
    assert.equal(take.syncExact, true, 'take origin measured from the sync marker');
    assert.ok(take.durationSeconds > 2 && take.durationSeconds < 10, `take length ${take.durationSeconds}`);
    assert.match((await page.textContent('[data-testid="rec-status"]')) ?? '', /TAKE 00:0\d/);

    // Export the whole take as 24-bit WAV through the dialog.
    await page.click('[data-testid="export-open"]');
    await page.waitForSelector('[data-testid="export-modal"]');
    assert.match((await page.textContent('[data-testid="export-modal"]')) ?? '', /LIVE TAKE/);
    await page.selectOption('[data-testid="export-bitdepth"]', '24');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="export-run"]')]);
    assert.match(dl.suggestedFilename(), /^tropicflow-take-\d+bpm-\d{8}-\d{4}-24bit\.wav$/);
    const wav = decodeWav(fs.readFileSync((await dl.path())!));
    assert.equal(wav.bitDepth, 24);
    assert.equal(wav.channels.length, 2);
    assert.equal(wav.channels[0].length, Math.round(take.durationSeconds * take.sampleRate));

    // The recording is sample-accurate: every note scheduled while it ran sits at
    // (scheduled time - take start + 6 ms compressor lookahead) in the file.
    const notes = await page.evaluate(() => (window as unknown as { __takeNotes: Captured[] }).__takeNotes);
    const busLatency = 0.006;
    const score: ScoreEvent[] = notes
      .map((n) => ({ ...n, time: n.time - take.startContextTime, audibleTime: n.time - take.startContextTime + busLatency }))
      // Skip the first 150 ms: the onset detector needs pre-roll before a hit.
      .filter((e) => e.audibleTime > 0.15 && e.audibleTime < take.durationSeconds - 0.1);
    assert.ok(score.length >= 16, `only ${score.length} notes fell inside the take`);
    const v = verifyScore(wav.channels, wav.sampleRate, score, { signal: 'master' });
    const margins = await page.evaluate(() => (window as unknown as { __margins: StepMargin[] }).__margins);
    // Judge the same window as the verification (the first step after START is excluded there too).
    const window_ = { from: take.startContextTime + 0.15 - busLatency, to: take.startContextTime + take.durationSeconds - 0.1 - busLatency };
    const judged = margins.filter((m) => m.audioTime >= window_.from && m.audioTime <= window_.to);
    const minMargin = Math.min(...judged.map((m) => m.margin));
    console.log(`    take: ${score.length} notes in ${take.durationSeconds.toFixed(2)} s, timing error mean ${v.meanAbsErrorMs.toFixed(2)} / max ${v.maxAbsErrorMs.toFixed(2)} ms; scheduling margin min ${(minMargin * 1000).toFixed(0)} ms over ${judged.length} steps`);
    if (!realtimeWasHealthy(t, margins, 'take verification', window_)) return;
    // A live take starts mid-pattern with tails ringing, so a band-level check may occasionally
    // miss a repeated note; alignment is what matters here (mean error well under a render quantum).
    assert.ok(v.failures.length <= 2, v.failures.map((f) => `${f.event.track}@${f.event.audibleTime.toFixed(3)}: ${f.reason}`).join('\n'));
    assert.ok(v.maxAbsErrorMs < 6, `max timing error ${v.maxAbsErrorMs.toFixed(2)} ms`);
    assert.ok(v.meanAbsErrorMs < 2, `mean timing error ${v.meanAbsErrorMs.toFixed(2)} ms`);
  });

  test('export dialog: a sub-range as OGG is a valid Ogg Opus file of the requested length', async () => {
    await page.click('[data-testid="export-open"]');
    await page.waitForSelector('[data-testid="export-modal"]');
    await page.click('[data-testid="format-ogg"]');
    await page.fill('[data-testid="export-start"]', '0.5');
    await page.fill('[data-testid="export-duration"]', '1');
    await page.selectOption('[data-testid="export-bitrate"]', '96');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="export-run"]')]);
    assert.match(dl.suggestedFilename(), /^tropicflow-take-\d+bpm-\d{8}-\d{4}-0\.5s-1s-96k\.ogg$/);
    const bytes = new Uint8Array(fs.readFileSync((await dl.path())!));

    const info = inspectOggOpus(bytes);
    assert.ok(info.pages.every((p) => p.crcOk), 'all page CRCs valid');
    assert.ok(info.pages[0].flags.bos && info.pages[info.pages.length - 1].flags.eos);
    assert.equal(info.head.channels, 2);
    assert.equal(info.head.inputSampleRate, 44100);
    assert.ok(info.head.preSkip > 0);
    assert.equal(info.audioPackets, 51); // 50 x 20 ms + the encoder's flush packet
    assert.ok(Math.abs(info.durationSeconds - 1) < 1e-6, `granule duration ${info.durationSeconds}`);
    // ~96 kb/s: 12 KB/s +- codec variance
    assert.ok(bytes.length > 7_000 && bytes.length < 20_000, `size ${bytes.length}`);

    // The browser's own demuxer/decoder must accept it too, and hear the trimmed length.
    const decoded = await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const ctx = new OfflineAudioContext(2, 48000, 48000);
      const audio = await ctx.decodeAudioData(buf.buffer);
      const ch = audio.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
      return { duration: audio.duration, channels: audio.numberOfChannels, peak };
    }, Buffer.from(bytes).toString('base64'));
    assert.equal(decoded.channels, 2);
    assert.ok(Math.abs(decoded.duration - 1) < 0.002, `decoded duration ${decoded.duration}`);
    assert.ok(decoded.peak > 0.05, 'decoded audio is not silent');
    await page.waitForSelector('[data-testid="export-modal"]', { state: 'detached' });
  });

  test('the MAX slider limits a take: recording stops by itself while the groove keeps playing', async () => {
    // The MAX slider (1-10 min) drives the recorder's limit.
    await page.fill('[data-testid="rec-max"]', '3');
    assert.equal(await page.evaluate(() => window.tropicflowEngine.recorder.getMaxSeconds()), 180);
    assert.match((await page.textContent('[data-testid="record-controls"]')) ?? '', /3 MIN/);

    // Use the API for a limit short enough to test.
    await page.evaluate(() => window.tropicflowEngine.recorder.setMaxSeconds(1.5));
    await page.click('text=START GROOVE');
    await page.waitForFunction(() => window.tropicflowEngine.recorder.isRecording());
    await page.waitForFunction(() => !window.tropicflowEngine.recorder.isRecording(), undefined, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.tropicflowEngine.clock.getIsPlaying()), true, 'groove keeps playing');
    const take = (await takeInfo())!;
    assert.ok(Math.abs(take.durationSeconds - 1.5) < 0.1, `take ${take.durationSeconds}s`);
    assert.match((await page.textContent('[data-testid="rec-status"]')) ?? '', /max length reached/);

    // Unticking REC while playing with the limit restored starts nothing; ticking starts a new take immediately.
    await page.evaluate(() => window.tropicflowEngine.recorder.setMaxSeconds(60));
    await page.uncheck('[data-testid="rec-arm"]');
    assert.equal(await page.evaluate(() => window.tropicflowEngine.recorder.isRecording()), false);
    await page.check('[data-testid="rec-arm"]');
    await page.waitForFunction(() => window.tropicflowEngine.recorder.isRecording());
    const armedAt = Date.now();
    await page.waitForTimeout(400);
    await page.uncheck('[data-testid="rec-arm"]');
    // The new take lasts as long as REC was ticked: ~0.4 s plus however long the browser took to
    // act on the clicks (on a loaded machine that can exceed a second), so judge it against the
    // measured wall time rather than a fixed limit.
    const armedFor = (Date.now() - armedAt) / 1000;
    await page.waitForFunction(
      (firstAt) => !window.tropicflowEngine.recorder.isRecording() && window.tropicflowEngine.getLastTake()!.recordedAt !== firstAt,
      take.recordedAt
    );
    const second = (await takeInfo())!;
    assert.ok(second.durationSeconds > 0.3 && second.durationSeconds <= armedFor + 0.3, `second take ${second.durationSeconds}s (REC was ticked for ${armedFor.toFixed(2)} s) replaced the first`);
  });

  test('OGG fallback without WebCodecs (MediaRecorder, realtime) is valid and sample-aligned with the take', async () => {
    // A fresh take of 2+ s (the groove is still playing).
    await page.check('[data-testid="rec-arm"]');
    await page.waitForFunction(() => window.tropicflowEngine.recorder.getElapsedSeconds() > 2);
    await page.uncheck('[data-testid="rec-arm"]');
    await page.waitForFunction(() => !window.tropicflowEngine.recorder.isRecording() && window.tropicflowEngine.getLastTake()!.durationSeconds > 1.9);
    await page.evaluate(() => {
      (window as unknown as { __AudioEncoder: unknown }).__AudioEncoder = (window as unknown as { AudioEncoder: unknown }).AudioEncoder;
      (window as unknown as { AudioEncoder: unknown }).AudioEncoder = undefined;
    });
    await page.click('[data-testid="export-open"]');
    await page.waitForSelector('[data-testid="export-modal"]');
    await page.click('[data-testid="format-ogg"]');
    assert.match((await page.textContent('[data-testid="format-ogg"]')) ?? '', /realtime/);
    await page.fill('[data-testid="export-start"]', '0.3');
    await page.fill('[data-testid="export-duration"]', '0.8');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('[data-testid="export-run"]')]);
    assert.match(dl.suggestedFilename(), /-0\.3s-0\.8s-\d+k\.ogg$/);
    const bytes = new Uint8Array(fs.readFileSync((await dl.path())!));
    const info = inspectOggOpus(bytes);
    assert.ok(info.pages.every((p) => p.crcOk));
    assert.ok(Math.abs(info.durationSeconds - 0.8) < 1e-6, `granule duration ${info.durationSeconds}`);
    assert.ok(info.head.preSkip > 312 && info.head.preSkip <= 65535, `pre-skip ${info.head.preSkip} hides the sync lead-in`);
    await page.waitForSelector('[data-testid="export-modal"]', { state: 'detached' });

    // Decode in the browser at the take's rate and cross-correlate with the raw take slice.
    const aligned = await page.evaluate(
      async ({ b64, start, duration }) => {
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const take = window.tropicflowEngine.getLastTake()!;
        const sr = take.sampleRate;
        const audio = await new OfflineAudioContext(2, 1, sr).decodeAudioData(buf.buffer);
        const dec = audio.getChannelData(0);
        const ref = take.channels[0].subarray(Math.round(start * sr), Math.round((start + duration) * sr));
        const maxLag = Math.round(0.02 * sr);
        let best = -Infinity;
        let bestLag = 0;
        let ea = 0;
        let eb = 0;
        for (let i = 0; i < ref.length; i++) {
          ea += ref[i] * ref[i];
          eb += (dec[i] ?? 0) * (dec[i] ?? 0);
        }
        for (let lag = -maxLag; lag <= maxLag; lag++) {
          let acc = 0;
          for (let i = Math.max(0, -lag); i < Math.min(ref.length, dec.length - lag); i++) acc += ref[i] * dec[i + lag];
          const c = acc / Math.sqrt(ea * eb);
          if (c > best) {
            best = c;
            bestLag = lag;
          }
        }
        return { decodedSeconds: audio.duration, corr: best, lagMs: (bestLag / sr) * 1000 };
      },
      { b64: Buffer.from(bytes).toString('base64'), start: 0.3, duration: 0.8 }
    );
    console.log(`    fallback ogg: decoded ${aligned.decodedSeconds.toFixed(3)} s, corr ${aligned.corr.toFixed(3)}, lag ${aligned.lagMs.toFixed(2)} ms`);
    assert.ok(Math.abs(aligned.decodedSeconds - 0.8) < 0.002);
    assert.ok(aligned.corr > 0.9, `correlation ${aligned.corr}`);
    assert.ok(Math.abs(aligned.lagMs) < 2, `lag ${aligned.lagMs} ms`);
    await page.evaluate(() => {
      (window as unknown as { AudioEncoder: unknown }).AudioEncoder = (window as unknown as { __AudioEncoder: unknown }).__AudioEncoder;
    });
  });

  test('export dialog: ABORT during a realtime encode stops it, Escape closes the dialog when idle', async () => {
    await page.evaluate(() => {
      (window as unknown as { __AudioEncoder: unknown }).__AudioEncoder = (window as unknown as { AudioEncoder: unknown }).AudioEncoder;
      (window as unknown as { AudioEncoder: unknown }).AudioEncoder = undefined;
    });
    await page.click('[data-testid="export-open"]');
    await page.waitForSelector('[data-testid="export-modal"]');
    await page.click('[data-testid="format-ogg"]');
    await page.click('[data-testid="export-all"]').catch(() => undefined); // already whole take -> no button
    await page.click('[data-testid="export-run"]');
    await page.waitForSelector('[data-testid="export-progress"]');
    assert.match((await page.textContent('[data-testid="export-cancel"]')) ?? '', /ABORT/);
    assert.ok(await page.isDisabled('[data-testid="export-run"]'));
    let downloaded = false;
    page.once('download', () => {
      downloaded = true;
    });
    await page.click('[data-testid="export-cancel"]');
    await page.waitForSelector('[data-testid="export-progress"]', { state: 'detached' });
    assert.match((await page.textContent('[data-testid="export-cancel"]')) ?? '', /CANCEL/);
    assert.ok(await page.isEnabled('[data-testid="export-run"]'), 'dialog is back to idle');
    await page.waitForTimeout(1500);
    assert.equal(downloaded, false, 'an aborted export must not download');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="export-modal"]', { state: 'detached' });
    await page.evaluate(() => {
      (window as unknown as { AudioEncoder: unknown }).AudioEncoder = (window as unknown as { __AudioEncoder: unknown }).__AudioEncoder;
    });
  });

  test('without AudioWorklet (insecure context) REC is disabled with an explanation instead of recording unreliably', async () => {
    const port = (server.address() as { port: number }).port;
    const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const p2 = await ctx2.newPage();
    try {
      await p2.addInitScript(() => {
        Object.defineProperty(BaseAudioContext.prototype, 'audioWorklet', { configurable: true, get: () => undefined });
        (window as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = undefined;
      });
      await p2.goto(`http://localhost:${port}/?rack=full`);
      await p2.waitForFunction(() => typeof window.tropicflowEngine !== 'undefined');
      assert.ok(await p2.isDisabled('[data-testid="rec-arm"]'));
      assert.match((await p2.textContent('[data-testid="rec-status"]')) ?? '', /NO AUDIOWORKLET/);
      assert.match((await p2.getAttribute('[data-testid="record-controls"] label', 'title')) ?? '', /AudioWorklet/);
      // The export dialog (bounce) keeps working regardless.
      await p2.click('[data-testid="bounce"]');
      await p2.waitForSelector('[data-testid="export-modal"]');
      assert.ok(await p2.isEnabled('[data-testid="format-ogg"]'));
    } finally {
      await ctx2.close();
    }
  });

  test('stopping the engine resets the clock; no page errors occurred', async () => {
    await page.click('text=STOP ENGINE');
    assert.equal(await page.evaluate(() => window.tropicflowEngine.clock.getIsPlaying()), false);
    assert.deepEqual(errors, []);
  });
});

/**
 * Hardware bridge UI end-to-end tests: the MIDI BRIDGE module driven by the
 * computer keyboard, on-screen keys, a fake Web MIDI device and raw-byte
 * injection, verified against the audio the engine actually produced.
 *
 * Same skeleton as ui.test.ts: serves the production build in headless
 * Chromium, skips when there is no build.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { launchChromium } from '../../scripts/lib/launchBrowser.mjs';
import { decodeWav } from '../../src/core/render/WavCodec.ts';
import { verifyScore } from '../../src/core/analysis/AudioAnalysis.ts';
import { realtimeWasHealthy, type StepMargin } from './lib/realtime.ts';
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

/**
 * A fake Web MIDI implementation installed before the app loads. Real Web
 * MIDI cannot run in CI containers (no MIDI service), so device handling is
 * exercised through this; `__fakeMidi.input.send(bytes, ts)` emits a
 * `midimessage` with a chosen DOM timestamp.
 */
const FAKE_MIDI_INIT = () => {
  class FakeInput extends EventTarget {
    id: string;
    name: string;
    manufacturer = 'tropicflow-test';
    state = 'connected';
    type = 'input';
    onmidimessage: ((e: MIDIMessageEvent) => void) | null = null;
    constructor(id: string, name: string) {
      super();
      this.id = id;
      this.name = name;
    }
    send(bytes: number[], ts: number = performance.now()) {
      const e = new MIDIMessageEvent('midimessage', { data: new Uint8Array(bytes) });
      Object.defineProperty(e, 'timeStamp', { value: ts });
      this.onmidimessage?.(e);
      this.dispatchEvent(e);
    }
  }
  const input = new FakeInput('fake-1', 'Fake Keys');
  const access = {
    inputs: new Map<string, FakeInput>([[input.id, input]]),
    outputs: new Map(),
    onstatechange: null as ((e: unknown) => void) | null,
    sysexEnabled: false,
    plug(id: string, name: string) {
      const i = new FakeInput(id, name);
      this.inputs.set(id, i);
      this.onstatechange?.({ port: i });
      return i;
    },
    unplug(id: string) {
      this.inputs.delete(id);
      this.onstatechange?.({});
    },
  };
  (navigator as unknown as { requestMIDIAccess: () => Promise<unknown> }).requestMIDIAccess = async () => access;
  (window as unknown as { __fakeMidi: unknown }).__fakeMidi = { input, access, FakeInput };
};

type FakeMidiWindow = Window & {
  __fakeMidi: {
    input: { send(bytes: number[], ts?: number): void };
    access: { plug(id: string, name: string): { send(bytes: number[], ts?: number): void }; unplug(id: string): void };
  };
};

const hasBuild = fs.existsSync(path.join(DIST, 'index.html'));

describe('hardware bridge UI (built app in headless Chromium)', { skip: hasBuild ? false : `no build at ${DIST}; run "npm run build" first` }, () => {
  let server: http.Server;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let port: number;
  const errors: string[] = [];

  const open = async (ctx: BrowserContext) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
    });
    await p.goto(`http://localhost:${port}/?rack=full`);
    await p.waitForFunction(() => typeof window.tropicflowInput !== 'undefined');
    return p;
  };

  before(async () => {
    server = await serve(DIST);
    port = (server.address() as { port: number }).port;
    ({ browser } = await launchChromium(chromium, { args: ['--autoplay-policy=no-user-gesture-required'] }));
    context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
    await context.grantPermissions(['midi']);
    page = await open(context);
  });

  after(async () => {
    await browser?.close();
    server?.close();
  });

  const patchIds = () => page.evaluate(() => window.tropicflowEngine.getPatch().map((c) => `${c.fromPortId}->${c.toPortId}`));
  /** Poll for a data attribute (React re-renders after the click resolves). */
  const waitAttr = (p: Page, selector: string, attr: string, value: string) =>
    p.waitForFunction(([sel, a, v]) => document.querySelector(sel)?.getAttribute(a) === v, [selector, attr, value] as const, { timeout: 3000 });
  const held = () => page.evaluate(() => window.tropicflowEngine.synth.heldCount());
  const lastNote = () => page.evaluate(() => window.tropicflowEngine.input.getActivity().lastNote?.note ?? null);

  // -------------------------------------------------------------------------
  // Computer keyboard
  // -------------------------------------------------------------------------

  test('the MIDI BRIDGE module is on the canvas with GATE OUT patched to the marimba; the soundboard chips mirror the cables', async () => {
    assert.ok(await page.isVisible('[data-testid="module-midi-1"]'));
    assert.ok((await patchIds()).includes('midi-gate-out->mrm-trig-in'));
    assert.equal(await page.getAttribute('[data-testid="keys-target-marimba"]', 'data-on'), 'true');
    assert.equal(await page.getAttribute('[data-testid="keys-target-synth"]', 'data-on'), 'false');
    assert.match((await page.textContent('[data-testid="midi-enable"]')) ?? '', /MIDI OFF/);
    assert.match((await page.textContent('[data-testid="midi-keys-toggle"]')) ?? '', /KEYS ON/);
  });

  test('the soundboard SYNTH chip plugs GATE OUT into the synth; the canvas and engine follow', async () => {
    await page.click('[data-testid="keys-target-synth"]');
    await waitAttr(page, '[data-testid="keys-target-synth"]', 'data-on', 'true');
    assert.ok((await patchIds()).includes('midi-gate-out->syn-gate-in'));
    assert.equal(await page.evaluate(() => window.tropicflowEngine.isTriggerTarget('synth', 'midi')), true);
    // Unplugging on the canvas (double-click the jack) turns the chip off again; re-plug via the chip.
    await page.dblclick('[data-port-id="syn-gate-in"]');
    await waitAttr(page, '[data-testid="keys-target-synth"]', 'data-on', 'false');
    await page.click('[data-testid="keys-target-synth"]');
    await waitAttr(page, '[data-testid="keys-target-synth"]', 'data-on', 'true');
    assert.ok((await patchIds()).includes('midi-gate-out->syn-gate-in'));
  });

  test('computer keys: key down holds a synth note and lights the key, key up releases it; notes are logged with source midi', async () => {
    await page.evaluate(() => {
      (window as unknown as { __notes: unknown[] }).__notes = [];
      window.tropicflowEngine.subscribeNotes((n) => (window as unknown as { __notes: unknown[] }).__notes.push({ time: n.time, track: n.track, frequency: n.frequency, velocity: n.velocity, source: n.source }));
    });
    await page.keyboard.down('a');
    assert.equal(await held(), 1);
    assert.equal(await lastNote(), 48);
    await waitAttr(page, '[data-testid="key-KeyA"]', 'data-active', 'true');
    assert.equal(await page.getAttribute('[data-testid="key-KeyA"]', 'data-note'), '48');
    assert.match((await page.textContent('[data-testid="midi-last-note"]')) ?? '', /C3 v102/);
    await page.keyboard.up('a');
    assert.equal(await held(), 0);
    await waitAttr(page, '[data-testid="key-KeyA"]', 'data-active', 'false');
    const notes = await page.evaluate(() => (window as unknown as { __notes: Array<{ track: string; source: string; frequency: number; velocity: number }> }).__notes);
    assert.deepEqual(notes.map((n) => `${n.source}:${n.track}`).sort(), ['midi:marimba', 'midi:synth']);
    assert.ok(notes.every((n) => Math.abs(n.frequency - 130.81) < 0.01 && Math.abs(n.velocity - 0.8) < 1e-9));
  });

  test('computer keys: octave / velocity / accent keys change the next note; the panel shows the state', async () => {
    await page.keyboard.press('x');
    assert.equal(await page.textContent('[data-testid="keys-octave"]'), '+1');
    assert.equal(await page.getAttribute('[data-testid="key-KeyA"]', 'data-note'), '60');
    await page.keyboard.press('v');
    assert.equal(await page.textContent('[data-testid="keys-velocity"]'), '90%');
    await page.keyboard.down('Shift');
    await page.keyboard.down('s');
    const activity = await page.evaluate(() => ({ ...window.tropicflowEngine.input.getActivity().lastNote }));
    assert.equal(activity.note, 62);
    assert.equal(activity.velocity, 1, 'accent clamps 0.9 + 0.25 to 1');
    await page.keyboard.up('s');
    await page.keyboard.up('Shift');
    await page.keyboard.press('z');
    await page.keyboard.press('c');
    assert.equal(await page.textContent('[data-testid="keys-octave"]'), '0');
    assert.equal(await page.textContent('[data-testid="keys-velocity"]'), '80%');
    // Arrow keys drive the mod wheel / bend without scrolling the page.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.down('ArrowRight');
    const controls = await page.evaluate(() => Object.fromEntries(window.tropicflowEngine.input.getActivity().controls));
    assert.equal(controls.mod, 0.1);
    assert.equal(controls.bend, 1);
    await page.keyboard.up('ArrowRight');
    assert.equal(await page.evaluate(() => window.tropicflowEngine.input.getActivity().controls.get('bend')), 0);
    await page.keyboard.press('ArrowDown');
  });

  test('cv: the mod wheel keys open the synth cutoff, bend keys bend held notes and transpose new ones, per the cables', async () => {
    // Default patch: MOD CV -> CUTOFF CV, PITCH CV -> synth PITCH CV (not the marimba).
    const cutoff = () => page.evaluate(() => ({ base: window.tropicflowEngine.synth.getParams().filterCutoff, mod: window.tropicflowEngine.synth.getCutoffModulation(), eff: window.tropicflowEngine.synth.effectiveCutoff() }));
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    let c = await cutoff();
    assert.ok(Math.abs(c.mod - 0.6) < 1e-9, `0.2 mod = 0.6 octaves, got ${c.mod}`);
    assert.ok(Math.abs(c.eff - c.base * Math.pow(2, 0.6)) < 1e-6);
    assert.match((await page.textContent('[data-testid="midi-cv-mod"]')) ?? '', /20%/);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    c = await cutoff();
    assert.equal(c.mod, 0);

    await page.evaluate(() => {
      (window as unknown as { __cvNotes: unknown[] }).__cvNotes = [];
      window.tropicflowEngine.subscribeNotes((n) => (window as unknown as { __cvNotes: unknown[] }).__cvNotes.push({ track: n.track, frequency: n.frequency }));
    });
    // Hold a note, bend up: the held synth voice bends (pitch offset = +bend range), the marimba is untouched.
    await page.keyboard.down('a');
    await page.keyboard.down('ArrowRight');
    assert.equal(await page.evaluate(() => window.tropicflowEngine.synth.getPitchOffset()), 2);
    assert.match((await page.textContent('[data-testid="midi-cv-bend"]')) ?? '', /2\.0st/);
    // A new note while bent is transposed on the synth only.
    await page.keyboard.down('s');
    const notes = await page.evaluate(() => (window as unknown as { __cvNotes: Array<{ track: string; frequency: number }> }).__cvNotes);
    const d3 = 440 * Math.pow(2, (50 - 69) / 12);
    const bySynth = notes.filter((n) => n.track === 'synth').map((n) => n.frequency);
    const byMarimba = notes.filter((n) => n.track === 'marimba').map((n) => n.frequency);
    assert.ok(Math.abs(bySynth[1] - d3 * Math.pow(2, 2 / 12)) < 1e-6, `bent synth note ${bySynth[1]}`);
    assert.ok(Math.abs(byMarimba[1] - d3) < 1e-6, `marimba unbent ${byMarimba[1]}`);
    await page.keyboard.up('ArrowRight');
    assert.equal(await page.evaluate(() => window.tropicflowEngine.synth.getPitchOffset()), 0);
    await page.keyboard.up('a');
    await page.keyboard.up('s');
    assert.equal(await held(), 0);

    // Unplug the mod cable on the canvas: the wheel no longer reaches the filter.
    await page.dblclick('[data-port-id="syn-filter-cv"]');
    await page.keyboard.press('ArrowUp');
    assert.equal((await cutoff()).mod, 0);
    await page.keyboard.press('ArrowDown');
    // Plug it back by dragging the cable (RESET PATCH would also drop the synth gate cable the next tests use).
    const from = (await page.locator('[data-port-id="midi-mod-cv"]').boundingBox())!;
    const to = (await page.locator('[data-port-id="syn-filter-cv"]').boundingBox())!;
    await page.mouse.move(from.x + 8, from.y + 8);
    await page.mouse.down();
    await page.mouse.move(to.x + 8, to.y + 8, { steps: 10 });
    await page.mouse.up();
    assert.ok((await patchIds()).includes('midi-mod-cv->syn-filter-cv'));
    await page.keyboard.press('ArrowUp');
    assert.ok(Math.abs((await cutoff()).mod - 0.3) < 1e-9);
    await page.keyboard.press('ArrowDown');
  });

  test('computer keys: typing into a form field or a disabled KEYS device does not play', async () => {
    await page.focus('input[type="range"]');
    await page.keyboard.down('a');
    assert.equal(await held(), 0);
    await page.keyboard.up('a');
    await page.click('body');
    await page.click('[data-testid="midi-keys-toggle"]');
    assert.match((await page.textContent('[data-testid="midi-keys-toggle"]')) ?? '', /KEYS OFF/);
    await page.keyboard.down('a');
    assert.equal(await held(), 0);
    await page.keyboard.up('a');
    await page.click('[data-testid="midi-keys-toggle"]');
    assert.match((await page.textContent('[data-testid="midi-keys-toggle"]')) ?? '', /KEYS ON/);
  });

  test('on-screen keys: mouse down/up plays through the same device as the physical keys', async () => {
    const box = (await page.locator('[data-testid="key-KeyD"]').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 6);
    await page.mouse.down();
    assert.equal(await held(), 1);
    assert.equal(await lastNote(), 52);
    await waitAttr(page, '[data-testid="key-KeyD"]', 'data-active', 'true');
    await page.mouse.up();
    assert.equal(await held(), 0);
  });

  // -------------------------------------------------------------------------
  // Web MIDI
  // -------------------------------------------------------------------------

  test('real Web MIDI in this environment: enabling reports a readable status and never hangs or crashes', async () => {
    await page.click('[data-testid="midi-enable"]');
    await page.waitForFunction(() => window.tropicflowInput.midi.getStatus().state !== 'requesting', undefined, { timeout: 10000 });
    const status = await page.evaluate(() => ({ ...window.tropicflowInput.midi.getStatus() }));
    assert.ok(['ready', 'denied', 'error'].includes(status.state), status.state);
    assert.ok(status.message.length > 10, status.message);
    console.log(`    real Web MIDI here: ${status.state} - ${status.message}`);
    if (status.state === 'ready') await page.click('[data-testid="midi-enable"]');
    assert.match((await page.textContent('[data-testid="midi-enable"]')) ?? '', /MIDI OFF/);
  });

  test('fake Web MIDI device: enable lists it, messages play notes and light the keys, hot-plug and channel filter work', async () => {
    const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const p2 = await ctx2.newPage();
    try {
      await p2.addInitScript(FAKE_MIDI_INIT);
      p2.on('pageerror', (e) => errors.push(e.message));
      await p2.goto(`http://localhost:${port}/?rack=full`);
      await p2.waitForFunction(() => typeof window.tropicflowInput !== 'undefined');
      await p2.click('[data-testid="midi-enable"]');
      await p2.waitForFunction(() => window.tropicflowInput.midi.getStatus().state === 'ready');
      // While MIDI is on the status lives in the input selector's tooltip (the row replaces the status line).
      assert.match((await p2.getAttribute('[data-testid="midi-input"]', 'title')) ?? '', /listening to Fake Keys/);
      assert.deepEqual(await p2.locator('[data-testid="midi-input"] option').allTextContents(), ['ALL INPUTS (1)', 'Fake Keys']);

      await p2.evaluate(() => {
        (window as unknown as { __midiNotes: unknown[] }).__midiNotes = [];
        window.tropicflowEngine.subscribeNotes((n) => {
          if (n.source === 'midi') (window as unknown as { __midiNotes: unknown[] }).__midiNotes.push({ track: n.track, frequency: n.frequency, velocity: n.velocity });
        });
        (window as unknown as FakeMidiWindow).__fakeMidi.input.send([0x90, 60, 127]);
      });
      assert.equal(await p2.evaluate(() => window.tropicflowEngine.input.getActivity().lastNote?.device), 'midi:fake-1');
      await waitAttr(p2, '[data-testid="key-KeyK"]', 'data-active', 'true'); // C4 from the MIDI device lights the on-screen key
      assert.match((await p2.textContent('[data-testid="midi-last-note"]')) ?? '', /C4 v127/);
      await p2.evaluate(() => (window as unknown as FakeMidiWindow).__fakeMidi.input.send([0x80, 60, 0]));
      await waitAttr(p2, '[data-testid="key-KeyK"]', 'data-active', 'false');
      const notes = await p2.evaluate(() => (window as unknown as { __midiNotes: Array<{ track: string; frequency: number; velocity: number }> }).__midiNotes);
      assert.deepEqual(notes, [{ track: 'marimba', frequency: 440 * Math.pow(2, -9 / 12), velocity: 1 }]);

      // GM kick key with the drums patched: the kick fires.
      await p2.click('[data-testid="keys-target-drums"]');
      await p2.evaluate(() => (window as unknown as FakeMidiWindow).__fakeMidi.input.send([0x99, 36, 100]));
      const tracks = await p2.evaluate(() => (window as unknown as { __midiNotes: Array<{ track: string }> }).__midiNotes.map((n) => n.track));
      assert.deepEqual(tracks, ['marimba', 'marimba', 'kick']);

      // Hot-plug a second device and filter to it.
      await p2.evaluate(() => (window as unknown as FakeMidiWindow).__fakeMidi.access.plug('fake-2', 'Pad Controller'));
      await p2.waitForFunction(() => document.querySelectorAll('[data-testid="midi-input"] option').length === 3);
      assert.deepEqual(await p2.locator('[data-testid="midi-input"] option').allTextContents(), ['ALL INPUTS (2)', 'Fake Keys', 'Pad Controller']);
      await p2.selectOption('[data-testid="midi-input"]', 'fake-2');
      await p2.selectOption('[data-testid="midi-channel"]', '10');
      await p2.evaluate(() => (window as unknown as FakeMidiWindow).__fakeMidi.input.send([0x99, 38, 100])); // fake-1: deselected
      assert.equal((await p2.evaluate(() => (window as unknown as { __midiNotes: unknown[] }).__midiNotes.length)), 3);
      await p2.evaluate(() => {
        const w = window as unknown as FakeMidiWindow & { __pad?: { send(b: number[]): void } };
        w.__pad = w.__fakeMidi.access.plug('fake-3', 'Other');
      });
      await p2.evaluate(() => (window as unknown as FakeMidiWindow).__fakeMidi.access.unplug('fake-3'));
      await p2.waitForFunction(() => window.tropicflowInput.midi.getStatus().inputs.length === 2);
      await p2.evaluate(() => (window as unknown as FakeMidiWindow).__fakeMidi.access.unplug('fake-2'));
      await p2.waitForFunction(() => /not connected/.test(document.querySelector('[data-testid="midi-input"]')?.getAttribute('title') ?? ''));
      await p2.click('[data-testid="midi-enable"]');
      assert.equal(await p2.evaluate(() => window.tropicflowInput.midi.getStatus().state), 'idle');
    } finally {
      await ctx2.close();
    }
  });

  // -------------------------------------------------------------------------
  // Timing: what was played is what was recorded, with a constant latency
  // -------------------------------------------------------------------------

  type Captured = { time: number; track: string; frequency?: number; velocity: number; source: ScoreEvent['source'] };

  test('a performance injected while recording is in the take at its scheduled times, with a constant input latency', async (t) => {
    await page.click('[data-testid="keys-target-synth"]'); // synth off: marimba only, for a clean onset check
    // An empty pattern and a dry mix: the take then contains nothing but the performance, so the
    // in-mix verifier can be held to zero failures (stems with the groove are proven in render.test.ts).
    await page.evaluate(() => {
      const empty = () => new Array(16).fill(false) as boolean[];
      window.tropicflowEngine.setPattern({ kick: empty(), snare: empty(), hihat: empty(), marimba: empty(), synth: empty() });
      window.tropicflowEngine.delay.setMix(0);
      (window as unknown as { __margins: unknown[] }).__margins = [];
      window.tropicflowEngine.subscribeSteps((_s, audioTime) =>
        (window as unknown as { __margins: unknown[] }).__margins.push({ audioTime, margin: audioTime - window.tropicflowEngine.ctx.currentTime })
      );
      (window as unknown as { __takeNotes: unknown[] }).__takeNotes = [];
      window.tropicflowEngine.subscribeNotes((n) =>
        (window as unknown as { __takeNotes: unknown[] }).__takeNotes.push({ time: n.time, track: n.track, frequency: n.frequency, velocity: n.velocity, source: n.source })
      );
    });
    await page.check('[data-testid="rec-arm"]');
    await page.click('text=START GROOVE');
    await page.waitForFunction(() => window.tropicflowEngine.recorder.isRecording() && window.tropicflowInput.mapper.hasSample());
    await page.waitForTimeout(400);

    // Eight notes 250 ms apart, each stamped with the DOM time at which it was "received".
    const sent = await page.evaluate(async () => {
      const out: Array<{ perf: number; mapped: number; scheduled: number; now: number; offset: number }> = [];
      const notes = [60, 62, 64, 65, 67, 69, 71, 72];
      for (const note of notes) {
        const perf = performance.now();
        const now = window.tropicflowEngine.ctx.currentTime;
        const [on] = window.tropicflowInput.send([0x90, note, 110], perf);
        // stamp() refreshes the mapper's sample, so read the mapping it actually used afterwards.
        const mapped = window.tropicflowInput.mapper.toContextTime(perf)!;
        out.push({ perf, mapped, scheduled: on.time, now, offset: window.tropicflowInput.mapper.offset()! });
        window.tropicflowInput.send([0x80, note, 0], perf + 120);
        await new Promise((r) => setTimeout(r, 250));
      }
      return { out, latency: window.tropicflowInput.effectiveLatency() };
    });
    await page.waitForTimeout(600);
    await page.click('text=STOP ENGINE');
    await page.waitForFunction(() => window.tropicflowEngine.getLastTake() !== null && !window.tropicflowEngine.recorder.isRecording());
    await page.uncheck('[data-testid="rec-arm"]');

    const margins = await page.evaluate(() => (window as unknown as { __margins: StepMargin[] }).__margins);
    // Scheduling policy: scheduled = mapped + effective latency, never earlier than now.
    const offsets = sent.out.map((s) => s.scheduled - s.mapped);
    const clamped = sent.out.filter((s) => s.scheduled === s.now).length;
    const spread = Math.max(...offsets) - Math.min(...offsets);
    console.log(`    input latency ${(sent.latency * 1000).toFixed(1)} ms; scheduled-mapped ${offsets.map((o) => (o * 1000).toFixed(1)).join('/')} ms; ${clamped} clamped to now`);
    const drift = sent.out.map((o) => ((o.now - sent.out[0].now) - (o.perf - sent.out[0].perf) / 1000) * 1000);
    console.log(`    audio clock vs wall clock drift per note: ${drift.map((d) => d.toFixed(1)).join('/')} ms; mapper offset change: ${sent.out.map((o) => ((o.offset - sent.out[0].offset) * 1000).toFixed(1)).join('/')} ms`);
    assert.ok(sent.latency >= 0.02 && sent.latency < 0.2, `effective latency ${sent.latency}`);
    for (const o of offsets) assert.ok(o >= sent.latency - 1e-6, `an event was scheduled earlier than the policy allows (${o})`);
    // Judge the stretch in which the notes were sent (from the first to the last note).
    if (!realtimeWasHealthy(t, margins, 'input latency / take verification', { from: sent.out[0].now, to: sent.out[sent.out.length - 1].scheduled })) return;
    assert.ok(clamped <= 2, `${clamped} of 8 events were late (main thread stalled); latency policy not holding`);
    assert.ok(spread < 0.015, `latency jitter ${(spread * 1000).toFixed(1)} ms`);

    // The notes are in the take where they were scheduled (marimba only: one onset per note).
    const take = (await page.evaluate(() => {
      const t = window.tropicflowEngine.getLastTake()!;
      return { durationSeconds: t.durationSeconds, sampleRate: t.sampleRate, startContextTime: t.startContextTime, channels: t.channels.map((c) => Array.from(c)) };
    }))!;
    const notes = (await page.evaluate(() => (window as unknown as { __takeNotes: Captured[] }).__takeNotes)).filter((n) => n.source === 'midi');
    assert.equal(notes.length, 8);
    const busLatency = 0.006;
    const score: ScoreEvent[] = notes.map((n) => ({ ...n, time: n.time - take.startContextTime, audibleTime: n.time - take.startContextTime + busLatency }));
    const channels = take.channels.map((c) => Float32Array.from(c));
    const v = verifyScore(channels, take.sampleRate, score, { signal: 'master' });
    console.log(`    take: ${score.length} midi notes, timing error mean ${v.meanAbsErrorMs.toFixed(2)} / max ${v.maxAbsErrorMs.toFixed(2)} ms`);
    assert.equal(v.failures.length, 0, v.failures.map((f) => `${f.event.track}@${f.event.audibleTime.toFixed(3)}: ${f.reason}`).join('\n'));
    assert.ok(v.meanAbsErrorMs < 2, `mean timing error ${v.meanAbsErrorMs.toFixed(2)} ms`);
    // Wall-clock spacing of the performance vs. scheduled spacing: on real hardware these agree to
    // ~0.1 ms (the policy's whole point). Headless Chromium's fake audio sink underruns under load
    // (the output timestamp steps ~10-20 ms against the wall clock every few hundred ms), which no
    // mapping can hide, so here the spacing is reported, not judged. Judged above instead: the
    // constant offset policy and the take verifying against the schedule.
    const report = notes.slice(1).map((n, i) => {
      const scheduledGap = n.time - notes[i].time;
      const stampedGap = (sent.out[i + 1].perf - sent.out[i].perf) / 1000;
      return ((scheduledGap - stampedGap) * 1000).toFixed(1);
    });
    t.diagnostic(`scheduled-minus-stamped spacing per interval: ${report.join('/')} ms (expect ~0 on real hardware; this machine's audio clock stalls)`);
  });

  // -------------------------------------------------------------------------
  // Performance log: replay and bounce
  // -------------------------------------------------------------------------

  test('the performance was logged relative to the groove start; REPLAY plays it again; BOUNCE renders it and the WAV verifies', async () => {
    const logged = await page.evaluate(() => window.tropicflowEngine.input.log.toScript());
    assert.equal(logged.events.filter((e) => e.kind === 'noteOn').length, 8);
    assert.ok(logged.events.every((e) => e.time >= 0));
    assert.match((await page.textContent('[data-testid="midi-log-count"]')) ?? '', /LOG (1[6-9]|[2-9]\d)/);

    // Replay (engine stopped): the same 8 note-ons come back, 250 ms apart.
    await page.evaluate(() => {
      (window as unknown as { __replayNotes: number[] }).__replayNotes = [];
      window.tropicflowEngine.subscribeNotes((n) => {
        if (n.source === 'midi' && n.track === 'marimba') (window as unknown as { __replayNotes: number[] }).__replayNotes.push(n.time);
      });
    });
    await page.click('[data-testid="midi-replay"]');
    await waitAttr(page, '[data-testid="midi-replay"]', 'data-replaying', 'true');
    await page.waitForFunction(() => !window.tropicflowInput.isReplaying(), undefined, { timeout: 10000 });
    const replayed = await page.evaluate(() => (window as unknown as { __replayNotes: number[] }).__replayNotes);
    assert.equal(replayed.length, 8);
    const loggedOns = logged.events.filter((e) => e.kind === 'noteOn').map((e) => e.time);
    for (let i = 1; i < 8; i++) assert.ok(Math.abs(replayed[i] - replayed[0] - (loggedOns[i] - loggedOns[0])) < 1e-6, 'replay keeps the exact spacing');

    // Bounce: the score download contains the performance and the WAV verifies against it.
    await page.click('[data-testid="bounce"]');
    await page.waitForSelector('[data-testid="export-modal"]');
    const [wavDownload] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="export-run"]')]);
    await page.waitForSelector('[data-testid="export-modal"]', { state: 'detached' });
    const wav = decodeWav(fs.readFileSync((await wavDownload.path())!));
    const [scoreDownload] = await Promise.all([page.waitForEvent('download'), page.click('text=SCORE')]);
    const scoreFile = JSON.parse(fs.readFileSync((await scoreDownload.path())!, 'utf8')) as { config: { inputScript?: { events: unknown[] } }; score: ScoreEvent[] };
    assert.equal(scoreFile.config.inputScript?.events.length, logged.events.length, 'the bounce config carries the performance');
    const midiInBounce = scoreFile.score.filter((e) => e.source === 'midi');
    const patternEnd = (60 / 118) * 16 * 2;
    assert.equal(midiInBounce.length, loggedOns.filter((t) => t < patternEnd + 1).length, 'every logged note inside the render is in the score');
    const v = verifyScore(wav.channels, wav.sampleRate, scoreFile.score, { signal: 'master' });
    assert.equal(v.failures.length, 0, v.failures.map((f) => `${f.event.source}:${f.event.track}@${f.event.audibleTime.toFixed(3)}: ${f.reason}`).join('\n'));

    await page.click('[data-testid="midi-log-clear"]');
    assert.match((await page.textContent('[data-testid="midi-log-count"]')) ?? '', /LOG 0/);
    assert.ok(await page.isDisabled('[data-testid="midi-replay"]'));
  });

  // -------------------------------------------------------------------------
  // Min / max cards
  // -------------------------------------------------------------------------

  test('clicking a header minimises the card to a single row whose jacks still take cables; dragging moves it; MIN ALL / MAX ALL; STACK lays stairs', async () => {
    const tall = (await page.locator('[data-testid="module-clock-1"]').boundingBox())!.height;
    await page.click('[data-testid="module-header-clock-1"]');
    await waitAttr(page, '[data-testid="module-clock-1"]', 'data-collapsed', 'true');
    const short = (await page.locator('[data-testid="module-clock-1"]').boundingBox())!.height;
    assert.ok(short <= 34 && short < tall / 4, `collapsed height ${short} px (was ${tall})`);
    assert.ok(await page.isVisible('[data-port-id="clk-trig-1"]'));

    // Drag a cable from the collapsed clock's TRIG OUT to the drums (after unplugging it).
    await page.dblclick('[data-port-id="perc-trig-in"]');
    assert.ok(!(await patchIds()).includes('clk-trig-1->perc-trig-in'));
    const from = (await page.locator('[data-port-id="clk-trig-1"]').boundingBox())!;
    const to = (await page.locator('[data-port-id="perc-trig-in"]').boundingBox())!;
    await page.mouse.move(from.x + 8, from.y + 8);
    await page.mouse.down();
    await page.mouse.move(to.x + 8, to.y + 8, { steps: 10 });
    await page.mouse.up();
    assert.ok((await patchIds()).includes('clk-trig-1->perc-trig-in'));

    await page.click('[data-testid="module-header-clock-1"]');
    await waitAttr(page, '[data-testid="module-clock-1"]', 'data-collapsed', 'false');

    // A drag on the header moves the card without toggling it.
    const before = (await page.locator('[data-testid="module-clock-1"]').boundingBox())!;
    const header = (await page.locator('[data-testid="module-header-clock-1"]').boundingBox())!;
    await page.mouse.move(header.x + 40, header.y + header.height / 2);
    await page.mouse.down();
    await page.mouse.move(header.x + 100, header.y + header.height / 2 + 30, { steps: 6 });
    await page.mouse.up();
    const after = (await page.locator('[data-testid="module-clock-1"]').boundingBox())!;
    assert.ok(Math.abs(after.x - before.x - 60) < 2 && Math.abs(after.y - before.y - 30) < 2, `moved to ${after.x},${after.y}`);
    assert.equal(await page.getAttribute('[data-testid="module-clock-1"]', 'data-collapsed'), 'false');

    await page.click('[data-testid="collapse-all"]');
    assert.equal(await page.locator('[data-collapsed="true"]').count(), 9);
    assert.match((await page.textContent('[data-testid="collapse-all"]')) ?? '', /MAX ALL/);
    await page.click('[data-testid="collapse-all"]');
    assert.equal(await page.locator('[data-collapsed="true"]').count(), 0);

    // STACK: every card minimised and laid out as stairs across the visible canvas.
    await page.click('[data-testid="stack"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-collapsed="true"]').length === 9);
    const boxes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="module-"][data-collapsed]')).map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.getAttribute('data-testid')!, x: r.x, y: r.y, right: r.right, width: r.width, height: r.height };
      })
    );
    const canvas = (await page.locator('[data-testid="modular-canvas"]').boundingBox())!;
    boxes.sort((a, b) => a.y - b.y || a.x - b.x);
    assert.ok(boxes.every((b) => b.height <= 34), 'all single rows');
    for (let i = 1; i < boxes.length; i++) {
      assert.ok(boxes[i].y > boxes[i - 1].y && boxes[i].x > boxes[i - 1].x, `stair step ${i}: ${boxes[i - 1].x},${boxes[i - 1].y} -> ${boxes[i].x},${boxes[i].y}`);
    }
    // One column at 1500 x 950: the first card starts at the left margin; the stair is sized so the
    // column's widest card would end flush with the right margin.
    const widest = Math.max(...boxes.map((b) => b.width));
    const last = boxes[boxes.length - 1];
    assert.ok(Math.abs(boxes[0].x - (canvas.x + 30)) < 2, `first at ${boxes[0].x - canvas.x}`);
    assert.ok(Math.abs(last.x + widest - (canvas.x + canvas.width - 30)) < 2, `last starts at ${last.x - canvas.x}, widest ${widest}, canvas ${canvas.width}`);
    await page.click('text=RESET PATCH');
    assert.equal(await page.locator('[data-collapsed="true"]').count(), 0);
  });

  test('no page errors occurred', () => {
    assert.deepEqual(errors, []);
  });
});

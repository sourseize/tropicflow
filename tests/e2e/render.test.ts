/**
 * End-to-end audio tests. The real engine (same code the UI runs) renders on
 * an OfflineAudioContext inside headless Chromium; the resulting samples are
 * analysed numerically in Node. No listening required.
 *
 * Requires a Chromium available to Playwright (`npx playwright install chromium`
 * or TROPICFLOW_CHROMIUM=/path/to/chrome).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserRenderer, type BrowserRenderResult } from '../../scripts/lib/browserRender.ts';
import { decodeWav } from '../../src/core/render/WavCodec.ts';
import { inspectOggOpus } from '../../src/core/export/OggOpus.ts';
import {
  bandLevelDb,
  bandRise,
  compareBuffers,
  peak,
  powerSpectrum,
  toMono,
  verifyScore,
  verifyStemOnsets,
} from '../../src/core/analysis/AudioAnalysis.ts';
import type { RenderConfig } from '../../src/core/render/RenderConfig.ts';
import { ChamberEngine } from '../../src/core/physics/ChamberEngine.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GOLDEN = path.join(ROOT, 'tests/golden/default-groove-1bar.wav');
const CHAMBER_GOLDEN = path.join(ROOT, 'tests/golden/chamber-only-1bar.wav');
const TRACKS = ['kick', 'snare', 'hihat', 'marimba', 'synth'];

const dec = (buf: Buffer) => decodeWav(buf);

/** "Same render" criterion: Chromium sums fan-in connections in pointer-hash order, so allow float noise. */
function assertEquivalentRenders(a: Float32Array, b: Float32Array, sampleRate: number, label: string) {
  const cmp = compareBuffers(a, b, sampleRate);
  assert.equal(cmp.lengthA, cmp.lengthB, `${label}: length`);
  assert.equal(cmp.lagSamples, 0, `${label}: lag`);
  if (!cmp.identical) {
    assert.ok(cmp.snrDb >= 90, `${label}: SNR ${cmp.snrDb.toFixed(1)} dB < 90 dB`);
    assert.ok(cmp.maxAbsDiff < 1e-4, `${label}: max diff ${cmp.maxAbsDiff}`);
    assert.ok(cmp.correlation > 0.99999, `${label}: correlation ${cmp.correlation}`);
  }
  return cmp;
}

describe('offline render (headless Chromium)', () => {
  let renderer: BrowserRenderer;
  let groove: RenderConfig;

  before(async () => {
    renderer = await BrowserRenderer.create();
    groove = await renderer.presetConfig('default-groove');
  });

  after(async () => {
    await renderer?.close();
  });

  test('render is deterministic: two renders of the same config are equivalent', async () => {
    const a = await renderer.render(groove);
    const b = await renderer.render(groove);
    const wa = dec(a.wav);
    const wb = dec(b.wav);
    assert.equal(wa.sampleRate, groove.sampleRate);
    const cmp = assertEquivalentRenders(toMono(wa.channels), toMono(wb.channels), wa.sampleRate, 'master');
    assertEquivalentRenders(toMono(dec(a.tapWav).channels), toMono(dec(b.tapWav).channels), wa.sampleRate, 'tap');
    assert.deepEqual(a.score, b.score);
    console.log(`    determinism: identical=${cmp.identical} snr=${cmp.snrDb === Infinity ? 'inf' : cmp.snrDb.toFixed(1) + ' dB'}`);
  });

  test('score describes the pattern: 32 note events per bar, drums on the expected steps', async () => {
    const r = await renderer.render({ ...groove, bars: 1 });
    assert.equal(r.score.length, 32);
    const kicks = r.score.filter((e) => e.track === 'kick').map((e) => e.step);
    assert.deepEqual(kicks, [0, 4, 8, 12]);
    assert.equal(r.score.filter((e) => e.track === 'hihat').length, 16);
    // 118 BPM: a 16th is 60/118/4 s
    const sixteenth = 60 / 118 / 4;
    for (const e of r.score) assert.ok(Math.abs(e.time - (e.step ?? -1) * sixteenth) < 1e-9);
    assert.ok(r.busLatency > 0 && r.busLatency < 0.02, `bus latency ${r.busLatency}`);
    console.log(`    bus latency: ${(r.busLatency * 1000).toFixed(2)} ms`);
  });

  for (const variant of [
    { name: '118 BPM / 48 kHz', cfg: {} },
    { name: '240 BPM / 44.1 kHz / swing 0.2', cfg: { bpm: 240, sampleRate: 44100, swing: 0.2 } },
  ]) {
    test(`every note sounds at its scheduled time (${variant.name})`, async () => {
      // Dry (delay mix 0) so stems contain only direct hits, no echoes.
      const base: RenderConfig = { ...groove, bars: 2, delay: { mix: 0 }, ...variant.cfg };
      const mix = await renderer.render(base);
      const mixTap = dec(mix.tapWav);
      const sum = new Float32Array(mixTap.channels[0].length);
      const summary: string[] = [];

      for (const track of TRACKS) {
        const stem = await renderer.render({ ...base, solo: [track] });
        const tap = dec(stem.tapWav);
        const mono = toMono(tap.channels);
        for (let i = 0; i < sum.length; i++) sum[i] += mono[i];

        const v = verifyStemOnsets(tap.channels, tap.sampleRate, mix.score, track);
        assert.equal(
          v.failures.length,
          0,
          `${track}: ${v.failures.length} of ${v.checks.length} events not found at their time: ` +
            v.failures.map((f) => `step ${f.event.step} @ ${f.event.time.toFixed(4)}s: ${f.reason}`).join(', ')
        );
        assert.equal(v.spurious.length, 0, `${track}: unexpected onsets at ${v.spurious.map((t) => t.toFixed(4)).join(', ')}`);
        summary.push(`${track} ${v.checks.length} ok (max ${v.maxAbsErrorMs.toFixed(2)} ms)`);
      }

      // The pre-compressor bus is linear: the mix must equal the sum of the stems.
      const lin = compareBuffers(toMono(mixTap.channels), sum, mixTap.sampleRate);
      assert.ok(lin.snrDb > 80, `mix != sum of stems (SNR ${lin.snrDb.toFixed(1)} dB)`);
      console.log(`    ${summary.join('; ')}; mix = sum of stems @ ${lin.snrDb.toFixed(0)} dB SNR`);
    });
  }

  test('in-mix verification of the final (compressed, delayed) output', async () => {
    const r = await renderer.render(groove);
    const w = dec(r.wav);
    const v = verifyScore(w.channels, w.sampleRate, r.score, { signal: 'master' });
    assert.equal(
      v.failures.length,
      0,
      v.failures.map((f) => `step ${f.event.step} ${f.event.track}: ${f.reason}`).join('\n')
    );
    console.log(`    ${v.checks.length} events, timing error mean ${v.meanAbsErrorMs.toFixed(2)} / max ${v.maxAbsErrorMs.toFixed(2)} ms`);
  });

  test('patch cables control routing: unplugging drums removes kick energy', async () => {
    const full = await renderer.render({ ...groove, bars: 1 });
    const noDrumAudio = await renderer.render({
      ...groove,
      bars: 1,
      cables: groove.cables.filter((c) => c.toPortId !== 'mst-in-l' || c.fromPortId !== 'perc-audio-out'),
    });
    const noDrumTrigger = await renderer.render({
      ...groove,
      bars: 1,
      cables: groove.cables.filter((c) => c.toPortId !== 'perc-trig-in'),
    });
    assert.equal(noDrumTrigger.score.filter((e) => e.track === 'kick').length, 0);
    assert.equal(noDrumAudio.score.filter((e) => e.track === 'kick').length, 4);

    const kickBand = { lowHz: 40, highHz: 160 };
    const kickSteps = full.score.filter((e) => e.track === 'kick');
    for (const variant of [noDrumAudio, noDrumTrigger]) {
      const a = toMono(dec(full.tapWav).channels);
      const b = toMono(dec(variant.tapWav).channels);
      for (const e of kickSteps) {
        const withKick = bandRise(a, full.sampleRate, kickBand, e.time, 20).afterDb;
        const without = bandRise(b, full.sampleRate, kickBand, e.time, 20).afterDb;
        // Synth/marimba harmonics and the delay leave some low-band energy; the kick adds well over 12 dB.
        assert.ok(withKick - without > 12, `kick band at step ${e.step}: ${withKick.toFixed(1)} vs ${without.toFixed(1)} dB`);
      }
    }
  });

  test('an empty patch renders digital silence', async () => {
    const r = await renderer.render(await renderer.presetConfig('silence'));
    assert.equal(r.score.length, 0);
    const w = dec(r.wav);
    assert.equal(peak(w.channels[0]), 0);
    assert.equal(peak(w.channels[1]), 0);
  });

  // -------------------------------------------------------------------
  // Gravity chamber
  // -------------------------------------------------------------------

  test('chamber: collisions become notes at their exact physics times, per stem', async () => {
    const cfg = await renderer.presetConfig('chamber-only');
    const mix = await renderer.render(cfg);
    const chamberNotes = mix.score.filter((e) => e.source === 'chamber');
    assert.ok(chamberNotes.length >= 20, `only ${chamberNotes.length} chamber notes`);
    assert.equal(mix.score.filter((e) => e.source === 'sequencer').length, 0);
    for (const e of chamberNotes) {
      assert.ok(e.collision, 'chamber note carries its collision');
      assert.equal(e.time, e.collision!.time, 'quantize 0: note time == collision time');
    }
    const tracks = new Set(chamberNotes.map((e) => e.track));
    assert.ok(tracks.has('kick') && tracks.has('marimba'), `tracks: ${[...tracks].join(',')}`);

    const summary: string[] = [];
    for (const track of [...tracks]) {
      const stem = await renderer.render({ ...cfg, solo: [track] });
      const tap = dec(stem.tapWav);
      const v = verifyStemOnsets(tap.channels, tap.sampleRate, mix.score, track);
      assert.equal(v.failures.length, 0, `${track}: ` + v.failures.map((f) => `${f.event.time.toFixed(4)}s ${f.reason}`).join('; '));
      assert.equal(v.spurious.length, 0, `${track}: unexpected onsets at ${v.spurious.map((t) => t.toFixed(4)).join(', ')}`);
      summary.push(`${track} ${v.checks.length} ok (max ${v.maxAbsErrorMs.toFixed(2)} ms)`);
    }
    console.log(`    ${chamberNotes.length} chamber notes; ${summary.join('; ')}`);
  });

  test('chamber: browser simulation matches an independent Node simulation and is deterministic', async () => {
    const cfg = await renderer.presetConfig('chamber-only');
    const a = await renderer.render(cfg);
    const b = await renderer.render(cfg);
    assert.deepEqual(a.score, b.score);
    assertEquivalentRenders(toMono(dec(a.wav).channels), toMono(dec(b.wav).channels), a.sampleRate, 'chamber master');

    const local: Array<{ time: number; track: string }> = [];
    const eng = new ChamberEngine(cfg.chamber!, { sink: (n) => local.push({ time: n.time, track: n.command.track }) });
    eng.start(0);
    eng.runTo(a.frames / a.sampleRate);
    const remote = a.score.filter((e) => e.source === 'chamber').map((e) => ({ time: e.time, track: e.track }));
    assert.deepEqual(remote, local);
  });

  test('chamber: quantize snaps hits to the 16th grid; trigger cables gate which instruments it may play', async () => {
    const cfg = await renderer.presetConfig('chamber-only');
    const quantized = await renderer.render({ ...cfg, chamber: { ...cfg.chamber, quantize: 1 } });
    const sixteenth = 60 / cfg.bpm / 4;
    const qNotes = quantized.score.filter((e) => e.source === 'chamber');
    assert.ok(qNotes.length > 10);
    let moved = 0;
    for (const e of qNotes) {
      const k = e.time / sixteenth;
      assert.ok(Math.abs(k - Math.round(k)) < 1e-6, `note at ${e.time} is off-grid`);
      if (Math.abs(e.time - e.collision!.time) > 1e-6) moved++;
    }
    assert.ok(moved > qNotes.length / 2, 'most hits should have been moved onto the grid');

    const noDrums = await renderer.render({
      ...cfg,
      cables: cfg.cables.filter((c) => !(c.fromPortId === 'chm-trig-out' && c.toPortId === 'perc-trig-in')),
    });
    const tracks = new Set(noDrums.score.filter((e) => e.source === 'chamber').map((e) => e.track));
    assert.ok(!tracks.has('kick') && !tracks.has('snare') && !tracks.has('hihat'), `drums still fired: ${[...tracks]}`);
    assert.ok(tracks.has('marimba'));

    // Mapping is part of the config: floor -> synth, pegs silent.
    const remapped = await renderer.render({
      ...cfg,
      chamber: { ...cfg.chamber, mapping: { ...cfg.chamber!.mapping!, floor: { track: 'synth' }, peg: { track: 'none' } } },
    });
    const byTrack = new Map<string, number>();
    for (const e of remapped.score) byTrack.set(e.track, (byTrack.get(e.track) ?? 0) + 1);
    assert.ok((byTrack.get('synth') ?? 0) > 10, `synth notes: ${byTrack.get('synth')}`);
    assert.equal(byTrack.get('kick') ?? 0, 0);
    assert.equal(byTrack.get('marimba') ?? 0, 0);
  });

  test('chamber: auto-drop releases a ball on the first step of every bar alongside the groove', async () => {
    const cfg = await renderer.presetConfig('chamber-groove');
    const r = await renderer.render(cfg);
    const seq = r.score.filter((e) => e.source === 'sequencer');
    const chamber = r.score.filter((e) => e.source === 'chamber');
    assert.equal(seq.length, 32 * cfg.bars);
    assert.ok(chamber.length >= cfg.bars, `${chamber.length} chamber notes`);
    // A ball dropped at bar start from the ceiling first reaches a peg/floor well within the bar.
    const barLen = (60 / cfg.bpm) * 4;
    for (let bar = 0; bar < cfg.bars; bar++) {
      const inBar = chamber.filter((e) => e.time >= bar * barLen && e.time < (bar + 1) * barLen);
      assert.ok(inBar.length > 0, `no chamber hit in bar ${bar}`);
    }
    // Stems contain both sequencer and chamber notes of a track; all must verify.
    for (const track of ['kick', 'marimba']) {
      const stem = await renderer.render({ ...cfg, delay: { mix: 0 }, solo: [track] });
      const tap = dec(stem.tapWav);
      const v = verifyStemOnsets(tap.channels, tap.sampleRate, stem.score, track);
      assert.equal(v.failures.length, 0, `${track}: ` + v.failures.map((f) => `${f.event.source} @ ${f.event.time.toFixed(4)}s ${f.reason}`).join('; '));
      assert.equal(v.spurious.length, 0, `${track}: unexpected onsets at ${v.spurious.map((t) => t.toFixed(4)).join(', ')}`);
      const bySource = { sequencer: 0, chamber: 0 };
      for (const c of v.checks) bySource[c.event.source as 'sequencer' | 'chamber']++;
      console.log(`    ${track} stem: ${bySource.sequencer} sequencer + ${bySource.chamber} chamber notes verified, ${v.masked.length} masked (max ${v.maxAbsErrorMs.toFixed(2)} ms)`);
    }
  });

  // -------------------------------------------------------------------------
  // MIDI BRIDGE: a scripted performance replayed through the same binding the live devices use
  // -------------------------------------------------------------------------

  test('midi: a scripted performance lands in the score at its exact times and is gated by GATE OUT cables', async () => {
    const cfg = await renderer.presetConfig('midi-performance');
    const script = cfg.inputScript!;
    const mix = await renderer.render(cfg);
    const midi = mix.score.filter((e) => e.source === 'midi');
    const noteOns = script.events.filter((e) => e.kind === 'noteOn');
    // Every note-on reaches the marimba and the synth; the GM kick key (36) also fires the kick.
    assert.equal(midi.filter((e) => e.track === 'marimba').length, noteOns.length);
    assert.equal(midi.filter((e) => e.track === 'synth').length, noteOns.length);
    assert.deepEqual(midi.filter((e) => e.track === 'kick').map((e) => e.time), [1.0]);
    assert.equal(midi.filter((e) => e.track === 'snare' || e.track === 'hihat').length, 0);
    for (const e of midi) {
      const src = noteOns.find((n) => n.time === e.time && (e.track === 'kick' ? n.note === 36 : Math.abs(e.frequency! - 440 * Math.pow(2, (n.note - 69) / 12)) < 1e-6));
      assert.ok(src, `midi note ${e.track} @ ${e.time} ${e.frequency} has no source event`);
      assert.ok(Math.abs(e.velocity - src!.velocity) < 1e-12);
    }
    // The sequencer is untouched by the performance.
    assert.equal(mix.score.filter((e) => e.source === 'sequencer').length, 64);

    // Remove GATE OUT -> synth: the synth no longer receives the performance, everything else is unchanged.
    const noSynth = await renderer.render({ ...cfg, cables: cfg.cables.filter((c) => c.id !== 'cable-midi-synth') });
    assert.equal(noSynth.score.filter((e) => e.source === 'midi' && e.track === 'synth').length, 0);
    assert.equal(noSynth.score.filter((e) => e.source === 'midi').length, midi.length - noteOns.length);

    // Transpose shifts every played frequency by the same ratio.
    const up = await renderer.render({ ...cfg, bridge: { transpose: 12 } });
    const upMarimba = up.score.filter((e) => e.source === 'midi' && e.track === 'marimba');
    const marimba = midi.filter((e) => e.track === 'marimba');
    assert.equal(upMarimba.length, marimba.length);
    for (let i = 0; i < marimba.length; i++) assert.ok(Math.abs(upMarimba[i].frequency! / marimba[i].frequency! - 2) < 1e-9);
  });

  test('midi: every performed note verifies sample-accurately on its solo stem; the render is deterministic', async () => {
    const cfg = await renderer.presetConfig('midi-performance');
    const mix = await renderer.render(cfg);
    const again = await renderer.render(cfg);
    assertEquivalentRenders(toMono(dec(mix.wav).channels), toMono(dec(again.wav).channels), dec(mix.wav).sampleRate, 'midi-performance');

    const summary: string[] = [];
    for (const track of ['marimba', 'synth', 'kick']) {
      const stem = await renderer.render({ ...cfg, solo: [track], delay: { mix: 0 } });
      const tap = dec(stem.tapWav);
      // The GM kick key (note 36) also drives the synth at 65 Hz: one period is 15 ms, so the
      // rise estimator is up to a period late there; allow one extra period for the synth stem,
      // and average the onset baseline over more than a period of the sustained 130 Hz
      // sequencer note ringing under the chord (its waveform edges are not onsets).
      const options = track === 'synth' ? { tolerance: { early: 0.6, late: 22 + 16 }, stepOnset: { baselineMs: 16 } } : {};
      const v = verifyStemOnsets(tap.channels, tap.sampleRate, mix.score, track, options);
      assert.equal(v.failures.length, 0, `${track}: ` + v.failures.map((f) => `${f.event.time.toFixed(4)}s (${f.event.source}) ${f.reason}`).join('; '));
      assert.equal(v.spurious.length, 0, `${track}: unexpected onsets at ${v.spurious.map((t) => t.toFixed(4)).join(', ')}`);
      const midiChecks = v.checks.filter((c) => c.event.source === 'midi');
      assert.ok(midiChecks.length > 0, `${track}: no midi notes checked`);
      summary.push(`${track} ${midiChecks.length} midi + ${v.checks.length - midiChecks.length} seq ok, ${v.masked.length} masked (max ${v.maxAbsErrorMs.toFixed(2)} ms)`);
    }
    console.log(`    ${summary.join('; ')}`);
  });

  test('cv: the mod wheel opens the synth filter (CUTOFF CV) and the pitch wheel bends held and new notes (PITCH CV)', async () => {
    const cfg = await renderer.presetConfig('midi-cv');
    const r = await renderer.render(cfg);
    const tap = dec(r.tapWav);
    const mono = toMono(tap.channels);
    const sr = tap.sampleRate;

    // 1. CUTOFF CV: C3 held 0.1-1.1 s, mod wheel 0 -> 1 at 0.6 s. The 1800 Hz lowpass opens to
    //    ~14.4 kHz, so the 3-6 kHz band of the sawtooth rises by far more than it could by itself.
    const hi = { lowHz: 3000, highHz: 6000 };
    const closed = bandLevelDb(mono, sr, Math.round(0.35 * sr), 8192, hi, 'hann');
    const open = bandLevelDb(mono, sr, Math.round(0.85 * sr), 8192, hi, 'hann');
    // Without the mod -> cutoff cable the same moments are unchanged: compare like with like.
    const unpatched = await renderer.render({ ...cfg, cables: cfg.cables.filter((c) => c.id !== 'cable-14') });
    const um = toMono(dec(unpatched.tapWav).channels);
    const uOpen = bandLevelDb(um, sr, Math.round(0.85 * sr), 8192, hi, 'hann');
    const uClosed = bandLevelDb(um, sr, Math.round(0.35 * sr), 8192, hi, 'hann');
    console.log(`    cutoff cv: 3-6 kHz band at 0.85 s ${uOpen.toFixed(1)} dB unpatched -> ${open.toFixed(1)} dB with the mod wheel up (before the wheel: ${uClosed.toFixed(1)} / ${closed.toFixed(1)} dB)`);
    assert.ok(Math.abs(closed - uClosed) < 1, 'identical before the wheel moves');
    assert.ok(open - uOpen > 8, `mod wheel should open the filter: +${(open - uOpen).toFixed(1)} dB vs unpatched`);

    // 2. PITCH CV on a held note: C4 held 1.5-2.5 s, bend +1 (range 2 st) at 2.0 s: the fundamental
    //    glides from 261.6 to 293.7 Hz. Spectral peak before vs after (8192-pt FFT: 5.9 Hz bins).
    const peakHz = (at: number) => {
      const spec = powerSpectrum(mono, Math.round(at * sr), 8192, 'hann');
      let best = 1;
      for (let k = 1; k < spec.length && (k * sr) / 8192 < 400; k++) if (spec[k] > spec[best]) best = k;
      return (best * sr) / 8192;
    };
    const before = peakHz(1.7);
    const after = peakHz(2.25);
    console.log(`    pitch cv: held note ${before.toFixed(1)} Hz -> ${after.toFixed(1)} Hz after bend`);
    assert.ok(Math.abs(before - 261.63) < 8, `unbent ${before}`);
    assert.ok(Math.abs(after - 293.66) < 8, `bent ${after}`);

    // 3. New notes while the bend is held are transposed, and the score says so (synth and, through
    //    the extra cable, the marimba); the last note-off/bend reset leave nothing hanging.
    const at26 = r.score.filter((e) => Math.abs(e.time - 2.6) < 1e-9);
    assert.deepEqual(at26.map((e) => e.track).sort(), ['marimba', 'synth']);
    for (const e of at26) assert.ok(Math.abs(e.frequency! - 293.66) < 0.01, `${e.track} at 2.6 s: ${e.frequency}`);
    const at15 = r.score.find((e) => Math.abs(e.time - 1.5) < 1e-9 && e.track === 'synth')!;
    assert.ok(Math.abs(at15.frequency! - 261.63) < 0.01);
    // Bend into the marimba only (cable-bend-marimba) but not into the synth -> synth unbent, marimba bent.
    const noSynthBend = await renderer.render({ ...cfg, cables: cfg.cables.filter((c) => c.id !== 'cable-15') });
    const n26 = Object.fromEntries(noSynthBend.score.filter((e) => Math.abs(e.time - 2.6) < 1e-9).map((e) => [e.track, e.frequency]));
    assert.ok(Math.abs(n26.synth! - 261.63) < 0.01 && Math.abs(n26.marimba! - 293.66) < 0.01, JSON.stringify(n26));

    // Deterministic.
    const again = await renderer.render(cfg);
    assertEquivalentRenders(mono, toMono(dec(again.tapWav).channels), sr, 'midi-cv');
  });

  test('sensor: tracked pitch transposes the marimba through PITCH CV, onsets fire the chosen drum through ONSET TRIG, at exact times', async () => {
    const cfg = await renderer.presetConfig('sensor-follow');
    const r = await renderer.render(cfg);
    const bar = (60 / 118) * 4;
    // Bar 1: humming the root (C4) -> PITCH CV 0 -> the marimba pattern plays as written.
    const plain = await renderer.render({ ...cfg, inputScript: undefined });
    const marimba = (res: typeof r) => res.score.filter((e) => e.track === 'marimba' && e.source === 'sequencer');
    const a = marimba(r);
    const b = marimba(plain);
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      const ratio = a[i].frequency! / b[i].frequency!;
      const expected = a[i].time < bar - 1e-9 ? 1 : Math.pow(2, 2 / 12); // D4 over C4 = +2 semitones from the second bar
      assert.ok(Math.abs(ratio - expected) < 1e-3, `marimba @${a[i].time.toFixed(3)}: ratio ${ratio.toFixed(4)} vs ${expected.toFixed(4)}`);
    }
    // Onsets: snare hits (sensor settings) at exactly 0.6 s and bar + 0.6 s with the onset strength as velocity.
    const hits = r.score.filter((e) => e.source === 'sensor');
    assert.deepEqual(hits.map((e) => [e.track, Number(e.time.toFixed(6)), e.velocity]), [
      ['snare', 0.6, 0.9],
      ['snare', Number((bar + 0.6).toFixed(6)), 0.6],
    ]);
    // They are real hits on the snare stem, at those times.
    const stem = await renderer.render({ ...cfg, solo: ['snare'], delay: { mix: 0 } });
    const tap = dec(stem.tapWav);
    const v = verifyStemOnsets(tap.channels, tap.sampleRate, r.score, 'snare');
    assert.equal(v.failures.length, 0, v.failures.map((f) => `${f.event.time.toFixed(4)}s ${f.reason}`).join('; '));
    assert.ok(v.checks.some((c) => c.event.source === 'sensor'));
    // Without the ONSET TRIG cable the claps are silent; without the PITCH CV cable nothing transposes.
    const noCables = await renderer.render({ ...cfg, cables: cfg.cables.filter((c) => !c.id.startsWith('cable-sense')) });
    assert.equal(noCables.score.filter((e) => e.source === 'sensor').length, 0);
    const m2 = marimba(noCables);
    for (let i = 0; i < m2.length; i++) assert.ok(Math.abs(m2[i].frequency! / b[i].frequency! - 1) < 1e-9);
    // Sensor settings: the onset drum follows the config.
    const kick = await renderer.render({ ...cfg, sensor: { rootNote: 60, onsetDrum: 'kick' } });
    assert.deepEqual(kick.score.filter((e) => e.source === 'sensor').map((e) => e.track), ['kick', 'kick']);
  });

  test('midi: a malformed input script is rejected with a reason instead of rendering silently', async () => {
    const cfg = await renderer.presetConfig('midi-performance');
    const bad = { ...cfg, inputScript: { version: 1, events: [{ kind: 'noteOn', time: 0, device: 'x', note: 200, velocity: 1 }] } } as unknown as RenderConfig;
    await assert.rejects(() => renderer.render(bad), /event 0: note/);
  });

  test('harness runs in a secure context and encodes a render to Ogg Opus of exactly the rendered length', async () => {
    const caps = await renderer.capabilities();
    assert.equal(caps.secureContext, true, 'harness page must be served from localhost (WebCodecs / AudioWorklet need a secure context)');
    assert.equal(caps.opusEngine, 'webcodecs');

    const r = await renderer.render({ ...groove, bars: 1 }, 32, 96);
    assert.ok(r.ogg && r.ogg.length > 0, 'ogg produced');
    assert.equal(r.oggEngine, 'webcodecs');
    const info = inspectOggOpus(new Uint8Array(r.ogg!));
    assert.ok(info.pages.every((p) => p.crcOk), 'all page CRCs valid');
    assert.ok(info.pages[0].flags.bos && info.pages[info.pages.length - 1].flags.eos);
    assert.equal(info.head.channels, 2);
    assert.equal(info.head.inputSampleRate, r.sampleRate);
    const renderedSeconds = r.frames / r.sampleRate;
    assert.ok(Math.abs(info.durationSeconds - renderedSeconds) < 1 / 48000, `ogg duration ${info.durationSeconds} vs rendered ${renderedSeconds}`);
    // 96 kb/s VBR: allow a wide band but catch gross errors (e.g. mono, silence, wrong bitrate).
    const kbps = (r.ogg!.length * 8) / renderedSeconds / 1000;
    assert.ok(kbps > 50 && kbps < 160, `effective bitrate ${kbps.toFixed(0)} kb/s`);
    console.log(`    ogg: ${r.ogg!.length} bytes, ${info.audioPackets} packets, ${info.durationSeconds.toFixed(4)} s, ~${kbps.toFixed(0)} kb/s`);
  });

  test('golden file: chamber-only matches the committed reference', async (t) => {
    if (!fs.existsSync(CHAMBER_GOLDEN)) {
      t.skip(`no golden at ${CHAMBER_GOLDEN}; create with: npm run golden:update`);
      return;
    }
    const cfg = await renderer.presetConfig('chamber-only');
    const r = await renderer.render({ ...cfg, bars: 1 });
    const ours = dec(r.wav);
    const gold = decodeWav(fs.readFileSync(CHAMBER_GOLDEN));
    const cmp = compareBuffers(toMono(gold.channels), toMono(ours.channels), ours.sampleRate, { maxLagSamples: 48 });
    assert.equal(cmp.lagSamples, 0);
    assert.ok(cmp.correlation > 0.999, `correlation ${cmp.correlation}`);
    assert.ok(cmp.maxWindowDiffDb < 1.0, `max windowed level diff ${cmp.maxWindowDiffDb.toFixed(2)} dB`);
  });

  test('golden file: default groove matches the committed reference', async (t) => {
    if (!fs.existsSync(GOLDEN)) {
      t.skip(`no golden at ${GOLDEN}; create with: npm run golden:update`);
      return;
    }
    const r = await renderer.render({ ...groove, bars: 1 });
    const ours = dec(r.wav);
    const gold = decodeWav(fs.readFileSync(GOLDEN));
    assert.equal(gold.sampleRate, ours.sampleRate);
    const cmp = compareBuffers(toMono(gold.channels), toMono(ours.channels), ours.sampleRate, { maxLagSamples: 48 });
    assert.equal(cmp.lagSamples, 0, `render is shifted by ${cmp.lagSamples} samples vs golden`);
    assert.ok(cmp.correlation > 0.999, `correlation ${cmp.correlation}`);
    assert.ok(cmp.maxWindowDiffDb < 1.0, `max windowed level diff ${cmp.maxWindowDiffDb.toFixed(2)} dB`);
    console.log(`    golden: corr ${cmp.correlation.toFixed(6)}, max window diff ${cmp.maxWindowDiffDb.toFixed(3)} dB, snr ${cmp.snrDb.toFixed(1)} dB`);
  });
});

export type { BrowserRenderResult };

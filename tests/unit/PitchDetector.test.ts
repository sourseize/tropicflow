import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, frameSizeFor } from '../../src/core/sense/PitchDetector.ts';
import { LevelOnset, levelToUnit } from '../../src/core/sense/LevelOnset.ts';
import { analyseBuffer } from '../../src/core/sense/SensorAnalysis.ts';
import { SeededRandom } from '../../src/core/util/SeededRandom.ts';
import { hzToMidiNote } from '../../src/core/input/InputEvents.ts';

const SR = 48000;

function tone(hz: number, seconds: number, shape: 'sine' | 'saw' | 'square' = 'sine', amp = 0.5, phase = 0): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ph = ((i / SR) * hz + phase) % 1;
    out[i] = amp * (shape === 'sine' ? Math.sin(2 * Math.PI * ph) : shape === 'saw' ? 2 * ph - 1 : ph < 0.5 ? 1 : -1);
  }
  return out;
}

function centsOff(hz: number, ref: number): number {
  return 1200 * Math.log2(hz / ref);
}

test('frameSizeFor: two periods of the lowest pitch, power of two', () => {
  assert.equal(frameSizeFor(48000, 60), 2048);
  assert.equal(frameSizeFor(44100, 60), 2048);
  assert.equal(frameSizeFor(48000, 30), 4096);
  assert.equal(frameSizeFor(48000, 200), 512);
});

test('sine waves from 60 Hz to 1000 Hz are found within 0.5 % (typically < 5 cents) with high clarity', () => {
  const N = frameSizeFor(SR, 60);
  let worst = 0;
  for (const hz of [60, 82.41, 110, 146.83, 220, 261.63, 329.63, 440, 523.25, 659.25, 880, 1000]) {
    const est = detectPitch(tone(hz, N / SR, 'sine', 0.3, 0.37).subarray(0, N), SR)!;
    assert.ok(est, `${hz} Hz: no estimate`);
    const err = Math.abs(est.hz / hz - 1);
    worst = Math.max(worst, err);
    assert.ok(err < 0.005, `${hz} Hz: got ${est.hz.toFixed(2)} (${(err * 100).toFixed(2)} %)`);
    assert.ok(est.clarity > 0.95, `${hz} Hz: clarity ${est.clarity}`);
  }
  console.log(`    worst sine error ${(worst * 100).toFixed(3)} %`);
});

test('sawtooth and square waves: no octave errors', () => {
  const N = frameSizeFor(SR, 60);
  for (const shape of ['saw', 'square'] as const) {
    for (const hz of [65.41, 130.81, 196, 392, 783.99]) {
      const est = detectPitch(tone(hz, N / SR, shape, 0.4).subarray(0, N), SR)!;
      assert.ok(Math.abs(centsOff(est.hz, hz)) < 10, `${shape} ${hz} Hz: got ${est.hz.toFixed(2)} (${centsOff(est.hz, hz).toFixed(0)} cents)`);
    }
  }
});

test('a vibrato tone is tracked frame by frame; a quarter-tone step is resolved', () => {
  const N = 2048;
  const seconds = 1;
  const n = seconds * SR;
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const hz = 220 * Math.pow(2, (30 * Math.sin(2 * Math.PI * 5 * (i / SR))) / 1200); // +-30 cents at 5 Hz
    ph += hz / SR;
    x[i] = 0.4 * Math.sin(2 * Math.PI * ph);
  }
  const errs: number[] = [];
  for (let end = N; end <= n; end += 512) {
    const t = (end - N / 2) / SR;
    const expected = 220 * Math.pow(2, (30 * Math.sin(2 * Math.PI * 5 * t)) / 1200);
    const est = detectPitch(x.subarray(end - N, end), SR)!;
    errs.push(Math.abs(centsOff(est.hz, expected)));
  }
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  assert.ok(mean < 6, `mean vibrato tracking error ${mean.toFixed(1)} cents`);
  const a = detectPitch(tone(440, N / SR).subarray(0, N), SR)!;
  const b = detectPitch(tone(440 * Math.pow(2, 50 / 1200), N / SR).subarray(0, N), SR)!;
  assert.ok(Math.abs(centsOff(b.hz, a.hz) - 50) < 5, `quarter tone measured as ${centsOff(b.hz, a.hz).toFixed(1)} cents`);
});

test('noise has low clarity, silence is null, a tone in noise is still found', () => {
  const N = 2048;
  const rng = new SeededRandom(42);
  const noise = new Float32Array(N);
  for (let i = 0; i < N; i++) noise[i] = 0.3 * rng.bipolar();
  const est = detectPitch(noise, SR);
  assert.ok(est === null || est.clarity < 0.6, `noise clarity ${est?.clarity}`);
  assert.equal(detectPitch(new Float32Array(N), SR), null);
  assert.equal(detectPitch(tone(220, N / SR, 'sine', 0.001).subarray(0, N), SR), null, 'below the silence floor');
  const mixed = tone(220, N / SR, 'sine', 0.3).subarray(0, N).map((v, i) => v + 0.05 * noise[i]);
  const m = detectPitch(mixed, SR)!;
  assert.ok(Math.abs(centsOff(m.hz, 220)) < 10 && m.clarity > 0.8, `tone in noise: ${m.hz} clarity ${m.clarity}`);
});

test('LevelOnset: bursts at known times produce one onset each, respecting the refractory period; sustained tones do not retrigger', () => {
  const seconds = 2;
  const x = new Float32Array(seconds * SR);
  const rng = new SeededRandom(7);
  const bursts = [0.25, 0.5, 0.52, 1.0, 1.5]; // 0.52 is inside the refractory window of 0.5
  for (const t of bursts) {
    const s = Math.round(t * SR);
    for (let i = 0; i < Math.round(0.02 * SR); i++) x[s + i] += 0.8 * rng.bipolar() * (1 - i / (0.02 * SR));
  }
  // A sustained tone from 1.2 s: one onset at its start, none after.
  const s12 = Math.round(1.2 * SR);
  for (let i = s12; i < Math.round(1.45 * SR); i++) x[i] += 0.3 * Math.sin(2 * Math.PI * 300 * (i / SR));

  const det = new LevelOnset();
  const onsets: Array<{ time: number; strength: number }> = [];
  for (let s = 0; s + 256 <= x.length; s += 256) {
    const f = det.process(x.subarray(s, s + 256), s / SR);
    if (f.onset !== null) onsets.push({ time: f.time, strength: f.onset });
  }
  const expected = [0.25, 0.5, 1.0, 1.2, 1.5];
  assert.equal(onsets.length, expected.length, `onsets at ${onsets.map((o) => o.time.toFixed(3)).join(', ')}`);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(onsets[i].time - expected[i]) <= 256 / SR + 1e-9, `onset ${i}: ${onsets[i].time} vs ${expected[i]}`);
    assert.ok(onsets[i].strength > 0.3 && onsets[i].strength <= 1);
  }
  assert.ok(onsets[0].strength > onsets[3].strength, 'a loud burst is stronger than the quiet tone');
  assert.equal(levelToUnit(0), 1);
  assert.equal(levelToUnit(-45), 0);
  assert.ok(Math.abs(levelToUnit(-22.5) - 0.5) < 1e-12);
});

test('analyseBuffer: a tone then a higher tone gives a handful of change-gated pitch/level events and the burst an onset', () => {
  const x = new Float32Array(2 * SR);
  x.set(tone(220, 1, 'sine', 0.3), 0);
  x.set(tone(440, 1, 'sine', 0.3), SR);
  const rng = new SeededRandom(3);
  for (let i = 0; i < 960; i++) x[Math.round(0.5 * SR) + i] += 0.9 * rng.bipolar();
  const events = analyseBuffer(x, SR);
  const pitches = events.filter((e) => e.kind === 'pitch') as Array<{ time: number; hz: number }>;
  const onsets = events.filter((e) => e.kind === 'onset') as Array<{ time: number }>;
  const levels = events.filter((e) => e.kind === 'level');
  assert.ok(pitches.length >= 6 && pitches.length < 60, `${pitches.length} pitch events (change-gated, not one per frame)`);
  assert.ok(pitches.filter((p) => p.time < 0.48).every((p) => Math.abs(centsOff(p.hz, 220)) < 10), 'first half is A3');
  assert.ok(pitches.filter((p) => p.time > 1.1).every((p) => Math.abs(centsOff(p.hz, 440)) < 10), 'second half is A4');
  assert.ok(pitches.some((p) => p.time > 1.0 && p.time < 1.1), 'the step is picked up within 100 ms');
  // The tone starts and the burst: two onsets (the 440 Hz tone is not louder than the 220 Hz one).
  assert.deepEqual(onsets.map((o) => Math.round(o.time * 100) / 100), [0, 0.5]);
  assert.ok(levels.length >= 4 && levels.length < 200, `${levels.length} level events`);
  assert.ok(Math.abs(hzToMidiNote(pitches[0].hz) - 57) < 0.2);
});

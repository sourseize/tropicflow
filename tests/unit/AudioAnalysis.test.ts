import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandRise,
  compareBuffers,
  detectOnsets,
  fft,
  matchOnsets,
  measureStepOnset,
  verifyScore,
  verifyStemOnsets,
} from '../../src/core/analysis/AudioAnalysis.ts';
import type { ScoreEvent } from '../../src/core/render/RenderConfig.ts';

const SR = 48000;

/** Decaying noise burst (hi-hat like) or decaying sine (kick like) at given times. */
function synth(
  hits: Array<{ t: number; freq?: number; amp?: number; decay?: number }>,
  seconds: number
): Float32Array {
  const x = new Float32Array(Math.ceil(seconds * SR));
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  for (const h of hits) {
    const start = Math.round(h.t * SR);
    const decay = h.decay ?? 0.08;
    const amp = h.amp ?? 0.5;
    const len = Math.round(decay * 5 * SR);
    for (let i = 0; i < len && start + i < x.length; i++) {
      const env = amp * Math.exp(-i / (decay * SR));
      x[start + i] += env * (h.freq ? Math.sin((2 * Math.PI * h.freq * i) / SR) : rnd());
    }
  }
  return x;
}

test('fft of a pure tone peaks in the expected bin', () => {
  const n = 1024;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 64 * i) / n);
  fft(re, im);
  let best = 0;
  for (let k = 1; k < n / 2; k++) if (re[k] ** 2 + im[k] ** 2 > re[best] ** 2 + im[best] ** 2) best = k;
  assert.equal(best, 64);
});

test('detectOnsets finds noise bursts at the right times and nothing else', () => {
  const times = [0.05, 0.2, 0.31, 0.5];
  const x = synth(times.map((t) => ({ t })), 0.8);
  const onsets = detectOnsets(x, SR);
  assert.equal(onsets.length, times.length, JSON.stringify(onsets));
  for (let i = 0; i < times.length; i++) assert.ok(Math.abs(onsets[i] - times[i]) < 0.0006);
});

test('detectOnsets does not fire on the periodic dips of a low-frequency tail', () => {
  const x = synth([{ t: 0.05, freq: 45, decay: 0.4, amp: 0.8 }], 1.0);
  const onsets = detectOnsets(x, SR);
  assert.equal(onsets.length, 1);
});

test('matchOnsets reports missing and spurious', () => {
  const m = matchOnsets([1, 2, 3], [1.0005, 2.5, 3.0002], 0.001);
  assert.equal(m.matched.length, 2);
  assert.deepEqual(m.missing, [2]);
  assert.deepEqual(m.spurious, [2.5]);
});

test('measureStepOnset locates a hit on top of a louder sustained tone', () => {
  const x = synth([{ t: 0.01, freq: 200, decay: 2, amp: 0.4 }, { t: 0.3, decay: 0.05, amp: 0.1 }], 0.6);
  const m = measureStepOnset(x, SR, 0.3);
  assert.ok(Math.abs(m.measuredTime - 0.3) < 0.0005, `measured ${m.measuredTime}`);
  assert.ok(m.riseDb > 6);
});

test('bandRise attributes energy to the right band', () => {
  const x = synth([{ t: 0.2, freq: 100, decay: 0.3, amp: 0.8 }], 0.6);
  const low = bandRise(x, SR, { lowHz: 40, highHz: 160 }, 0.2, 20);
  const high = bandRise(x, SR, { lowHz: 7000, highHz: 11000 }, 0.2, 20);
  assert.ok(low.riseDb > 20, `low rise ${low.riseDb}`);
  assert.ok(high.riseDb < low.riseDb - 20, `high rise ${high.riseDb}`);
});

test('verifyScore passes a correct score and fails a shifted one', () => {
  const events: ScoreEvent[] = [
    { time: 0.1, audibleTime: 0.1, step: 0, track: 'kick', velocity: 1, source: 'sequencer' },
    { time: 0.35, audibleTime: 0.35, step: 1, track: 'hihat', velocity: 1, source: 'sequencer' },
  ];
  const x = synth([{ t: 0.1, freq: 90, decay: 0.3, amp: 0.8 }, { t: 0.35, decay: 0.06, amp: 0.3 }], 0.6);
  const ok = verifyScore([x], SR, events);
  assert.equal(ok.failures.length, 0, JSON.stringify(ok.failures.map((f) => f.reason)));
  assert.ok(ok.maxAbsErrorMs < 0.6);

  const shifted = events.map((e) => ({ ...e, time: e.time + 0.012, audibleTime: e.audibleTime + 0.012 }));
  const bad = verifyScore([x], SR, shifted);
  assert.equal(bad.failures.length, 2);

  const wrongInstrument = events.map((e) => ({ ...e, track: e.track === 'kick' ? 'hihat' : 'kick' }));
  const badBand = verifyScore([x], SR, wrongInstrument);
  assert.ok(badBand.failures.length >= 1);
});

test('verifyStemOnsets is sample-accurate on a clean stem and flags spurious hits', () => {
  const events: ScoreEvent[] = [0.05, 0.3, 0.55].map((t, i) => ({
    time: t, audibleTime: t, step: i, track: 'snare', velocity: 1, source: 'sequencer' as const,
  }));
  const x = synth(events.map((e) => ({ t: e.time, decay: 0.1 })), 0.8);
  const v = verifyStemOnsets([x], SR, events, 'snare');
  assert.equal(v.failures.length, 0);
  assert.equal(v.spurious.length, 0);
  assert.ok(v.maxAbsErrorMs <= 0.3, `max err ${v.maxAbsErrorMs}`);

  // An unscheduled hit well outside any note's decay is flagged ...
  const extra = synth([...events.map((e) => ({ t: e.time, decay: 0.1 })), { t: 0.75, decay: 0.1 }], 1.0);
  const v2 = verifyStemOnsets([extra], SR, events, 'snare');
  assert.equal(v2.spurious.length, 1);
  assert.ok(Math.abs(v2.spurious[0] - 0.75) < 0.001);
  // ... while one inside a scheduled note's decay is attributed to that note.
  const inDecay = synth([...events.map((e) => ({ t: e.time, decay: 0.1 })), { t: 0.42, decay: 0.1 }], 1.0);
  assert.equal(verifyStemOnsets([inDecay], SR, events, 'snare').spurious.length, 0);

  // Masking: a quiet note right after a loud one is reported as masked, not failed.
  const withQuiet = [...events, { time: 0.31, audibleTime: 0.31, step: 9, track: 'snare', velocity: 0.2, source: 'chamber' as const }];
  const v3 = verifyStemOnsets([x], SR, withQuiet, 'snare');
  assert.equal(v3.failures.length, 0);
  assert.equal(v3.masked.length, 1);
});

test('compareBuffers: identical, scaled and shifted signals', () => {
  const a = synth([{ t: 0.1 }, { t: 0.3, freq: 300 }], 0.5);
  const same = compareBuffers(a, a, SR);
  assert.equal(same.identical, true);
  assert.equal(same.snrDb, Infinity);
  assert.ok(same.correlation > 0.99999);

  const quieter = a.map((v) => v * 0.5);
  const q = compareBuffers(a, quieter, SR);
  assert.equal(q.identical, false);
  assert.ok(q.correlation > 0.9999);
  assert.ok(Math.abs(q.maxWindowDiffDb - 6.02) < 0.1, `window diff ${q.maxWindowDiffDb}`);

  const shifted = new Float32Array(a.length);
  shifted.set(a.subarray(0, a.length - 10), 10);
  const s = compareBuffers(a, shifted, SR, { maxLagSamples: 20 });
  assert.equal(s.lagSamples, 10); // B is delayed by 10 samples
  assert.ok(s.correlation > 0.999);
});

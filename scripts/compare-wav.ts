/**
 * Compare two WAV files numerically and/or verify a WAV against a score.
 *
 *   npm run compare:wav -- a.wav b.wav
 *   npm run compare:wav -- a.tap.wav --score a.score.json --signal tap
 *   npm run compare:wav -- a.wav --score a.score.json            (master output; approximate, +-5 ms)
 *   npm run compare:wav -- hihat.tap.wav --score a.score.json --signal tap --stem hihat   (sample-accurate)
 *   npm run compare:wav -- a.wav b.wav --max-window-db 1 --min-corr 0.999
 *
 * Exit code 0 = within tolerances, 1 = mismatch.
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { decodeWav } from '../src/core/render/WavCodec.ts';
import {
  compareBuffers,
  detectOnsets,
  matchOnsets,
  toMono,
  verifyScore,
  verifyStemOnsets,
} from '../src/core/analysis/AudioAnalysis.ts';
import type { ScoreEvent } from '../src/core/render/RenderConfig.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    score: { type: 'string' },
    /** 'tap' when <a.wav> is a pre-compressor tap, 'master' for a normal render. */
    signal: { type: 'string', default: 'master' },
    /** Treat <a.wav> as a solo stem of this track and check onsets sample-accurately. */
    stem: { type: 'string' },
    'max-window-db': { type: 'string', default: '1.0' },
    'min-corr': { type: 'string', default: '0.999' },
    'max-lag': { type: 'string', default: '48' },
    'onset-tolerance-ms': { type: 'string', default: '2' },
    json: { type: 'boolean', default: false },
  },
});

function loadWav(p: string) {
  return decodeWav(fs.readFileSync(p));
}

let failed = false;
const report: Record<string, unknown> = {};

const [pathA, pathB] = positionals;
if (!pathA) {
  console.error('usage: compare-wav <a.wav> [b.wav] [--score a.score.json]');
  process.exit(2);
}
const a = loadWav(pathA);
const monoA = toMono(a.channels);

if (pathB) {
  const b = loadWav(pathB);
  if (a.sampleRate !== b.sampleRate) {
    console.error(`sample rate mismatch: ${a.sampleRate} vs ${b.sampleRate}`);
    process.exit(1);
  }
  const monoB = toMono(b.channels);
  const cmp = compareBuffers(monoA, monoB, a.sampleRate, { maxLagSamples: Number(values['max-lag']) });
  const maxWindowDb = Number(values['max-window-db']);
  const minCorr = Number(values['min-corr']);
  const ok = cmp.identical || (cmp.correlation >= minCorr && cmp.maxWindowDiffDb <= maxWindowDb && cmp.lagSamples === 0);
  if (!ok) failed = true;
  report.compare = { ...cmp, ok };

  if (!values.json) {
    console.log(`A: ${pathA}  (${cmp.lengthA} frames)`);
    console.log(`B: ${pathB}  (${cmp.lengthB} frames)`);
    console.log(`  identical (bit-exact):      ${cmp.identical}`);
    console.log(`  max |a-b|:                  ${cmp.maxAbsDiff.toExponential(3)}`);
    console.log(`  RMS a / b / diff:           ${cmp.rmsA.toFixed(5)} / ${cmp.rmsB.toFixed(5)} / ${cmp.rmsDiff.toExponential(3)}`);
    console.log(`  SNR (a vs diff):            ${cmp.snrDb === Infinity ? 'inf' : cmp.snrDb.toFixed(1) + ' dB'}`);
    console.log(`  correlation @ lag:          ${cmp.correlation.toFixed(6)} @ ${cmp.lagSamples} samples`);
    console.log(`  max windowed level diff:    ${cmp.maxWindowDiffDb.toFixed(2)} dB (limit ${maxWindowDb})`);
    console.log(`  => ${ok ? 'MATCH' : 'MISMATCH'}`);
  }

  // Blind onset agreement between the two files.
  const onsetsA = detectOnsets(monoA, a.sampleRate);
  const onsetsB = detectOnsets(monoB, b.sampleRate);
  const tol = Number(values['onset-tolerance-ms']) / 1000;
  const m = matchOnsets(onsetsA, onsetsB, tol);
  report.onsets = { countA: onsetsA.length, countB: onsetsB.length, matched: m.matched.length, missing: m.missing, spurious: m.spurious };
  if (m.missing.length || m.spurious.length) failed = true;
  if (!values.json) {
    console.log(`  onsets A/B:                 ${onsetsA.length} / ${onsetsB.length}, matched ${m.matched.length}, ` +
      `missing-in-B ${m.missing.length}, extra-in-B ${m.spurious.length}`);
  }
}

if (values.score && values.stem) {
  const scoreFile = JSON.parse(fs.readFileSync(values.score, 'utf8')) as { score: ScoreEvent[] };
  const signal = values.signal === 'tap' ? 'tap' : 'master';
  const v = verifyStemOnsets(a.channels, a.sampleRate, scoreFile.score, values.stem, { signal });
  report.stem = {
    track: values.stem,
    events: v.checks.length,
    failures: v.failures.map((f) => ({ time: f.event.time, reason: f.reason })),
    spurious: v.spurious,
    maxAbsErrorMs: v.maxAbsErrorMs,
  };
  if (v.failures.length || v.spurious.length) failed = true;
  if (!values.json) {
    console.log(`Stem check (${values.stem}, ${signal} signal): ${pathA} vs ${values.score}`);
    console.log(`  events found at their time:  ${v.checks.length - v.failures.length} / ${v.checks.length}`);
    console.log(`  max timing error:            ${v.maxAbsErrorMs.toFixed(3)} ms`);
    if (v.masked.length) console.log(`  masked (louder note nearby): ${v.masked.length}`);
    console.log(`  unexpected onsets:           ${v.spurious.length}${v.spurious.length ? ' at ' + v.spurious.map((t) => t.toFixed(4) + 's').join(', ') : ''}`);
    for (const f of v.failures) console.log(`  FAIL ${f.event.source} note @ ${f.event.time.toFixed(4)}s: ${f.reason}`);
  }
} else if (values.score) {
  const scoreFile = JSON.parse(fs.readFileSync(values.score, 'utf8')) as { score: ScoreEvent[] };
  const signal = values.signal === 'tap' ? 'tap' : 'master';
  const v = verifyScore(a.channels, a.sampleRate, scoreFile.score, { signal });
  report.score = {
    events: v.checks.length,
    failures: v.failures.map((f) => ({ time: f.event.time, track: f.event.track, reason: f.reason })),
    maxAbsErrorMs: v.maxAbsErrorMs,
    meanAbsErrorMs: v.meanAbsErrorMs,
  };
  if (v.failures.length) failed = true;
  if (!values.json) {
    console.log(`Score check (${signal} signal): ${pathA} vs ${values.score}`);
    console.log(`  events verified:            ${v.checks.length - v.failures.length} / ${v.checks.length}`);
    console.log(`  timing error (mean / max):  ${v.meanAbsErrorMs.toFixed(3)} / ${v.maxAbsErrorMs.toFixed(3)} ms`);
    for (const f of v.failures) {
      console.log(`  FAIL step ${f.event.step} ${f.event.track} @ ${f.event.time.toFixed(4)}s: ${f.reason}`);
    }
  }
}

if (values.json) console.log(JSON.stringify(report, null, 2));
process.exit(failed ? 1 : 0);

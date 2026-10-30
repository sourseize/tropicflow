import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type ExportOptions,
  buildExportFilename,
  estimateExportBytes,
  formatClock,
  isFullRange,
  resolveRange,
  sliceChannels,
} from '../../src/core/export/ExportOptions.ts';
import { clampMaxSeconds } from '../../src/core/record/TakeRecorder.ts';

const SR = 1000; // 1 kHz keeps the arithmetic readable
const wav = (o: Partial<ExportOptions> = {}): ExportOptions => ({ format: 'wav', startSeconds: 0, durationSeconds: 10, bitDepth: 32, bitrateKbps: 128, ...o });
const ogg = (o: Partial<ExportOptions> = {}): ExportOptions => ({ format: 'ogg', startSeconds: 0, durationSeconds: 10, bitDepth: 32, bitrateKbps: 128, ...o });

describe('resolveRange', () => {
  test('clamps start and duration to the source', () => {
    assert.deepEqual(resolveRange(10000, SR, 2, 3), { startFrame: 2000, frames: 3000, startSeconds: 2, durationSeconds: 3 });
    assert.deepEqual(resolveRange(10000, SR, 8, 5), { startFrame: 8000, frames: 2000, startSeconds: 8, durationSeconds: 2 });
    assert.deepEqual(resolveRange(10000, SR, 12, 5), { startFrame: 10000, frames: 0, startSeconds: 10, durationSeconds: 0 });
    assert.deepEqual(resolveRange(10000, SR, -3, 2), { startFrame: 0, frames: 2000, startSeconds: 0, durationSeconds: 2 });
  });

  test('an end within 50 ms of the source end snaps to it (the UI rounds lengths to 0.1 s)', () => {
    // 2.83 s source shown as "2.8" must still export everything
    const total = Math.round(2.83 * 44100);
    const r = resolveRange(total, 44100, 0, 2.8);
    assert.equal(r.frames, total);
    assert.ok(isFullRange(r, total));
    assert.equal(resolveRange(total, 44100, 1, 1.8).frames, total - 44100);
    // but 2.7 is a real request
    assert.equal(resolveRange(total, 44100, 0, 2.7).frames, Math.round(2.7 * 44100));
    assert.equal(resolveRange(total, 44100, 0, 2.7, 0).frames, Math.round(2.7 * 44100));
  });

  test('non-finite values fall back to "everything"', () => {
    assert.deepEqual(resolveRange(10000, SR, NaN, NaN), { startFrame: 0, frames: 10000, startSeconds: 0, durationSeconds: 10 });
    assert.ok(isFullRange(resolveRange(10000, SR, 0, 10), 10000));
    assert.ok(!isFullRange(resolveRange(10000, SR, 0, 9.5), 10000));
  });
});

describe('sliceChannels', () => {
  test('copies the range and fades the edges over 5 ms', () => {
    const src = [new Float32Array(10000).fill(1), new Float32Array(10000).fill(-1)];
    const range = resolveRange(10000, SR, 1, 2);
    const out = sliceChannels(src, SR, range);
    assert.equal(out.length, 2);
    assert.equal(out[0].length, 2000);
    // 5 ms at 1 kHz = 5 samples of fade at each end
    assert.ok(out[0][0] < 0.2 && out[0][0] > 0);
    assert.ok(out[0][4] < 1 && out[0][4] > 0.8);
    assert.equal(out[0][5], 1);
    assert.equal(out[0][1000], 1);
    assert.equal(out[0][2000 - 6], 1);
    assert.ok(out[0][1999] < 0.2 && out[0][1999] > 0);
    assert.ok(out[1][0] > -0.2 && out[1][0] < 0);
    // source untouched
    assert.equal(src[0][1000], 1);
  });

  test('very short slices shorten the fade instead of overlapping', () => {
    const src = [new Float32Array(100).fill(1)];
    const out = sliceChannels(src, SR, resolveRange(100, SR, 0, 0.004));
    assert.equal(out[0].length, 4);
    assert.ok(out[0].every((v) => v > 0 && v < 1));
  });
});

describe('file names and sizes', () => {
  test('full-range 32-bit float WAV keeps the plain stem', () => {
    const range = resolveRange(441000, 44100, 0, 10);
    assert.equal(buildExportFilename('tropicflow-120bpm-2bars', wav(), range, true), 'tropicflow-120bpm-2bars.wav');
    assert.equal(buildExportFilename('tropicflow-take-120bpm', wav({ bitDepth: 16 }), range, true), 'tropicflow-take-120bpm-16bit.wav');
  });

  test('partial ranges and ogg bitrates are encoded in the name', () => {
    const range = resolveRange(441000, 44100, 2.5, 4);
    assert.equal(buildExportFilename('tropicflow-take-120bpm', ogg({ bitrateKbps: 96 }), range, false), 'tropicflow-take-120bpm-2.5s-4s-96k.ogg');
    assert.equal(buildExportFilename('x', wav({ bitDepth: 24 }), range, false), 'x-2.5s-4s-24bit.wav');
  });

  test('size estimates are in the right ballpark', () => {
    assert.equal(estimateExportBytes(wav({ bitDepth: 16 }), 44100, 44100, 2), 44 + 44100 * 4);
    const oggBytes = estimateExportBytes(ogg({ bitrateKbps: 128 }), 441000, 44100, 2);
    assert.ok(oggBytes > 155_000 && oggBytes < 170_000, String(oggBytes));
  });

  test('formatClock', () => {
    assert.equal(formatClock(0), '00:00');
    assert.equal(formatClock(65.4), '01:05');
    assert.equal(formatClock(65.46, 1), '01:05.5');
    assert.equal(formatClock(600), '10:00');
  });
});

describe('TakeRecorder limits', () => {
  test('max length is clamped to 1..600 s', () => {
    assert.equal(clampMaxSeconds(0), 1);
    assert.equal(clampMaxSeconds(60), 60);
    assert.equal(clampMaxSeconds(9999), 600);
    assert.equal(clampMaxSeconds(NaN), 60);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWav, encodeWav } from '../../src/core/render/WavCodec.ts';

const makeSignal = (n: number) => {
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
    r[i] = Math.sin((2 * Math.PI * 220 * i) / 48000) * 0.25;
  }
  return [l, r];
};

test('32-bit float round-trips bit-exactly', () => {
  const ch = makeSignal(1000);
  const wav = encodeWav(ch, 48000, 32);
  const d = decodeWav(wav);
  assert.equal(d.sampleRate, 48000);
  assert.equal(d.bitDepth, 32);
  assert.equal(d.channels.length, 2);
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < 1000; i++) assert.equal(d.channels[c][i], ch[c][i]);
  }
});

test('16-bit and 24-bit PCM round-trip within quantisation error', () => {
  const ch = makeSignal(1000);
  for (const [depth, maxErr] of [[16, 1 / 32768], [24, 1 / 8388608]] as const) {
    const d = decodeWav(encodeWav(ch, 44100, depth));
    assert.equal(d.sampleRate, 44100);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < 1000; i++) {
        assert.ok(Math.abs(d.channels[c][i] - ch[c][i]) <= maxErr * 1.01, `depth ${depth} idx ${i}`);
      }
    }
  }
});

test('header sizes are consistent', () => {
  const ch = makeSignal(10);
  const wav = encodeWav(ch, 48000, 16);
  assert.equal(wav.byteLength, 44 + 10 * 2 * 2);
  const view = new DataView(wav);
  assert.equal(view.getUint32(4, true), wav.byteLength - 8);
  assert.equal(String.fromCharCode(...new Uint8Array(wav, 0, 4)), 'RIFF');
});

test('rejects malformed input', () => {
  assert.throws(() => decodeWav(new ArrayBuffer(12)));
  assert.throws(() => encodeWav([], 48000));
  assert.throws(() => encodeWav([new Float32Array(3), new Float32Array(4)], 48000));
});

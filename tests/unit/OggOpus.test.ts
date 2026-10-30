import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPUS_FRAME_SAMPLES,
  buildOpusHead,
  buildOpusTags,
  inspectOggOpus,
  lacingValues,
  muxOggOpus,
  oggCrc32,
  parseOggPages,
  parseOpusHead,
} from '../../src/core/export/OggOpus.ts';

/** Bitwise reference CRC (independent of the table-driven implementation). */
function referenceCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 24;
    for (let k = 0; k < 8; k++) crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
  }
  return crc >>> 0;
}

/** A fake packet whose TOC byte says "one 20 ms frame" (config 15, code 0). */
function fakePacket(i: number, length: number): Uint8Array {
  const p = new Uint8Array(length);
  for (let j = 0; j < length; j++) p[j] = (i * 31 + j * 7) & 0xff;
  p[0] = 15 << 3;
  return p;
}

describe('Ogg CRC-32', () => {
  test('matches a bitwise reference implementation', () => {
    const data = Uint8Array.from({ length: 1000 }, (_, i) => (i * 131 + 7) & 0xff);
    assert.equal(oggCrc32(data), referenceCrc(data));
    assert.equal(oggCrc32(new Uint8Array(0)), 0);
    assert.equal(oggCrc32(Uint8Array.from([0x4f, 0x67, 0x67, 0x53])), referenceCrc(Uint8Array.from([0x4f, 0x67, 0x67, 0x53])));
  });
});

describe('Opus headers', () => {
  test('OpusHead round-trips and follows RFC 7845 layout', () => {
    const head = buildOpusHead(2, 312, 44100);
    assert.equal(head.length, 19);
    assert.equal(String.fromCharCode(...head.subarray(0, 8)), 'OpusHead');
    const parsed = parseOpusHead(head);
    assert.deepEqual(parsed, { version: 1, channels: 2, preSkip: 312, inputSampleRate: 44100, outputGain: 0, mappingFamily: 0 });
    assert.throws(() => buildOpusHead(3, 0, 48000));
  });

  test('OpusTags carries vendor and comments', () => {
    const tags = buildOpusTags('tropicflow', ['ENCODER=tropicflow', 'TITLE=groove']);
    assert.equal(String.fromCharCode(...tags.subarray(0, 8)), 'OpusTags');
    const view = new DataView(tags.buffer);
    assert.equal(view.getUint32(8, true), 'tropicflow'.length);
    assert.equal(view.getUint32(8 + 4 + 'tropicflow'.length, true), 2);
    assert.equal(tags.length, 8 + 4 + 10 + 4 + (4 + 18) + (4 + 12));
  });
});

describe('Ogg lacing', () => {
  test('splits packets into 255-byte segments with a terminating short segment', () => {
    assert.deepEqual(lacingValues([10]), [10]);
    assert.deepEqual(lacingValues([255]), [255, 0]);
    assert.deepEqual(lacingValues([300, 0]), [255, 45, 0]);
    assert.deepEqual(lacingValues([510, 1]), [255, 255, 0, 1]);
  });
});

describe('muxOggOpus', () => {
  const packets = Array.from({ length: 130 }, (_, i) => fakePacket(i, 200 + (i % 5) * 60));
  const lengthSamples48k = 130 * OPUS_FRAME_SAMPLES - 500; // last frame was padded by the encoder
  const file = muxOggOpus({ packets, channels: 2, preSkip: 312, inputSampleRate: 44100, lengthSamples48k, serial: 0x1234abcd });

  test('every page has a valid CRC, the right serial and consecutive sequence numbers', () => {
    const pages = parseOggPages(file);
    assert.ok(pages.length >= 3);
    pages.forEach((p, i) => {
      assert.ok(p.crcOk, `page ${i} CRC`);
      assert.equal(p.serial, 0x1234abcd);
      assert.equal(p.pageSequence, i);
    });
  });

  test('header pages: BOS OpusHead alone, then OpusTags alone, both with granule 0', () => {
    const pages = parseOggPages(file);
    assert.ok(pages[0].flags.bos && !pages[0].flags.eos);
    assert.equal(pages[0].packets.length, 1);
    assert.equal(parseOpusHead(pages[0].packets[0]).preSkip, 312);
    assert.equal(pages[0].granulePosition, 0n);
    assert.equal(pages[1].packets.length, 1);
    assert.equal(String.fromCharCode(...pages[1].packets[0].subarray(0, 8)), 'OpusTags');
    assert.equal(pages[1].granulePosition, 0n);
    assert.ok(!pages[1].flags.bos && !pages[1].flags.eos);
  });

  test('audio pages carry the packets byte-exact, granules count 48 kHz samples, last page is EOS and trimmed', () => {
    const pages = parseOggPages(file);
    const audioPages = pages.slice(2);
    const recovered = audioPages.flatMap((p) => p.packets);
    assert.equal(recovered.length, packets.length);
    recovered.forEach((p, i) => assert.deepEqual(p, packets[i]));

    let count = 0;
    audioPages.forEach((p, i) => {
      count += p.packets.length;
      const isLast = i === audioPages.length - 1;
      assert.equal(p.flags.eos, isLast);
      if (!isLast) assert.equal(p.granulePosition, BigInt(count * OPUS_FRAME_SAMPLES));
    });
    assert.equal(audioPages[audioPages.length - 1].granulePosition, BigInt(312 + lengthSamples48k));

    const info = inspectOggOpus(file);
    assert.equal(info.audioPackets, 130);
    assert.ok(Math.abs(info.durationSeconds - lengthSamples48k / 48000) < 1e-9);
    assert.equal(info.head.channels, 2);
  });

  test('granule positions follow each packet\'s TOC duration when no fixed size is given', () => {
    const p60 = Uint8Array.from([(3 << 3) | 0, 1, 2, 3]); // SILK NB 60 ms -> 2880 samples
    const p20x2 = Uint8Array.from([(15 << 3) | 1, 1, 2]); // two 20 ms frames -> 1920
    const file = muxOggOpus({ packets: [p60, p20x2, p60], channels: 2, preSkip: 0, inputSampleRate: 48000, lengthSamples48k: 10000, packetsPerPage: 1 });
    const pages = parseOggPages(file).slice(2);
    assert.deepEqual(pages.map((p) => Number(p.granulePosition)), [2880, 4800, 7680]);
    assert.throws(() => muxOggOpus({ packets: [p60], channels: 2, preSkip: 70000, inputSampleRate: 48000, lengthSamples48k: 1 }));
  });

  test('reader reassembles a packet that continues onto the next page', () => {
    // Hand-build: page A holds 255-byte lacing of a 300-byte packet's first part, page B continues it.
    const big = fakePacket(1, 300);
    const fileA = muxOggOpus({ packets: [big], channels: 2, preSkip: 0, inputSampleRate: 48000, lengthSamples48k: 960, serial: 7 });
    const pages = parseOggPages(fileA);
    // Split the audio page manually into two pages to simulate a continuation.
    const audio = pages[2];
    assert.equal(audio.packets.length, 1);
    const head = Uint8Array.from([...'OggS'].map((c) => c.charCodeAt(0)));
    const mk = (flags: number, seq: number, granule: bigint, lacing: number[], body: Uint8Array) => {
      const page = new Uint8Array(27 + lacing.length + body.length);
      const v = new DataView(page.buffer);
      page.set(head, 0);
      page[5] = flags;
      v.setBigUint64(6, granule, true);
      v.setUint32(14, 7, true);
      v.setUint32(18, seq, true);
      page[26] = lacing.length;
      page.set(lacing, 27);
      page.set(body, 27 + lacing.length);
      v.setUint32(22, oggCrc32(page), true);
      return page;
    };
    const first = mk(0, 2, 0xffffffffffffffffn, [255], big.subarray(0, 255));
    const second = mk(0x01 | 0x04, 3, 960n, [45], big.subarray(255));
    const rebuilt = new Uint8Array([...fileA.subarray(0, fileA.length - audio.byteLength), ...first, ...second]);
    const parsed = parseOggPages(rebuilt);
    assert.equal(parsed.length, 4);
    assert.ok(parsed.every((p) => p.crcOk));
    assert.equal(parsed[2].packets.length, 0);
    assert.equal(parsed[2].partial.length, 255);
    assert.equal(parsed[3].packets.length, 1);
    assert.deepEqual(parsed[3].packets[0], big);
  });

  test('respects the packets-per-page limit and rejects empty input', () => {
    const small = muxOggOpus({ packets: packets.slice(0, 7), channels: 1, preSkip: 0, inputSampleRate: 48000, lengthSamples48k: 7 * 960, packetsPerPage: 3 });
    const pages = parseOggPages(small);
    assert.equal(pages.length - 2, 3); // 3 + 3 + 1
    assert.equal(pages[pages.length - 1].granulePosition, BigInt(7 * 960));
    assert.throws(() => muxOggOpus({ packets: [], channels: 2, preSkip: 0, inputSampleRate: 48000, lengthSamples48k: 0 }));
  });

  test('a corrupted byte is detected by the CRC', () => {
    const corrupted = file.slice();
    corrupted[corrupted.length - 10] ^= 0xff;
    const pages = parseOggPages(corrupted);
    assert.equal(pages[pages.length - 1].crcOk, false);
    assert.ok(pages.slice(0, -1).every((p) => p.crcOk));
  });
});

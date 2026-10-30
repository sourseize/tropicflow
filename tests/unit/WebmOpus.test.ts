import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { opusPacketSamples } from '../../src/core/export/OpusPacket.ts';
import { WEBM_ID, concatBytes, extractOpusFromWebm, webmElement, webmSimpleBlock } from '../../src/core/export/WebmOpus.ts';
import { buildOpusHead } from '../../src/core/export/OggOpus.ts';

describe('opusPacketSamples (TOC)', () => {
  test('frame sizes and frame counts per RFC 6716', () => {
    assert.equal(opusPacketSamples(Uint8Array.from([(0 << 3) | 0])), 480); // SILK NB 10 ms
    assert.equal(opusPacketSamples(Uint8Array.from([(3 << 3) | 0])), 2880); // SILK NB 60 ms
    assert.equal(opusPacketSamples(Uint8Array.from([(15 << 3) | 0])), 960); // Hybrid FB 20 ms
    assert.equal(opusPacketSamples(Uint8Array.from([(16 << 3) | 0])), 120); // CELT NB 2.5 ms
    assert.equal(opusPacketSamples(Uint8Array.from([(31 << 3) | 2])), 1920); // two 20 ms CELT FB frames
    assert.equal(opusPacketSamples(Uint8Array.from([(31 << 3) | 3, 0x83])), 2880); // code 3, 3 frames (VBR flag set)
    assert.equal(opusPacketSamples(new Uint8Array(0)), 0);
    assert.throws(() => opusPacketSamples(Uint8Array.from([(31 << 3) | 3])));
  });
});

describe('extractOpusFromWebm', () => {
  const frames = [Uint8Array.from([0x78, 1, 2, 3]), Uint8Array.from([0x78, 4, 5]), Uint8Array.from([0x78, 6, 7, 8, 9])];
  const head = buildOpusHead(2, 312, 48000);
  const ebmlHeader = webmElement(WEBM_ID.EBML, webmElement(0x4282, Uint8Array.from([...'webm'].map((c) => c.charCodeAt(0)))));
  const trackEntry = webmElement(
    WEBM_ID.TrackEntry,
    concatBytes([
      webmElement(WEBM_ID.TrackNumber, Uint8Array.from([1])),
      webmElement(WEBM_ID.CodecID, Uint8Array.from([...'A_OPUS'].map((c) => c.charCodeAt(0)))),
      webmElement(WEBM_ID.CodecPrivate, head),
      webmElement(WEBM_ID.CodecDelay, Uint8Array.from([0x00, 0x63, 0x2e, 0xa0])), // 6 500 000 ns = 312 samples
    ])
  );
  const tracks = webmElement(WEBM_ID.Tracks, trackEntry);
  const cluster = (unknown: boolean) =>
    webmElement(
      WEBM_ID.Cluster,
      concatBytes([
        webmElement(0xe7, Uint8Array.from([0])), // Timecode
        webmSimpleBlock(1, 0, frames[0]),
        webmSimpleBlock(1, 20, frames[1]),
        webmElement(WEBM_ID.BlockGroup, webmElement(WEBM_ID.Block, concatBytes([Uint8Array.from([0x81, 0, 40, 0x00]), frames[2]]))),
      ]),
      unknown
    );

  test('reads CodecPrivate, CodecDelay and every block of a sized file', () => {
    const file = concatBytes([ebmlHeader, webmElement(WEBM_ID.Segment, concatBytes([tracks, cluster(false)]))]);
    const s = extractOpusFromWebm(file);
    assert.equal(s.codecId, 'A_OPUS');
    assert.deepEqual(s.codecPrivate, head);
    assert.equal(s.codecDelaySamples, 312);
    assert.deepEqual(s.packets, frames);
  });

  test('handles unknown-size Segment and Cluster (live MediaRecorder output)', () => {
    const file = concatBytes([ebmlHeader, webmElement(WEBM_ID.Segment, concatBytes([tracks, cluster(true), cluster(true)]), true)]);
    const s = extractOpusFromWebm(file);
    assert.equal(s.packets.length, 6);
    assert.deepEqual(s.packets[3], frames[0]);
  });

  test('rejects non-WebM input and non-Opus tracks', () => {
    assert.throws(() => extractOpusFromWebm(Uint8Array.from([0x4f, 0x67, 0x67, 0x53])));
    const vorbis = webmElement(WEBM_ID.TrackEntry, concatBytes([webmElement(WEBM_ID.TrackNumber, Uint8Array.from([1])), webmElement(WEBM_ID.CodecID, Uint8Array.from([...'A_VORBIS'].map((c) => c.charCodeAt(0))))]));
    assert.throws(() => extractOpusFromWebm(concatBytes([ebmlHeader, webmElement(WEBM_ID.Segment, webmElement(WEBM_ID.Tracks, vorbis))])), /not Opus/);
  });
});

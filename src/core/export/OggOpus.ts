/**
 * Ogg container for Opus (RFC 3533 + RFC 7845), pure TypeScript.
 *
 * The browser's WebCodecs `AudioEncoder` produces raw Opus packets but no
 * container; this module wraps them into an `.ogg` file any player can open.
 * It also contains a small reader so tests (Node) can verify produced files
 * page by page: CRCs, headers, granule positions, EOS.
 */

import { opusPacketSamples } from './OpusPacket.ts';

export const OPUS_SAMPLE_RATE = 48000;
export const OPUS_FRAME_SAMPLES = 960; // 20 ms at 48 kHz
/** Largest pre-skip the 16-bit OpusHead field can express. */
export const MAX_PRE_SKIP = 0xffff;

export interface OggOpusMuxParams {
  /** Raw Opus packets in order (one per 20 ms frame). */
  packets: Uint8Array[];
  channels: number;
  /** Encoder delay in 48 kHz samples (from OpusHead of the encoder, typically 312). */
  preSkip: number;
  /** Original sample rate before resampling to 48 kHz (informational, stored in OpusHead). */
  inputSampleRate: number;
  /**
   * Length of the original audio in 48 kHz samples. The last page's granule
   * position is set to `preSkip + lengthSamples48k` so decoders trim the
   * padding the encoder appended to the final frame.
   */
  lengthSamples48k: number;
  /** Samples per packet at 48 kHz; when omitted each packet's TOC byte is parsed. */
  samplesPerPacket?: number;
  /** Logical bitstream serial number (random when omitted; fixed in tests). */
  serial?: number;
  /** Vendor string for OpusTags. */
  vendor?: string;
  /** Extra `KEY=value` comments for OpusTags. */
  comments?: string[];
  /** Upper bound of packets per page (default 50 = 1 s). */
  packetsPerPage?: number;
}

// ---------------------------------------------------------------------------
// CRC-32 as used by Ogg: polynomial 0x04c11db7, no reflection, init 0, no final xor.
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    table[i] = r >>> 0;
  }
  return table;
})();

export function oggCrc32(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

const ASCII = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const UTF8 = (s: string) => new TextEncoder().encode(s);

export function buildOpusHead(channels: number, preSkip: number, inputSampleRate: number): Uint8Array {
  if (channels < 1 || channels > 2) throw new Error(`buildOpusHead: ${channels} channels needs a channel mapping table`);
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set(ASCII('OpusHead'), 0);
  head[8] = 1; // version
  head[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputSampleRate, true);
  view.setInt16(16, 0, true); // output gain (Q7.8 dB)
  head[18] = 0; // channel mapping family 0 (mono/stereo)
  return head;
}

export function buildOpusTags(vendor: string, comments: string[] = []): Uint8Array {
  const vendorBytes = UTF8(vendor);
  const commentBytes = comments.map(UTF8);
  const size = 8 + 4 + vendorBytes.length + 4 + commentBytes.reduce((n, c) => n + 4 + c.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let p = 0;
  out.set(ASCII('OpusTags'), p);
  p += 8;
  view.setUint32(p, vendorBytes.length, true);
  p += 4;
  out.set(vendorBytes, p);
  p += vendorBytes.length;
  view.setUint32(p, commentBytes.length, true);
  p += 4;
  for (const c of commentBytes) {
    view.setUint32(p, c.length, true);
    p += 4;
    out.set(c, p);
    p += c.length;
  }
  return out;
}

export interface OpusHead {
  version: number;
  channels: number;
  preSkip: number;
  inputSampleRate: number;
  outputGain: number;
  mappingFamily: number;
}

export function parseOpusHead(bytes: Uint8Array): OpusHead {
  if (bytes.length < 19 || String.fromCharCode(...bytes.subarray(0, 8)) !== 'OpusHead') {
    throw new Error('parseOpusHead: not an OpusHead packet');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: bytes[8],
    channels: bytes[9],
    preSkip: view.getUint16(10, true),
    inputSampleRate: view.getUint32(12, true),
    outputGain: view.getInt16(16, true),
    mappingFamily: bytes[18],
  };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const FLAG_CONTINUED = 0x01;
const FLAG_BOS = 0x02;
const FLAG_EOS = 0x04;

/** Segment table (lacing values) for whole packets placed on one page. */
export function lacingValues(packetLengths: number[]): number[] {
  const lacing: number[] = [];
  for (const len of packetLengths) {
    let remaining = len;
    while (remaining >= 255) {
      lacing.push(255);
      remaining -= 255;
    }
    lacing.push(remaining); // a final 0 terminates packets that are a multiple of 255
  }
  return lacing;
}

function buildPage(
  packets: Uint8Array[],
  granulePosition: bigint,
  serial: number,
  pageSequence: number,
  flags: number
): Uint8Array {
  const lacing = lacingValues(packets.map((p) => p.length));
  if (lacing.length > 255) throw new Error(`Ogg page would need ${lacing.length} segments (max 255)`);
  const bodyLength = packets.reduce((n, p) => n + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodyLength);
  const view = new DataView(page.buffer);
  page.set(ASCII('OggS'), 0);
  page[4] = 0; // stream structure version
  page[5] = flags;
  view.setBigUint64(6, granulePosition, true);
  view.setUint32(14, serial >>> 0, true);
  view.setUint32(18, pageSequence, true);
  view.setUint32(22, 0, true); // CRC placeholder
  page[26] = lacing.length;
  page.set(lacing, 27);
  let p = 27 + lacing.length;
  for (const packet of packets) {
    page.set(packet, p);
    p += packet.length;
  }
  view.setUint32(22, oggCrc32(page), true);
  return page;
}

/** Wrap Opus packets into a complete Ogg Opus file. */
export function muxOggOpus(params: OggOpusMuxParams): Uint8Array {
  const samplesOf = (p: Uint8Array) => params.samplesPerPacket ?? opusPacketSamples(p);
  const packetsPerPage = Math.max(1, params.packetsPerPage ?? 50);
  if (params.preSkip < 0 || params.preSkip > MAX_PRE_SKIP) throw new Error(`muxOggOpus: pre-skip ${params.preSkip} out of range`);
  const serial = params.serial ?? Math.floor(Math.random() * 0xffffffff);
  const { packets } = params;
  if (packets.length === 0) throw new Error('muxOggOpus: no packets');

  const pages: Uint8Array[] = [];
  let seq = 0;
  pages.push(buildPage([buildOpusHead(params.channels, params.preSkip, params.inputSampleRate)], 0n, serial, seq++, FLAG_BOS));
  pages.push(buildPage([buildOpusTags(params.vendor ?? 'tropicflow', params.comments)], 0n, serial, seq++, 0));

  const finalGranule = BigInt(params.preSkip + params.lengthSamples48k);
  let granule = 0n;
  for (let i = 0; i < packets.length; i += packetsPerPage) {
    const slice = packets.slice(i, i + packetsPerPage);
    const isLast = i + packetsPerPage >= packets.length;
    granule += BigInt(slice.reduce((n, p) => n + samplesOf(p), 0));
    // The last page is trimmed to the real length (RFC 7845 §4.4: end trimming).
    const pageGranule = isLast ? (finalGranule < granule ? finalGranule : granule) : granule;
    pages.push(buildPage(slice, pageGranule, serial, seq++, isLast ? FLAG_EOS : 0));
  }

  const total = pages.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const page of pages) {
    out.set(page, offset);
    offset += page.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reader (verification in tests / sanity checks)
// ---------------------------------------------------------------------------

export interface OggPage {
  flags: { continued: boolean; bos: boolean; eos: boolean };
  granulePosition: bigint;
  serial: number;
  pageSequence: number;
  crcOk: boolean;
  /** Packets that end on this page; one that started on an earlier page is reassembled. */
  packets: Uint8Array[];
  /** Bytes of a packet that continues on the next page (empty when none). */
  partial: Uint8Array;
  byteLength: number;
}

export function parseOggPages(bytes: Uint8Array): OggPage[] {
  const pages: OggPage[] = [];
  let offset = 0;
  let carry: number[] = [];
  while (offset + 27 <= bytes.length) {
    if (String.fromCharCode(...bytes.subarray(offset, offset + 4)) !== 'OggS') {
      throw new Error(`parseOggPages: bad capture pattern at byte ${offset}`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const flags = bytes[offset + 5];
    const numSegments = bytes[offset + 26];
    const lacing = bytes.subarray(offset + 27, offset + 27 + numSegments);
    const bodyLength = lacing.reduce((n, v) => n + v, 0);
    const pageLength = 27 + numSegments + bodyLength;
    if (offset + pageLength > bytes.length) throw new Error('parseOggPages: truncated page');

    const page = bytes.slice(offset, offset + pageLength);
    const storedCrc = view.getUint32(22, true);
    page[22] = page[23] = page[24] = page[25] = 0;
    const crcOk = oggCrc32(page) === storedCrc;

    const packets: Uint8Array[] = [];
    let bodyPos = 27 + numSegments;
    let current: number[] = flags & FLAG_CONTINUED ? carry : [];
    for (let i = 0; i < numSegments; i++) {
      const len = lacing[i];
      for (let k = 0; k < len; k++) current.push(page[bodyPos + k]);
      bodyPos += len;
      if (len < 255) {
        packets.push(Uint8Array.from(current));
        current = [];
      }
    }
    carry = current;

    pages.push({
      flags: { continued: !!(flags & FLAG_CONTINUED), bos: !!(flags & FLAG_BOS), eos: !!(flags & FLAG_EOS) },
      granulePosition: view.getBigUint64(6, true),
      serial: view.getUint32(14, true),
      pageSequence: view.getUint32(18, true),
      crcOk,
      packets,
      partial: Uint8Array.from(current),
      byteLength: pageLength,
    });
    offset += pageLength;
  }
  return pages;
}

/** Summary of an Ogg Opus file: header + duration derived from the last granule position. */
export function inspectOggOpus(bytes: Uint8Array): { head: OpusHead; pages: OggPage[]; durationSeconds: number; audioPackets: number } {
  const pages = parseOggPages(bytes);
  if (pages.length < 3) throw new Error('inspectOggOpus: expected at least 3 pages');
  const head = parseOpusHead(pages[0].packets[0]);
  const last = pages[pages.length - 1];
  const durationSeconds = Number(last.granulePosition - BigInt(head.preSkip)) / OPUS_SAMPLE_RATE;
  const audioPackets = pages.slice(2).reduce((n, p) => n + p.packets.length, 0);
  return { head, pages, durationSeconds, audioPackets };
}

/**
 * Minimal WebM (Matroska/EBML) reader: pulls the Opus packets out of what
 * `MediaRecorder` produces in Chromium (`audio/webm;codecs=opus`) so they can
 * be re-wrapped into Ogg. Pure TypeScript, no dependencies.
 *
 * Only what MediaRecorder writes is supported: one audio track, SimpleBlocks
 * (or BlockGroup/Block) without lacing, possibly unknown-size Segment/Cluster.
 */

export interface WebmOpusStream {
  packets: Uint8Array[];
  /** Raw `CodecPrivate` (an OpusHead) when present. */
  codecPrivate: Uint8Array | null;
  /** `CodecDelay` in 48 kHz samples (0 when absent). */
  codecDelaySamples: number;
  codecId: string | null;
}

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  Cluster: 0x1f43b675,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
} as const;

/** Elements whose children we walk into (everything else is skipped by size). */
const MASTERS = new Set<number>([ID.Segment, ID.Tracks, ID.TrackEntry, ID.Cluster, ID.BlockGroup]);

interface Vint {
  value: number;
  length: number;
  /** All value bits set: "unknown size" for element sizes. */
  unknown: boolean;
}

function readVint(bytes: Uint8Array, pos: number, keepMarker: boolean): Vint {
  if (pos >= bytes.length) throw new Error('webm: unexpected end of data');
  const first = bytes[pos];
  if (first === 0) throw new Error(`webm: invalid vint at ${pos}`);
  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    length++;
    mask >>= 1;
  }
  if (pos + length > bytes.length) throw new Error('webm: truncated vint');
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[pos + i];
    if (bytes[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function readUint(bytes: Uint8Array, start: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + bytes[start + i];
  return v;
}

export function extractOpusFromWebm(bytes: Uint8Array): WebmOpusStream {
  if (bytes.length < 4 || readVint(bytes, 0, true).value !== ID.EBML) {
    throw new Error('webm: missing EBML header');
  }
  const out: WebmOpusStream = { packets: [], codecPrivate: null, codecDelaySamples: 0, codecId: null };
  let opusTrack = -1;
  // Per TrackEntry scratch, committed when the entry is an Opus track.
  let entry: { number: number; codecId: string | null; codecPrivate: Uint8Array | null; codecDelay: number } | null = null;
  let entryEnd = -1;

  let pos = 0;
  while (pos < bytes.length) {
    if (entry && pos >= entryEnd) {
      commitEntry();
    }
    const id = readVint(bytes, pos, true);
    const size = readVint(bytes, pos + id.length, false);
    const dataStart = pos + id.length + size.length;
    const dataEnd = size.unknown ? bytes.length : Math.min(bytes.length, dataStart + size.value);

    if (MASTERS.has(id.value)) {
      if (id.value === ID.TrackEntry) {
        entry = { number: -1, codecId: null, codecPrivate: null, codecDelay: 0 };
        entryEnd = dataEnd;
      }
      pos = dataStart; // descend
      continue;
    }

    switch (id.value) {
      case ID.TrackNumber:
        if (entry) entry.number = readUint(bytes, dataStart, dataEnd - dataStart);
        break;
      case ID.CodecID:
        if (entry) entry.codecId = String.fromCharCode(...bytes.subarray(dataStart, dataEnd));
        break;
      case ID.CodecPrivate:
        if (entry) entry.codecPrivate = bytes.slice(dataStart, dataEnd);
        break;
      case ID.CodecDelay:
        if (entry) entry.codecDelay = readUint(bytes, dataStart, dataEnd - dataStart);
        break;
      case ID.SimpleBlock:
      case ID.Block: {
        const track = readVint(bytes, dataStart, false);
        const flags = bytes[dataStart + track.length + 2];
        const lacing = (flags >> 1) & 0x03;
        if (lacing !== 0) throw new Error('webm: laced blocks are not supported');
        if (opusTrack < 0 || track.value === opusTrack) {
          out.packets.push(bytes.slice(dataStart + track.length + 3, dataEnd));
        }
        break;
      }
      default:
        break;
    }
    pos = dataEnd;
  }
  if (entry) commitEntry();
  if (out.codecId !== null && out.codecId !== 'A_OPUS') throw new Error(`webm: track codec is ${out.codecId}, not Opus`);
  return out;

  function commitEntry(): void {
    if (entry && (entry.codecId === 'A_OPUS' || opusTrack < 0)) {
      opusTrack = entry.number;
      out.codecId = entry.codecId;
      out.codecPrivate = entry.codecPrivate;
      out.codecDelaySamples = Math.round((entry.codecDelay / 1e9) * 48000);
    }
    entry = null;
    entryEnd = -1;
  }
}

// ---------------------------------------------------------------------------
// Writer (tests only): build a tiny WebM so the reader can be exercised in Node.
// ---------------------------------------------------------------------------

function vintSize(n: number): Uint8Array {
  // 8-byte size vint: always unambiguous, never "unknown".
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = n;
  for (let i = 7; i >= 1; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function idBytes(id: number): Uint8Array {
  const b: number[] = [];
  let v = id;
  while (v > 0) {
    b.unshift(v % 256);
    v = Math.floor(v / 256);
  }
  return Uint8Array.from(b);
}

export function webmElement(id: number, payload: Uint8Array, unknownSize = false): Uint8Array {
  const size = unknownSize ? Uint8Array.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : vintSize(payload.length);
  const idb = idBytes(id);
  const out = new Uint8Array(idb.length + size.length + payload.length);
  out.set(idb, 0);
  out.set(size, idb.length);
  out.set(payload, idb.length + size.length);
  return out;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** SimpleBlock payload for one un-laced frame on `track`. */
export function webmSimpleBlock(track: number, timecode: number, frame: Uint8Array): Uint8Array {
  const head = Uint8Array.from([0x80 | track, (timecode >> 8) & 0xff, timecode & 0xff, 0x80]);
  return webmElement(ID.SimpleBlock, concatBytes([head, frame]));
}

export const WEBM_ID = ID;

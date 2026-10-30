/**
 * Minimal RIFF/WAVE encoder + decoder. Pure TypeScript: runs in the browser
 * (download button, render harness) and in Node (tests, CLI tools).
 */

export type WavBitDepth = 16 | 24 | 32; // 32 = IEEE float

export interface DecodedWav {
  sampleRate: number;
  bitDepth: WavBitDepth;
  channels: Float32Array[];
}

export function encodeWav(channels: Float32Array[], sampleRate: number, bitDepth: WavBitDepth = 32): ArrayBuffer {
  if (channels.length === 0) throw new Error('encodeWav: no channels');
  const numChannels = channels.length;
  const frames = channels[0].length;
  for (const ch of channels) {
    if (ch.length !== frames) throw new Error('encodeWav: channel length mismatch');
  }

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const isFloat = bitDepth === 32;
  const fmtChunkSize = isFloat ? 18 : 16;
  const factChunkBytes = isFloat ? 12 : 0;
  const headerBytes = 12 + (8 + fmtChunkSize) + factChunkBytes + 8;

  const buffer = new ArrayBuffer(headerBytes + dataBytes);
  const view = new DataView(buffer);
  let offset = 0;

  const writeString = (s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i));
  };
  const u32 = (v: number) => { view.setUint32(offset, v, true); offset += 4; };
  const u16 = (v: number) => { view.setUint16(offset, v, true); offset += 2; };

  writeString('RIFF');
  u32(headerBytes + dataBytes - 8);
  writeString('WAVE');

  writeString('fmt ');
  u32(fmtChunkSize);
  u16(isFloat ? 3 : 1); // 3 = IEEE float, 1 = PCM
  u16(numChannels);
  u32(sampleRate);
  u32(sampleRate * blockAlign);
  u16(blockAlign);
  u16(bitDepth);
  if (isFloat) u16(0); // cbSize

  if (isFloat) {
    writeString('fact');
    u32(4);
    u32(frames);
  }

  writeString('data');
  u32(dataBytes);

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const x = channels[c][i];
      if (isFloat) {
        view.setFloat32(offset, x, true);
        offset += 4;
      } else {
        const clamped = Math.max(-1, Math.min(1, x));
        if (bitDepth === 16) {
          view.setInt16(offset, Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), true);
          offset += 2;
        } else {
          const v = Math.round(clamped < 0 ? clamped * 8388608 : clamped * 8388607);
          view.setUint8(offset++, v & 0xff);
          view.setUint8(offset++, (v >> 8) & 0xff);
          view.setUint8(offset++, (v >> 16) & 0xff);
        }
      }
    }
  }
  return buffer;
}

/** Copy any byte view (e.g. a Node Buffer) into a standalone ArrayBuffer. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export function decodeWav(input: ArrayBuffer | Uint8Array): DecodedWav {
  const data = input instanceof Uint8Array ? toArrayBuffer(input) : input;
  const view = new DataView(data);
  const readString = (off: number, len: number) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
    return s;
  };
  if (readString(0, 4) !== 'RIFF' || readString(8, 4) !== 'WAVE') {
    throw new Error('decodeWav: not a RIFF/WAVE file');
  }

  let offset = 12;
  let format = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= view.byteLength) {
    const id = readString(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitDepth = view.getUint16(body + 14, true);
      if (format === 0xfffe) {
        // WAVE_FORMAT_EXTENSIBLE: sub-format GUID's first two bytes hold the real tag
        format = view.getUint16(body + 24, true);
      }
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, view.byteLength - body);
    }
    offset = body + size + (size % 2);
  }
  if (dataOffset < 0 || numChannels === 0) throw new Error('decodeWav: missing fmt/data chunk');
  if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) {
    throw new Error(`decodeWav: unsupported bit depth ${bitDepth}`);
  }

  const bytesPerSample = bitDepth / 8;
  const frames = Math.floor(dataLength / (bytesPerSample * numChannels));
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(frames));

  let p = dataOffset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let x: number;
      if (bitDepth === 32 && format === 3) {
        x = view.getFloat32(p, true);
      } else if (bitDepth === 32) {
        x = view.getInt32(p, true) / 2147483648;
      } else if (bitDepth === 16) {
        x = view.getInt16(p, true) / 32768;
      } else {
        let v = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16);
        if (v & 0x800000) v |= ~0xffffff;
        x = v / 8388608;
      }
      channels[c][i] = x;
      p += bytesPerSample;
    }
  }
  return { sampleRate, bitDepth: bitDepth as WavBitDepth, channels };
}

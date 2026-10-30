/**
 * Opus encoding in the browser, muxed into Ogg by OggOpus.ts.
 *
 * Preferred engine: WebCodecs `AudioEncoder` (faster than realtime, exact).
 * Fallback: MediaRecorder (realtime) for browsers / insecure contexts without
 * WebCodecs, see MediaRecorderOpus.ts. `detectOpusEngine()` tells which one
 * will be used; null means OGG export is unavailable.
 *
 * For WebCodecs the audio is resampled to 48 kHz first (Opus' native rate)
 * with an OfflineAudioContext, so the encoder never resamples internally and
 * the pre-skip it reports is exact.
 */
import { OPUS_FRAME_SAMPLES, OPUS_SAMPLE_RATE, muxOggOpus, parseOpusHead } from './OggOpus.ts';
import { ExportAbortedError } from './ExportOptions.ts';
import { encodeOggOpusRealtime, mediaRecorderOpusMime } from './MediaRecorderOpus.ts';

export type OpusEngine = 'webcodecs' | 'mediarecorder';

export interface OpusEncodeOptions {
  bitrateKbps: number;
  /** 0..1 */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Default libopus look-ahead at 48 kHz, used if the encoder does not report one. */
const FALLBACK_PRE_SKIP = 312;
/** Frames handed to the encoder between two yields to the event loop. */
const PACKETS_PER_YIELD = 25;

function hasWebCodecs(): boolean {
  return typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined';
}

/** Which Opus engine this browser offers (evaluated on each call: contexts differ). */
export function detectOpusEngine(): OpusEngine | null {
  if (hasWebCodecs()) return 'webcodecs';
  if (mediaRecorderOpusMime()) return 'mediarecorder';
  return null;
}

export function isOpusExportSupported(): boolean {
  return detectOpusEngine() !== null;
}

/** Encode stereo/mono float audio into a complete Ogg Opus file with whichever engine is available. */
export async function encodeOggOpus(channels: Float32Array[], sampleRate: number, options: OpusEncodeOptions): Promise<Uint8Array> {
  if (channels.length === 0 || channels[0].length === 0) throw new Error('encodeOggOpus: nothing to encode');
  const engine = detectOpusEngine();
  if (engine === null) throw new Error('This browser cannot encode Opus; export WAV instead');
  if (engine === 'mediarecorder') return encodeOggOpusRealtime(channels, sampleRate, options);
  return encodeOggOpusWebCodecs(channels, sampleRate, options);
}

async function encodeOggOpusWebCodecs(channels: Float32Array[], sampleRate: number, options: OpusEncodeOptions): Promise<Uint8Array> {
  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new ExportAbortedError();
  };

  const numChannels = Math.min(2, channels.length);
  const source = channels.length === 1 ? [channels[0], channels[0]] : channels.slice(0, 2);
  const pcm = sampleRate === OPUS_SAMPLE_RATE ? source : await resampleTo48k(source, sampleRate);
  throwIfAborted();

  const length48k = pcm[0].length;
  const packetCount = Math.ceil(length48k / OPUS_FRAME_SAMPLES);
  const packets: Uint8Array[] = [];
  let preSkip = FALLBACK_PRE_SKIP;
  let encoderError: Error | null = null;

  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const description = metadata?.decoderConfig?.description;
      if (description) {
        try {
          preSkip = parseOpusHead(toBytes(description)).preSkip;
        } catch {
          /* keep fallback */
        }
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push(data);
      // The encoder emits one extra packet on flush; cap progress at 1.
      options.onProgress?.(Math.min(1, packets.length / packetCount));
    },
    error: (e) => {
      encoderError = e instanceof Error ? e : new Error(String(e));
    },
  });

  try {
    encoder.configure({
      codec: 'opus',
      sampleRate: OPUS_SAMPLE_RATE,
      numberOfChannels: 2,
      bitrate: options.bitrateKbps * 1000,
      // Non-standard member on some typings; 20 ms is also the default.
      ...({ opus: { frameDuration: 20000 } } as object),
    });

    const frame = new Float32Array(OPUS_FRAME_SAMPLES * 2);
    for (let i = 0; i < packetCount; i++) {
      throwIfAborted();
      if (encoderError) throw encoderError;
      const start = i * OPUS_FRAME_SAMPLES;
      const n = Math.min(OPUS_FRAME_SAMPLES, length48k - start);
      frame.fill(0);
      frame.set(pcm[0].subarray(start, start + n), 0);
      frame.set(pcm[1].subarray(start, start + n), OPUS_FRAME_SAMPLES);
      encoder.encode(
        new AudioData({
          format: 'f32-planar',
          sampleRate: OPUS_SAMPLE_RATE,
          numberOfFrames: OPUS_FRAME_SAMPLES,
          numberOfChannels: 2,
          timestamp: Math.round((start / OPUS_SAMPLE_RATE) * 1e6),
          data: frame,
        })
      );
      if (i % PACKETS_PER_YIELD === PACKETS_PER_YIELD - 1) {
        // Let the UI repaint the progress bar and keep the encoder queue short.
        await new Promise<void>((r) => setTimeout(r, 0));
        while (encoder.encodeQueueSize > PACKETS_PER_YIELD * 4) {
          throwIfAborted();
          await new Promise<void>((r) => setTimeout(r, 5));
        }
      }
    }
    await encoder.flush();
    throwIfAborted();
    if (encoderError) throw encoderError;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }

  options.onProgress?.(1);
  return muxOggOpus({
    packets,
    channels: numChannels,
    preSkip,
    inputSampleRate: sampleRate,
    lengthSamples48k: length48k,
    vendor: 'tropicflow (WebCodecs opus)',
    comments: ['ENCODER=tropicflow', `ENCODER_OPTIONS=--bitrate ${options.bitrateKbps}`],
  });
}

function toBytes(buffer: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return new Uint8Array(buffer as ArrayBuffer);
}

async function resampleTo48k(channels: Float32Array[], sampleRate: number): Promise<Float32Array[]> {
  const frames = channels[0].length;
  const outFrames = Math.ceil((frames * OPUS_SAMPLE_RATE) / sampleRate);
  const ctx = new OfflineAudioContext({ numberOfChannels: channels.length, length: outFrames, sampleRate: OPUS_SAMPLE_RATE });
  const buffer = ctx.createBuffer(channels.length, frames, sampleRate);
  channels.forEach((ch, i) => buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();
  return Array.from({ length: channels.length }, (_, i) => rendered.getChannelData(i));
}

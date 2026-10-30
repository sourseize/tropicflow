/**
 * Opus fallback for browsers without WebCodecs (Firefox < 130, insecure
 * http:// contexts, ...): play the audio through a MediaStream into
 * `MediaRecorder`, which every browser can drive to Opus, then re-wrap the
 * packets into Ogg with exact trimming.
 *
 * MediaRecorder runs in realtime and its start/stop are not sample-accurate
 * (Chromium loses ~100 ms around a clip). To stay exact we record a small
 * programme instead of the bare slice:
 *
 *     [lead silence][sync burst][gap][ slice ][tail silence]
 *
 * Afterwards the recording is decoded (`decodeAudioData`) to locate the burst,
 * which pins the slice start to a sample; Ogg's pre-skip then hides
 * everything before the slice and the final granule position trims the tail.
 */
import { type OggPage, MAX_PRE_SKIP, OPUS_SAMPLE_RATE, muxOggOpus, parseOggPages, parseOpusHead } from './OggOpus.ts';
import { opusPacketSamples } from './OpusPacket.ts';
import { extractOpusFromWebm } from './WebmOpus.ts';
import { ExportAbortedError } from './ExportOptions.ts';

export interface RealtimeOpusOptions {
  bitrateKbps: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

const LEAD_SECONDS = 0.3;
const BURST_SECONDS = 0.01;
const GAP_SECONDS = 0.15;
const TAIL_SECONDS = 0.5;
const BURST_HZ = 1000;
const BURST_AMPLITUDE = 0.9;
const BURST_THRESHOLD = 0.3;

const MIME_CANDIDATES = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus'];

/** MIME type MediaRecorder can produce Opus in, or null when it cannot. */
export function mediaRecorderOpusMime(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof AudioContext === 'undefined') return null;
  for (const mime of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Seconds the realtime path needs for a slice of `seconds` (programme length). */
export function realtimeEncodeSeconds(seconds: number): number {
  return LEAD_SECONDS + BURST_SECONDS + GAP_SECONDS + seconds + TAIL_SECONDS;
}

export async function encodeOggOpusRealtime(channels: Float32Array[], sampleRate: number, options: RealtimeOpusOptions): Promise<Uint8Array> {
  const mime = mediaRecorderOpusMime();
  if (!mime) throw new Error('This browser cannot encode Opus (no WebCodecs and no MediaRecorder Opus support); export WAV instead');
  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new ExportAbortedError();
  };

  const contentFrames = channels[0].length;
  const programme = buildProgramme(channels, sampleRate);
  const ctx = new AudioContext();
  try {
    await ctx.resume();
    const buffer = ctx.createBuffer(2, programme[0].length, sampleRate);
    buffer.copyToChannel(programme[0] as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(programme[1] as Float32Array<ArrayBuffer>, 1);
    const dest = ctx.createMediaStreamDestination();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(dest);

    const recorder = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: options.bitrateKbps * 1000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = (e) => reject((e as ErrorEvent).error ?? new Error('MediaRecorder failed'));
    });

    const totalSeconds = programme[0].length / sampleRate;
    const started = performance.now();
    let timer = 0;
    const abort = () => {
      window.clearInterval(timer);
      try {
        src.stop();
      } catch {
        /* not started */
      }
      if (recorder.state !== 'inactive') recorder.stop();
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    src.onended = () => {
      if (recorder.state !== 'inactive') recorder.stop();
    };
    recorder.start();
    src.start();
    timer = window.setInterval(() => {
      options.onProgress?.(Math.min(0.95, (performance.now() - started) / 1000 / totalSeconds));
    }, 100);
    try {
      await stopped;
    } finally {
      window.clearInterval(timer);
      options.signal?.removeEventListener('abort', abort);
    }
    throwIfAborted();

    const recorded = new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer());
    const { packets, preSkipApplied } = unwrap(recorded, mime);
    if (packets.length === 0) throw new Error('MediaRecorder produced no audio');

    // Locate the sync burst in the decoded recording (48 kHz so positions are in Opus samples).
    const decodeCtx = new OfflineAudioContext(2, 1, OPUS_SAMPLE_RATE);
    const decoded = await decodeCtx.decodeAudioData(recorded.slice().buffer);
    const burstStart = findBurst(decoded.getChannelData(0));
    if (burstStart < 0) throw new Error('Could not locate the sync marker in the recording');
    throwIfAborted();

    // Samples of raw decoder output to skip before the slice begins.
    let preSkip = burstStart + Math.round((BURST_SECONDS + GAP_SECONDS) * OPUS_SAMPLE_RATE) + preSkipApplied;
    const kept = packets.slice();
    while (preSkip > MAX_PRE_SKIP && kept.length > 1) {
      preSkip -= opusPacketSamples(kept.shift()!);
    }
    const totalSamples = kept.reduce((n, p) => n + opusPacketSamples(p), 0);
    let lengthSamples48k = Math.round((contentFrames * OPUS_SAMPLE_RATE) / sampleRate);
    if (preSkip + lengthSamples48k > totalSamples) {
      console.warn('[MediaRecorderOpus] recording ended early; trimming', preSkip + lengthSamples48k - totalSamples, 'samples');
      lengthSamples48k = Math.max(0, totalSamples - preSkip);
    }

    options.onProgress?.(1);
    return muxOggOpus({
      packets: kept,
      channels: 2,
      preSkip,
      inputSampleRate: sampleRate,
      lengthSamples48k,
      vendor: 'tropicflow (MediaRecorder opus)',
      comments: ['ENCODER=tropicflow', `ENCODER_OPTIONS=--bitrate ${options.bitrateKbps}`],
    });
  } finally {
    void ctx.close();
  }
}

function buildProgramme(channels: Float32Array[], sampleRate: number): Float32Array[] {
  const lead = Math.round(LEAD_SECONDS * sampleRate);
  const burst = Math.round(BURST_SECONDS * sampleRate);
  const gap = Math.round(GAP_SECONDS * sampleRate);
  const tail = Math.round(TAIL_SECONDS * sampleRate);
  const content = channels[0].length;
  const total = lead + burst + gap + content + tail;
  const left = channels[0];
  const right = channels[1] ?? channels[0];
  const out = [new Float32Array(total), new Float32Array(total)];
  const ramp = Math.round(0.001 * sampleRate);
  // Abrupt start (the threshold crossing marks the sample exactly), short ramp-out.
  for (let i = 0; i < burst; i++) {
    const env = Math.min(1, (burst - i) / ramp);
    const v = BURST_AMPLITUDE * env * Math.sin((2 * Math.PI * BURST_HZ * i) / sampleRate);
    out[0][lead + i] = v;
    out[1][lead + i] = v;
  }
  out[0].set(left, lead + burst + gap);
  out[1].set(right, lead + burst + gap);
  return out;
}

function findBurst(x: Float32Array): number {
  const limit = Math.min(x.length, OPUS_SAMPLE_RATE * 3);
  for (let i = 0; i < limit; i++) if (Math.abs(x[i]) > BURST_THRESHOLD) return i;
  return -1;
}

/** Opus packets + the pre-skip a decoder applies to this container. */
function unwrap(bytes: Uint8Array, mime: string): { packets: Uint8Array[]; preSkipApplied: number } {
  if (mime.startsWith('audio/webm')) {
    const webm = extractOpusFromWebm(bytes);
    const headSkip = webm.codecPrivate ? safePreSkip(webm.codecPrivate) : 0;
    // Matroska decoders use CodecDelay; without it the OpusHead pre-skip applies.
    return { packets: webm.packets, preSkipApplied: webm.codecDelaySamples || headSkip };
  }
  const pages: OggPage[] = parseOggPages(bytes);
  const head = parseOpusHead(pages[0].packets[0]);
  return { packets: pages.slice(2).flatMap((p) => p.packets), preSkipApplied: head.preSkip };
}

function safePreSkip(opusHead: Uint8Array): number {
  try {
    return parseOpusHead(opusHead).preSkip;
  } catch {
    return 0;
  }
}

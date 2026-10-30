/**
 * Export parameters and the pure (Node-testable) half of exporting audio:
 * range selection, edge fades, file naming and size estimates.
 */
import type { WavBitDepth } from '../render/WavCodec.ts';

export type ExportFormat = 'wav' | 'ogg';

export class ExportAbortedError extends Error {
  constructor() {
    super('export aborted');
    this.name = 'ExportAbortedError';
  }
}

export const OGG_BITRATES_KBPS = [64, 96, 128, 160, 192, 256] as const;
export type OggBitrateKbps = (typeof OGG_BITRATES_KBPS)[number];
export const DEFAULT_OGG_BITRATE_KBPS: OggBitrateKbps = 128;

export const WAV_BIT_DEPTHS: WavBitDepth[] = [16, 24, 32];

/** Fade applied at both cut points so a slice never starts/ends with a click. */
export const EDGE_FADE_SECONDS = 0.005;

export interface ExportOptions {
  format: ExportFormat;
  /** Offset into the source, seconds. */
  startSeconds: number;
  /** Length of the exported range, seconds. */
  durationSeconds: number;
  /** WAV only. */
  bitDepth: WavBitDepth;
  /** OGG only, kb/s. */
  bitrateKbps: number;
}

/** Audio handed to the exporter: a live take or an offline bounce. */
export interface ExportSource {
  /** Short description shown in the dialog (e.g. "LIVE TAKE", "BOUNCE 2 BARS"). */
  label: string;
  channels: Float32Array[];
  sampleRate: number;
  bpm: number;
  /** File name stem without range/extension, e.g. "tropicflow-take-120bpm". */
  stem: string;
}

export interface ResolvedRange {
  startFrame: number;
  frames: number;
  startSeconds: number;
  durationSeconds: number;
}

/** Requested ends this close to the real end (seconds) snap to it: the UI shows lengths rounded to 0.1 s. */
export const END_SNAP_SECONDS = 0.05;

/**
 * Clamp a requested start/duration to what the source actually contains.
 * Frame-accurate; durations below one frame resolve to 0 frames. An end
 * within `snapSeconds` of the source end is taken as "to the end".
 */
export function resolveRange(
  totalFrames: number,
  sampleRate: number,
  startSeconds: number,
  durationSeconds: number,
  snapSeconds = END_SNAP_SECONDS
): ResolvedRange {
  const totalSeconds = totalFrames / sampleRate;
  const start = clamp(Number.isFinite(startSeconds) ? startSeconds : 0, 0, totalSeconds);
  let duration = clamp(Number.isFinite(durationSeconds) ? durationSeconds : totalSeconds - start, 0, totalSeconds - start);
  if (start + duration > totalSeconds - snapSeconds) duration = totalSeconds - start;
  const startFrame = Math.min(totalFrames, Math.round(start * sampleRate));
  const frames = Math.min(totalFrames - startFrame, Math.round(duration * sampleRate));
  return { startFrame, frames, startSeconds: startFrame / sampleRate, durationSeconds: frames / sampleRate };
}

/** True when the range covers the whole source (file name then omits the range). */
export function isFullRange(range: ResolvedRange, totalFrames: number): boolean {
  return range.startFrame === 0 && range.frames === totalFrames;
}

/**
 * Copy the selected range out of the source, applying a short linear fade-in
 * and fade-out (EDGE_FADE_SECONDS, shortened for very short slices).
 */
export function sliceChannels(channels: Float32Array[], sampleRate: number, range: ResolvedRange, fadeSeconds = EDGE_FADE_SECONDS): Float32Array[] {
  const fade = Math.min(Math.round(fadeSeconds * sampleRate), Math.floor(range.frames / 2));
  return channels.map((ch) => {
    const out = ch.slice(range.startFrame, range.startFrame + range.frames);
    for (let i = 0; i < fade; i++) {
      const g = (i + 1) / (fade + 1);
      out[i] *= g;
      out[out.length - 1 - i] *= g;
    }
    return out;
  });
}

/** Approximate size of the file that would be produced, in bytes. */
export function estimateExportBytes(options: ExportOptions, frames: number, sampleRate: number, channels: number): number {
  const seconds = frames / sampleRate;
  if (options.format === 'wav') return 44 + frames * channels * (options.bitDepth / 8);
  // Ogg overhead: ~1 % for page headers plus the two header pages.
  return Math.round((options.bitrateKbps * 1000 * seconds) / 8 * 1.01) + 200;
}

export function buildExportFilename(stem: string, options: ExportOptions, range: ResolvedRange, fullRange: boolean): string {
  const rangePart = fullRange ? '' : `-${formatSecondsForName(range.startSeconds)}s-${formatSecondsForName(range.durationSeconds)}s`;
  const qualityPart = options.format === 'wav' ? (options.bitDepth === 32 ? '' : `-${options.bitDepth}bit`) : `-${options.bitrateKbps}k`;
  return `${stem}${rangePart}${qualityPart}.${options.format}`;
}

export function formatSecondsForName(s: number): string {
  return Number.isInteger(s) ? String(s) : s.toFixed(1).replace(/\.0$/, '');
}

/** mm:ss(.d) for UI labels. */
export function formatClock(seconds: number, decimals = 0): string {
  const whole = Math.floor(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  const frac = decimals > 0 ? (seconds - whole).toFixed(decimals).slice(1) : '';
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${frac}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

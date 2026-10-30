/**
 * Turn an ExportSource (live take or offline bounce) into a downloadable file.
 */
import { encodeWav } from '../render/WavCodec.ts';
import {
  type ExportOptions,
  type ExportSource,
  buildExportFilename,
  isFullRange,
  resolveRange,
  sliceChannels,
} from './ExportOptions.ts';
import { encodeOggOpus } from './OpusEncoder.ts';

export interface ExportResult {
  blob: Blob;
  filename: string;
  frames: number;
}

export interface ExportProgress {
  /** 0..1 */
  fraction: number;
}

export async function exportAudio(
  source: ExportSource,
  options: ExportOptions,
  onProgress?: (p: ExportProgress) => void,
  signal?: AbortSignal
): Promise<ExportResult> {
  const totalFrames = source.channels[0].length;
  const range = resolveRange(totalFrames, source.sampleRate, options.startSeconds, options.durationSeconds);
  if (range.frames === 0) throw new Error('The selected range is empty');
  const slice = sliceChannels(source.channels, source.sampleRate, range);
  const filename = buildExportFilename(source.stem, options, range, isFullRange(range, totalFrames));

  if (options.format === 'wav') {
    onProgress?.({ fraction: 0 });
    const wav = encodeWav(slice, source.sampleRate, options.bitDepth);
    onProgress?.({ fraction: 1 });
    return { blob: new Blob([wav], { type: 'audio/wav' }), filename, frames: range.frames };
  }

  const ogg = await encodeOggOpus(slice, source.sampleRate, {
    bitrateKbps: options.bitrateKbps,
    signal,
    onProgress: (fraction) => onProgress?.({ fraction }),
  });
  return { blob: new Blob([ogg as BlobPart], { type: 'audio/ogg' }), filename, frames: range.frames };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

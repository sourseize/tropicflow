import React, { useEffect, useRef, useState } from 'react';
import { Download, FileAudio, Loader2, Scissors, Timer } from 'lucide-react';
import { Modal } from '../ui/Modal.tsx';
import {
  DEFAULT_OGG_BITRATE_KBPS,
  ExportAbortedError,
  type ExportFormat,
  type ExportOptions,
  type ExportSource,
  OGG_BITRATES_KBPS,
  WAV_BIT_DEPTHS,
  estimateExportBytes,
  formatBytes,
  formatClock,
  isFullRange,
  resolveRange,
} from '../../core/export/ExportOptions.ts';
import { detectOpusEngine, type OpusEngine } from '../../core/export/OpusEncoder.ts';
import { realtimeEncodeSeconds } from '../../core/export/MediaRecorderOpus.ts';
import { downloadBlob, exportAudio } from '../../core/export/exportAudio.ts';
import type { WavBitDepth } from '../../core/render/WavCodec.ts';

interface ExportModalProps {
  source: ExportSource | null;
  onClose: () => void;
  /** Called after a file has been handed to the browser for download. */
  onExported?: (filename: string) => void;
}

type Phase = 'idle' | 'encoding' | 'done';

/** Slider resolution in seconds. */
const STEP = 0.1;
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Collects start / duration / format parameters and runs the export with a progress bar. */
export const ExportModal: React.FC<ExportModalProps> = ({ source, onClose, onExported }) => {
  const open = source !== null;
  const totalFrames = source ? source.channels[0].length : 0;
  const totalSeconds = source ? totalFrames / source.sampleRate : 0;
  const totalRounded = round1(totalSeconds);

  const [format, setFormat] = useState<ExportFormat>('wav');
  const [bitDepth, setBitDepth] = useState<WavBitDepth>(32);
  const [bitrateKbps, setBitrateKbps] = useState<number>(DEFAULT_OGG_BITRATE_KBPS);
  const [start, setStart] = useState(0);
  const [duration, setDuration] = useState(0);
  const [opusEngine, setOpusEngine] = useState<OpusEngine | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset the range and re-detect the Opus engine whenever a new source arrives.
  useEffect(() => {
    if (!source) return;
    setStart(0);
    setDuration(round1(source.channels[0].length / source.sampleRate));
    setOpusEngine(detectOpusEngine());
    setPhase('idle');
    setProgress(0);
    setError(null);
  }, [source]);

  const oggAvailable = opusEngine !== null;
  useEffect(() => {
    if (format === 'ogg' && !oggAvailable) setFormat('wav');
  }, [format, oggAvailable]);

  const options: ExportOptions = { format, startSeconds: start, durationSeconds: duration, bitDepth, bitrateKbps };
  const range = source ? resolveRange(totalFrames, source.sampleRate, start, duration) : null;
  const rangeEmpty = !range || range.frames === 0;
  const sizeEstimate = range && source ? formatBytes(estimateExportBytes(options, range.frames, source.sampleRate, source.channels.length)) : '';
  const busy = phase === 'encoding';
  const realtime = format === 'ogg' && opusEngine === 'mediarecorder';

  const changeStart = (v: number) => {
    const s = Math.min(v, totalRounded);
    setStart(s);
    // Keep the end where it was when possible, otherwise shrink the duration.
    setDuration((d) => round1(Math.max(0, Math.min(d, totalRounded - s))));
  };
  const changeDuration = (v: number) => setDuration(round1(Math.max(0, Math.min(v, totalRounded - start))));
  const selectAll = () => {
    setStart(0);
    setDuration(totalRounded);
  };

  const runExport = async () => {
    if (!source || !range || rangeEmpty || busy) return;
    setError(null);
    setPhase('encoding');
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await exportAudio(source, options, (p) => setProgress(p.fraction), controller.signal);
      downloadBlob(result.blob, result.filename);
      setPhase('done');
      onExported?.(result.filename);
      setTimeout(onClose, 400);
    } catch (err) {
      setPhase('idle');
      if (!(err instanceof ExportAbortedError)) {
        console.error('[ExportModal] export failed', err);
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abortRef.current = null;
    }
  };

  const cancel = () => {
    if (busy) abortRef.current?.abort();
    else onClose();
  };

  const field = 'bg-jungle-950 border border-jungle-700 rounded-lg text-[11px] font-mono text-cream-100 px-2 py-1.5 w-full focus:outline-none focus:border-mango-500 disabled:opacity-50';
  const labelCls = 'text-[9px] font-mono tracking-wider uppercase text-cream-200/60';

  return (
    <Modal
      open={open}
      onClose={cancel}
      busy={busy}
      icon={<FileAudio size={16} />}
      title={
        <span>
          EXPORT{' '}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-mango-400 via-papaya-400 to-tomato-400">AUDIO</span>
        </span>
      }
      subtitle={source ? `${source.label} · ${formatClock(totalSeconds, 1)} · ${source.sampleRate / 1000} kHz · ${source.channels.length === 2 ? 'stereo' : 'mono'} · ${source.bpm} BPM` : ''}
      testId="export-modal"
      footer={
        <>
          <button
            onClick={cancel}
            data-testid="export-cancel"
            className="px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold tracking-wider text-cream-200/80 hover:text-cream-100 bg-jungle-850 hover:bg-jungle-800 border border-jungle-700"
          >
            {busy ? 'ABORT' : 'CANCEL'}
          </button>
          <button
            onClick={runExport}
            disabled={busy || rangeEmpty || (format === 'ogg' && !oggAvailable)}
            data-testid="export-run"
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[10px] font-mono font-bold tracking-wider text-jungle-950 bg-gradient-to-r from-mango-500 to-papaya-500 hover:from-mango-400 hover:to-papaya-400 shadow-glow-mango disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {busy ? 'ENCODING…' : phase === 'done' ? 'SAVED' : `EXPORT ${format.toUpperCase()}`}
          </button>
        </>
      }
    >
      {source && range && (
        <div className="flex flex-col gap-4">
          {/* Format */}
          <div className="flex flex-col gap-1.5">
            <span className={labelCls}>Format</span>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Export format">
              <FormatButton
                active={format === 'wav'}
                onClick={() => setFormat('wav')}
                disabled={busy}
                title="WAV"
                detail="lossless · PCM / float"
                accent="lime"
                testId="format-wav"
              />
              <FormatButton
                active={format === 'ogg'}
                onClick={() => setFormat('ogg')}
                disabled={busy || !oggAvailable}
                title="OGG"
                detail={
                  opusEngine === 'webcodecs'
                    ? 'Opus · compressed'
                    : opusEngine === 'mediarecorder'
                      ? 'Opus · compressed (realtime encode)'
                      : 'Opus · not available in this browser'
                }
                accent="mango"
                testId="format-ogg"
              />
            </div>
          </div>

          {/* Range sliders */}
          <div className="flex flex-col gap-3 bg-jungle-950 border border-jungle-800 rounded-xl px-3.5 py-3">
            <RangeSlider
              icon={<Scissors size={12} className="text-mango-400" />}
              label="START"
              value={start}
              max={totalRounded}
              display={`${formatClock(start, 1)}`}
              accent="mango"
              disabled={busy}
              onChange={changeStart}
              testId="export-start"
            />
            <RangeSlider
              icon={<Timer size={12} className="text-lime-400" />}
              label="DURATION"
              value={duration}
              max={round1(Math.max(0, totalRounded - start))}
              display={`${duration.toFixed(1)} s`}
              accent="lime"
              disabled={busy}
              onChange={changeDuration}
              testId="export-duration"
            />

            {/* Mini timeline of the selected region */}
            <div className="flex flex-col gap-1">
              <div className="relative h-2.5 rounded-full bg-jungle-900 border border-jungle-800 overflow-hidden tropical-grid">
                <div
                  className={`absolute inset-y-0 rounded-full ${rangeEmpty ? 'bg-tomato-500/60' : 'bg-gradient-to-r from-mango-500/80 to-lime-400'}`}
                  style={{
                    left: `${totalSeconds > 0 ? (range.startSeconds / totalSeconds) * 100 : 0}%`,
                    width: `${totalSeconds > 0 ? Math.max(0.5, (range.durationSeconds / totalSeconds) * 100) : 0}%`,
                  }}
                />
              </div>
              <div className="flex justify-between items-center text-[9px] font-mono text-cream-200/50">
                <span>
                  {formatClock(range.startSeconds, 1)} → {formatClock(range.startSeconds + range.durationSeconds, 1)}
                  {isFullRange(range, totalFrames) ? (
                    ' · whole take'
                  ) : (
                    <button onClick={selectAll} disabled={busy} className="ml-2 text-mango-400/80 hover:text-mango-400 underline-offset-2 hover:underline" data-testid="export-all">
                      select all
                    </button>
                  )}
                </span>
                <span>
                  ≈ <span className="text-cream-100" data-testid="export-size">{sizeEstimate}</span>
                </span>
              </div>
              {rangeEmpty && <p className="text-[9px] font-mono text-tomato-400">Nothing to export: the range is empty.</p>}
            </div>
          </div>

          {/* Quality */}
          <div className="grid grid-cols-2 gap-3 items-end">
            {format === 'wav' ? (
              <label className="flex flex-col gap-1">
                <span className={labelCls}>Bit depth</span>
                <select value={bitDepth} disabled={busy} onChange={(e) => setBitDepth(Number(e.target.value) as WavBitDepth)} className={field} data-testid="export-bitdepth">
                  {WAV_BIT_DEPTHS.map((d) => (
                    <option key={d} value={d}>
                      {d === 32 ? '32-bit float' : `${d}-bit PCM`}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="flex flex-col gap-1">
                <span className={labelCls}>Bitrate</span>
                <select value={bitrateKbps} disabled={busy} onChange={(e) => setBitrateKbps(Number(e.target.value))} className={field} data-testid="export-bitrate">
                  {OGG_BITRATES_KBPS.map((b) => (
                    <option key={b} value={b}>
                      {b} kb/s
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="text-[9px] font-mono text-cream-200/50 leading-snug pb-1">
              {format === 'wav'
                ? 'Lossless. 32-bit float keeps the mix exactly as rendered.'
                : realtime
                  ? `No WebCodecs here (open via localhost/https or use Chrome/Edge/Firefox 130+ for a fast encode): encoding plays the slice through MediaRecorder, ≈ ${Math.ceil(realtimeEncodeSeconds(range.durationSeconds))} s.`
                  : 'Opus VBR via WebCodecs, faster than realtime. 128 kb/s is transparent for most material.'}
            </p>
          </div>

          {/* Progress */}
          {(busy || phase === 'done') && (
            <div className="flex flex-col gap-1" data-testid="export-progress">
              <div className="flex justify-between text-[9px] font-mono text-cream-200/60">
                <span>{format === 'ogg' ? `ENCODING OPUS @ ${bitrateKbps} kb/s${realtime ? ' · REALTIME' : ''}` : 'WRITING WAV'}</span>
                <span className="text-mango-400 font-bold">{Math.round(progress * 100)}%</span>
              </div>
              <div className="h-2 rounded-full bg-jungle-950 border border-jungle-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-mango-500 via-papaya-500 to-lime-400 transition-[width] duration-100"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
            </div>
          )}

          {error && <p className="text-[10px] font-mono text-tomato-400 border border-tomato-500/40 bg-tomato-500/10 rounded-lg px-2 py-1.5">{error}</p>}
        </div>
      )}
    </Modal>
  );
};

interface RangeSliderProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  max: number;
  display: string;
  accent: 'mango' | 'lime';
  disabled: boolean;
  onChange: (v: number) => void;
  testId: string;
}

/** Same look as the TEMPO / MASTER sliders in the header. */
const RangeSlider: React.FC<RangeSliderProps> = ({ icon, label, value, max, display, accent, disabled, onChange, testId }) => (
  <div className="flex items-center gap-2.5">
    {icon}
    <div className="flex flex-col flex-1">
      <div className="flex justify-between items-center text-[10px] font-mono text-cream-200/60">
        <span>{label}</span>
        <span className={`font-bold ${accent === 'mango' ? 'text-mango-400' : 'text-lime-400'}`}>{display}</span>
      </div>
      <input
        type="range"
        min={0}
        max={max}
        step={STEP}
        value={Math.min(value, max)}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={`${label} in seconds`}
        data-testid={testId}
        className={`w-full h-1.5 bg-jungle-800 rounded-lg appearance-none cursor-pointer disabled:cursor-not-allowed ${accent === 'mango' ? 'accent-mango-500' : 'accent-lime-500'}`}
      />
    </div>
  </div>
);

interface FormatButtonProps {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  title: string;
  detail: string;
  accent: 'lime' | 'mango';
  testId: string;
}

const FormatButton: React.FC<FormatButtonProps> = ({ active, disabled, onClick, title, detail, accent, testId }) => {
  const activeCls = accent === 'lime' ? 'border-lime-500 bg-lime-500/10 shadow-glow-lime' : 'border-mango-500 bg-mango-500/10 shadow-glow-mango';
  const titleCls = active ? (accent === 'lime' ? 'text-lime-400' : 'text-mango-400') : 'text-cream-100';
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`flex flex-col items-start px-3 py-2 rounded-xl border text-left transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
        active ? activeCls : 'border-jungle-700 bg-jungle-950 hover:border-jungle-600'
      }`}
    >
      <span className={`font-mono font-bold text-xs tracking-wider ${titleCls}`}>{title}</span>
      <span className="text-[9px] font-mono text-cream-200/50">{detail}</span>
    </button>
  );
};

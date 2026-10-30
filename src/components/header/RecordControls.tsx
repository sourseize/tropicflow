import React, { useEffect, useState } from 'react';
import { Disc3, Download, Hourglass } from 'lucide-react';
import { AudioEngine } from '../../core/audio/AudioEngine.ts';
import { EventBus } from '../../core/events/EventBus.ts';
import type { TakeEvent } from '../../core/events/DomainEvents.ts';
import { TAKE_MAX_SECONDS_CEILING, TakeRecorder } from '../../core/record/TakeRecorder.ts';
import { formatClock } from '../../core/export/ExportOptions.ts';

interface RecordControlsProps {
  /** Opens the export dialog for the last take. */
  onExport: () => void;
}

const TOMATO = '#ff382e';

/**
 * REC checkbox + MAX length slider + take status, next to START GROOVE.
 * Recording runs while the transport plays and the box is ticked.
 */
export const RecordControls: React.FC<RecordControlsProps> = ({ onExport }) => {
  const engine = AudioEngine.getInstance();
  const [armed, setArmed] = useState<boolean>(engine.isRecordArmed());
  const [maxMinutes, setMaxMinutes] = useState<number>(Math.round(engine.recorder.getMaxSeconds() / 60));
  const [recording, setRecording] = useState<boolean>(engine.recorder.isRecording());
  const [elapsed, setElapsed] = useState<number>(0);
  const [takeSeconds, setTakeSeconds] = useState<number | null>(engine.getLastTake()?.durationSeconds ?? null);
  const [hint, setHint] = useState<string | null>(null);
  const unsupported = TakeRecorder.unsupportedReason(engine.ctx);

  useEffect(() => {
    const bus = EventBus.getInstance();
    const offStart = bus.subscribe<TakeEvent>('TAKE_STARTED', () => {
      setRecording(true);
      setElapsed(0);
      setHint(null);
    });
    const offStop = bus.subscribe<TakeEvent>('TAKE_STOPPED', (e) => {
      setRecording(false);
      setElapsed(0);
      if (e.reason === 'empty') {
        setHint('nothing captured');
      } else {
        setTakeSeconds(e.durationSeconds);
        if (e.reason === 'max-length') setHint('max length reached');
      }
    });
    return () => {
      offStart();
      offStop();
    };
  }, []);

  // Elapsed counter while recording.
  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => setElapsed(engine.recorder.getElapsedSeconds()), 200);
    return () => window.clearInterval(id);
  }, [recording, engine]);

  const toggleArmed = (next: boolean) => {
    setArmed(next);
    void engine.setRecordArmed(next);
  };

  const changeMax = (minutes: number) => {
    const m = Math.max(1, Math.min(TAKE_MAX_SECONDS_CEILING / 60, Math.round(minutes)));
    setMaxMinutes(m);
    engine.recorder.setMaxSeconds(m * 60);
  };

  return (
    <div
      className={`flex items-center gap-3 bg-jungle-950 px-3 py-1.5 rounded-xl border transition-colors ${
        recording ? 'border-tomato-500/70 shadow-glow-tomato' : 'border-jungle-800'
      }`}
      data-testid="record-controls"
    >
      <label
        className={`flex items-center gap-2 ${unsupported ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
        title={unsupported ?? 'Record what you hear while the groove plays'}
      >
        <span className="relative w-4 h-4 flex items-center justify-center">
          <input
            type="checkbox"
            checked={armed}
            disabled={unsupported !== null}
            onChange={(e) => toggleArmed(e.target.checked)}
            data-testid="rec-arm"
            aria-label="Record while playing"
            className={`appearance-none w-4 h-4 m-0 rounded-md border cursor-pointer transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tomato-400 disabled:cursor-not-allowed ${
              armed ? 'border-tomato-500 bg-tomato-500/20' : 'border-jungle-600 bg-jungle-900 hover:border-jungle-500'
            }`}
          />
          <span
            className={`pointer-events-none absolute w-2 h-2 rounded-full bg-tomato-500 transition-opacity ${armed ? 'opacity-100' : 'opacity-0'} ${
              recording ? 'animate-pulse' : ''
            }`}
            style={{ boxShadow: armed ? `0 0 8px ${TOMATO}` : undefined }}
          />
        </span>
        <span className={`text-[10px] font-mono font-bold tracking-wider ${armed ? 'text-tomato-400' : 'text-cream-200/70'}`}>REC</span>
      </label>

      <div className="flex items-center gap-2" title="Longest take in minutes (the recording stops by itself when reached)">
        <Hourglass size={13} className="text-tomato-400" />
        <div className="flex flex-col">
          <div className="flex justify-between items-center text-[10px] font-mono text-cream-200/60">
            <span>MAX</span>
            <span className="text-tomato-400 font-bold">{maxMinutes} MIN</span>
          </div>
          <input
            type="range"
            min={1}
            max={TAKE_MAX_SECONDS_CEILING / 60}
            step={1}
            value={maxMinutes}
            onChange={(e) => changeMax(Number(e.target.value))}
            aria-label="Longest take in minutes"
            data-testid="rec-max"
            className="w-20 h-1.5 bg-jungle-800 rounded-lg appearance-none cursor-pointer accent-tomato-500"
          />
        </div>
      </div>

      <div className="w-px h-6 bg-jungle-800" />

      {recording ? (
        <div className="flex items-center gap-1.5 font-mono text-[10px] whitespace-nowrap" data-testid="rec-status">
          <Disc3 size={13} className="text-tomato-400 animate-spin [animation-duration:3s]" />
          <span className="text-tomato-400 font-bold tabular-nums">{formatClock(elapsed)}</span>
          <span className="text-cream-200/40">/ {formatClock(maxMinutes * 60)}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 font-mono text-[10px] whitespace-nowrap" data-testid="rec-status">
          {takeSeconds !== null ? (
            <>
              <span className="text-cream-200/60">
                TAKE <span className="text-cream-100 font-bold tabular-nums">{formatClock(takeSeconds)}</span>
              </span>
              <button
                onClick={onExport}
                data-testid="export-open"
                title="Export the last take as WAV or OGG"
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-gradient-to-r from-mango-500 to-papaya-500 hover:from-mango-400 hover:to-papaya-400 text-jungle-950 font-bold tracking-wider shadow-glow-mango"
              >
                <Download size={11} />
                EXPORT
              </button>
            </>
          ) : unsupported ? (
            <span className="text-papaya-400/80" title={unsupported}>
              {window.isSecureContext ? 'NO AUDIOWORKLET' : 'NEEDS LOCALHOST / HTTPS'}
            </span>
          ) : (
            <span className="text-cream-200/40">{armed ? 'ARMED' : 'NO TAKE'}</span>
          )}
          {hint && <span className="text-papaya-400/80">{hint}</span>}
        </div>
      )}
    </div>
  );
};

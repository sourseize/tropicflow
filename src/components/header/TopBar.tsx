import React, { useCallback, useState } from 'react';
import { AudioEngine } from '../../core/audio/AudioEngine.ts';
import { EventBus } from '../../core/events/EventBus.ts';
import { renderOffline } from '../../core/render/OfflineRenderer.ts';
import { captureRenderConfig } from '../../core/render/captureConfig.ts';
import type { ExportSource } from '../../core/export/ExportOptions.ts';
import { downloadBlob } from '../../core/export/exportAudio.ts';
import { Play, Square, Sliders, Volume2, Cpu, Download, BookOpen } from 'lucide-react';
import { RecordControls } from './RecordControls.tsx';
import { ExportModal } from '../export/ExportModal.tsx';

/** yyyymmdd-hhmm for take file names. */
function timeStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export const TopBar: React.FC = () => {
  const engine = AudioEngine.getInstance();
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [bpm, setBpm] = useState<number>(engine.clock.getBpm());
  const [volume, setVolume] = useState<number>(85);
  const [bounceBars, setBounceBars] = useState<number>(2);
  const [isBouncing, setIsBouncing] = useState<boolean>(false);
  const [lastScore, setLastScore] = useState<{ filename: string; json: string } | null>(null);
  const [exportSource, setExportSource] = useState<ExportSource | null>(null);
  const closeExport = useCallback(() => setExportSource(null), []);

  /** Open the export dialog for the last recorded take. */
  const exportTake = () => {
    const take = engine.getLastTake();
    if (!take) return;
    setExportSource({
      label: 'LIVE TAKE',
      channels: take.channels,
      sampleRate: take.sampleRate,
      bpm: take.bpm,
      stem: `tropicflow-take-${take.bpm}bpm-${timeStamp(take.recordedAt)}`,
    });
  };

  /**
   * Render the current patch offline (faster than realtime, deterministic),
   * then open the export dialog (WAV or OGG). The note score is kept for the
   * SCORE button.
   */
  const bounce = async () => {
    if (isBouncing) return;
    setIsBouncing(true);
    const eventBus = EventBus.getInstance();
    const config = captureRenderConfig(engine, bounceBars);
    eventBus.publish({ type: 'RECORDING_STARTED', timestamp: performance.now(), bars: config.bars, sampleRate: config.sampleRate });
    try {
      const result = await renderOffline(config);
      const stem = `tropicflow-${config.bpm}bpm-${config.bars}bars`;
      // Browsers block multiple automatic downloads; the score is offered via its own button.
      setLastScore({
        filename: `${stem}.score.json`,
        json: JSON.stringify(
          { config, busLatency: result.busLatency, patternEnd: result.patternEnd, score: result.score },
          null,
          2
        ),
      });
      setExportSource({
        label: `BOUNCE ${config.bars} BAR${config.bars > 1 ? 'S' : ''}`,
        channels: result.channels,
        sampleRate: result.sampleRate,
        bpm: config.bpm,
        stem,
      });
    } catch (err) {
      console.error('[TopBar] bounce failed', err);
    } finally {
      eventBus.publish({ type: 'RECORDING_STOPPED', timestamp: performance.now(), bars: config.bars, sampleRate: config.sampleRate });
      setIsBouncing(false);
    }
  };

  const togglePlayback = async () => {
    if (isPlaying) {
      engine.stopAudio();
      setIsPlaying(false);
    } else {
      await engine.startAudio();
      setIsPlaying(true);
    }
  };

  const handleBpmChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    setBpm(val);
    engine.clock.setBpm(val);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    setVolume(val);
    engine.masterBus.setVolume(val / 100);
  };

  return (
    <header className="h-16 px-5 bg-jungle-900 border-b border-jungle-750 flex items-center justify-between select-none shadow-xl z-40 relative">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-mango-400 via-papaya-500 to-tomato-500 p-0.5 shadow-glow-mango flex items-center justify-center">
          <div className="w-full h-full bg-jungle-950 rounded-[10px] flex items-center justify-center font-black text-lg text-mango-400">
            🥭
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-extrabold tracking-tight text-base text-cream-100 flex items-center gap-1.5 whitespace-nowrap">
              <span>TROPIC</span>
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-mango-400 via-papaya-400 to-tomato-400">
                FLOW
              </span>
            </h1>
            <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-lime-500/20 text-lime-400 border border-lime-500/40">
              OFFLINE LOCAL
            </span>
          </div>
          <p className="hidden xl:block whitespace-nowrap text-[11px] font-mono text-cream-200/50">
            Modular Audio-Visual Synthesis & Physics Computing
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={togglePlayback}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold font-mono text-xs tracking-wider whitespace-nowrap transition-all duration-200 shadow-lg ${
            isPlaying
              ? 'bg-tomato-500 hover:bg-tomato-600 text-white shadow-glow-tomato'
              : 'bg-gradient-to-r from-mango-500 to-papaya-500 hover:from-mango-400 hover:to-papaya-400 text-jungle-950 shadow-glow-mango'
          }`}
        >
          {isPlaying ? (
            <>
              <Square size={14} fill="currentColor" />
              <span>STOP ENGINE</span>
            </>
          ) : (
            <>
              <Play size={14} fill="currentColor" />
              <span>START GROOVE</span>
            </>
          )}
        </button>

        <RecordControls onExport={exportTake} />

        <div className="flex items-center gap-2.5 bg-jungle-950 px-3.5 py-1.5 rounded-xl border border-jungle-800">
          <Sliders size={13} className="text-mango-400" />
          <div className="flex flex-col">
            <div className="flex justify-between items-center text-[10px] font-mono text-cream-200/60">
              <span>TEMPO</span>
              <span className="text-mango-400 font-bold">{bpm} BPM</span>
            </div>
            <input
              type="range"
              min="60"
              max="180"
              value={bpm}
              onChange={handleBpmChange}
              className="w-24 h-1.5 bg-jungle-800 rounded-lg appearance-none cursor-pointer accent-mango-500"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 bg-jungle-950 px-3 py-1.5 rounded-xl border border-jungle-800">
          <button
            onClick={bounce}
            disabled={isBouncing}
            title="Render the current patch offline, then export it as WAV or OGG (+ score)"
            data-testid="bounce"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-jungle-850 hover:bg-jungle-800 border border-jungle-700 text-cream-200 text-[10px] font-mono font-bold tracking-wider disabled:opacity-50"
          >
            <Download size={12} className="text-mango-400" />
            {isBouncing ? 'RENDERING…' : 'BOUNCE'}
          </button>
          {lastScore && (
            <button
              onClick={() => downloadBlob(new Blob([lastScore.json], { type: 'application/json' }), lastScore.filename)}
              title="Download the note score (JSON) of the last bounce for automated verification"
              className="px-2 py-1 rounded-lg bg-jungle-850 hover:bg-jungle-800 border border-jungle-700 text-cream-200/80 text-[10px] font-mono"
            >
              SCORE
            </button>
          )}
          <select
            value={bounceBars}
            onChange={(e) => setBounceBars(Number(e.target.value))}
            className="bg-jungle-900 border border-jungle-800 rounded text-[10px] font-mono text-cream-200 px-1 py-1"
            aria-label="Bounce length in bars"
          >
            {[1, 2, 4, 8].map((b) => (
              <option key={b} value={b}>
                {b} BAR{b > 1 ? 'S' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2.5 bg-jungle-950 px-3.5 py-1.5 rounded-xl border border-jungle-800">
          <Volume2 size={13} className="text-lime-400" />
          <div className="flex flex-col">
            <div className="flex justify-between items-center text-[10px] font-mono text-cream-200/60">
              <span>MASTER</span>
              <span className="text-lime-400 font-bold">{volume}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={volume}
              onChange={handleVolumeChange}
              className="w-24 h-1.5 bg-jungle-800 rounded-lg appearance-none cursor-pointer accent-lime-500"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 font-mono text-[11px] whitespace-nowrap">
        <a
          href="/docs/USER_GUIDE.html"
          target="_blank"
          rel="noreferrer"
          title="Open the user guide (served by npm start / npm run dev)"
          data-testid="guide-link"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-jungle-950 border border-jungle-800 text-cream-200/70 hover:text-cream-100 hover:border-jungle-600"
        >
          <BookOpen size={12} className="text-lime-400" />
          <span className="hidden xl:inline">GUIDE</span>
        </a>
        <div className="hidden 2xl:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-jungle-950 border border-jungle-800 text-cream-200/70">
          <Cpu size={12} className="text-papaya-400" />
          <span>TARGET: NODE 22+</span>
        </div>
        <div className="hidden 2xl:flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${isPlaying ? 'bg-lime-400 shadow-glow-lime' : 'bg-cream-200/30'}`} />
          <span className="text-cream-200/60">{isPlaying ? 'DSP ACTIVE' : 'DSP IDLE'}</span>
        </div>
      </div>

      <ExportModal source={exportSource} onClose={closeExport} />
    </header>
  );
};

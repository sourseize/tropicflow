import React, { useState } from 'react';
import { AudioEngine } from '../../core/audio/AudioEngine';
import { Play, Square, Sliders, Volume2, Cpu } from 'lucide-react';

export const TopBar: React.FC = () => {
  const engine = AudioEngine.getInstance();
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [bpm, setBpm] = useState<number>(engine.clock.getBpm());
  const [volume, setVolume] = useState<number>(85);

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
            <h1 className="font-extrabold tracking-tight text-base text-cream-100 flex items-center gap-1.5">
              <span>TROPIC</span>
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-mango-400 via-papaya-400 to-tomato-400">
                FLOW
              </span>
            </h1>
            <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-lime-500/20 text-lime-400 border border-lime-500/40">
              OFFLINE LOCAL
            </span>
          </div>
          <p className="text-[11px] font-mono text-cream-200/50">
            Modular Audio-Visual Synthesis & Physics Computing
          </p>
        </div>
      </div>

      <div className="flex items-center gap-6">
        <button
          onClick={togglePlayback}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold font-mono text-xs tracking-wider transition-all duration-200 shadow-lg ${
            isPlaying
              ? 'bg-tomato-500 hover:bg-tomato-600 text-white shadow-glow-tomato animate-pulse'
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

      <div className="hidden lg:flex items-center gap-3 font-mono text-[11px]">
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-jungle-950 border border-jungle-800 text-cream-200/70">
          <Cpu size={12} className="text-papaya-400" />
          <span>TARGET: NODE 22+</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${isPlaying ? 'bg-lime-400 shadow-glow-lime' : 'bg-cream-200/30'}`} />
          <span className="text-cream-200/60">{isPlaying ? 'DSP ACTIVE' : 'DSP IDLE'}</span>
        </div>
      </div>
    </header>
  );
};

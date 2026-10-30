import React, { useEffect, useState } from 'react';
import { AudioEngine } from '../../core/audio/AudioEngine.ts';

interface KeyDef {
  note: string;
  keyLabel: string;
  freq: number;
  isBlack?: boolean;
}

const KEYS: KeyDef[] = [
  { note: 'C3', keyLabel: 'A', freq: 130.81 },
  { note: 'C#3', keyLabel: 'W', freq: 138.59, isBlack: true },
  { note: 'D3', keyLabel: 'S', freq: 146.83 },
  { note: 'D#3', keyLabel: 'E', freq: 155.56, isBlack: true },
  { note: 'E3', keyLabel: 'D', freq: 164.81 },
  { note: 'F3', keyLabel: 'F', freq: 174.61 },
  { note: 'F#3', keyLabel: 'T', freq: 185.00, isBlack: true },
  { note: 'G3', keyLabel: 'G', freq: 196.00 },
  { note: 'G#3', keyLabel: 'Y', freq: 207.65, isBlack: true },
  { note: 'A3', keyLabel: 'H', freq: 220.00 },
  { note: 'A#3', keyLabel: 'U', freq: 233.08, isBlack: true },
  { note: 'B3', keyLabel: 'J', freq: 246.94 },
  { note: 'C4', keyLabel: 'K', freq: 261.63 },
  { note: 'D4', keyLabel: 'O', freq: 293.66 },
  { note: 'E4', keyLabel: 'L', freq: 329.63 },
  { note: 'G4', keyLabel: ';', freq: 392.00 },
];

export const VirtualKeyboard: React.FC = () => {
  const engine = AudioEngine.getInstance();
  const [instrument, setInstrument] = useState<'marimba' | 'synth'>('marimba');
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const playNote = (keyDef: KeyDef) => {
    setActiveKey(keyDef.note);
    engine.playDirectNote(instrument, keyDef.freq);
    setTimeout(() => setActiveKey(null), 180);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const match = KEYS.find((k) => k.keyLabel.toLowerCase() === e.key.toLowerCase());
      if (match) {
        playNote(match);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [instrument]);

  return (
    <div className="bg-jungle-900 border border-jungle-700/80 rounded-xl p-3 shadow-xl flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-papaya-500" />
          <span className="text-xs font-mono font-bold tracking-wider text-cream-100">
            TROPICAL SOUNDBOARD / KEYS
          </span>
        </div>

        <div className="flex items-center bg-jungle-950 p-0.5 rounded-lg border border-jungle-800">
          <button
            onClick={() => setInstrument('marimba')}
            className={`px-2.5 py-1 rounded text-[11px] font-mono transition-all ${
              instrument === 'marimba'
                ? 'bg-mango-500 text-jungle-950 font-bold shadow-sm'
                : 'text-cream-200/60 hover:text-cream-100'
            }`}
          >
            🥭 MARIMBA
          </button>
          <button
            onClick={() => setInstrument('synth')}
            className={`px-2.5 py-1 rounded text-[11px] font-mono transition-all ${
              instrument === 'synth'
                ? 'bg-papaya-500 text-white font-bold shadow-sm'
                : 'text-cream-200/60 hover:text-cream-100'
            }`}
          >
            ⚡ LEAD SYNTH
          </button>
        </div>
      </div>

      <div className="flex items-end h-24 gap-1 p-1 bg-jungle-950 rounded-lg border border-jungle-800 overflow-x-auto">
        {KEYS.map((k) => {
          const isPressed = activeKey === k.note;
          if (k.isBlack) {
            return (
              <button
                key={k.note}
                onMouseDown={() => playNote(k)}
                className={`w-7 h-16 -mx-3.5 z-10 rounded-b transition-all flex flex-col justify-end items-center pb-1 ${
                  isPressed
                    ? 'bg-mango-500 text-jungle-950 shadow-glow-mango scale-95'
                    : 'bg-jungle-900 border border-jungle-700 text-cream-200/60 hover:border-mango-500'
                }`}
              >
                <span className="text-[8px] font-mono">{k.keyLabel}</span>
              </button>
            );
          }

          return (
            <button
              key={k.note}
              onMouseDown={() => playNote(k)}
              className={`flex-1 h-full min-w-[28px] rounded-b border transition-all flex flex-col justify-end items-center pb-1 ${
                isPressed
                  ? instrument === 'marimba'
                    ? 'bg-mango-400 border-mango-300 text-jungle-950 shadow-glow-mango'
                    : 'bg-papaya-500 border-papaya-400 text-white shadow-glow-papaya'
                  : 'bg-cream-100/10 border-jungle-700/60 text-cream-200 hover:bg-cream-100/20'
              }`}
            >
              <span className="text-[9px] font-mono font-bold">{k.note}</span>
              <span className="text-[8px] font-mono text-cream-200/50">{k.keyLabel}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

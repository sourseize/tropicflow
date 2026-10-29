import React, { useEffect, useRef, useState } from 'react';
import { AudioEngine } from '../../core/audio/AudioEngine';
import { OscilloscopeRenderer } from '../../core/canvas/OscilloscopeRenderer';
import { SpectrumRenderer } from '../../core/canvas/SpectrumRenderer';
import { Activity, BarChart2 } from 'lucide-react';

export const VisualizerPanel: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [mode, setMode] = useState<'scope' | 'spectrum'>('scope');
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const engine = AudioEngine.getInstance();
    const analyser = engine.masterBus.analyserNode;
    const bufferLength = analyser.frequencyBinCount;
    const timeDomainArray = new Uint8Array(bufferLength);
    const frequencyArray = new Uint8Array(bufferLength);

    const render = () => {
      if (mode === 'scope') {
        engine.masterBus.getWaveformData(timeDomainArray);
        OscilloscopeRenderer.render(ctx, canvas.width, canvas.height, timeDomainArray, '#70E000');
      } else {
        engine.masterBus.getFrequencyData(frequencyArray);
        SpectrumRenderer.render(ctx, canvas.width, canvas.height, frequencyArray);
      }
      animationFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [mode]);

  return (
    <div className="bg-jungle-900 border border-jungle-700/80 rounded-xl p-3 shadow-xl flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-lime-500 animate-pulse" />
          <span className="text-xs font-mono font-bold tracking-wider text-cream-100">
            JUNGLE ANALYZER
          </span>
        </div>

        <div className="flex items-center bg-jungle-950 p-0.5 rounded-lg border border-jungle-800">
          <button
            onClick={() => setMode('scope')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-mono transition-all ${
              mode === 'scope'
                ? 'bg-lime-500 text-jungle-950 font-bold shadow-sm'
                : 'text-cream-200/60 hover:text-cream-100'
            }`}
          >
            <Activity size={12} />
            SCOPE
          </button>
          <button
            onClick={() => setMode('spectrum')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-mono transition-all ${
              mode === 'spectrum'
                ? 'bg-mango-500 text-jungle-950 font-bold shadow-sm'
                : 'text-cream-200/60 hover:text-cream-100'
            }`}
          >
            <BarChart2 size={12} />
            FFT
          </button>
        </div>
      </div>

      <div className="relative rounded-lg overflow-hidden border border-jungle-800 bg-jungle-950">
        <canvas
          ref={canvasRef}
          width={400}
          height={110}
          className="w-full h-[110px] block"
        />
        <div className="absolute bottom-1 right-2 pointer-events-none text-[9px] font-mono text-cream-200/40">
          {mode === 'scope' ? 'TIME DOMAIN 1024' : '20Hz - 22kHz'}
        </div>
      </div>
    </div>
  );
};

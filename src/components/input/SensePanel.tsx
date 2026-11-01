import React, { useEffect, useState } from 'react';
import { AudioEngine } from '../../core/audio/AudioEngine.ts';
import { InputHub } from '../../core/input/InputHub.ts';
import { nearestNote, noteName } from '../../core/input/InputEvents.ts';
import type { SensorStatus } from '../../core/sense/SensorEngine.ts';
import type { SensorReading } from '../../core/sense/SensorAnalysis.ts';
import { Stepper } from '../ui/Stepper.tsx';
import { Mic, AudioLines } from 'lucide-react';

const ROOT_CHOICES = Array.from({ length: 37 }, (_, i) => 36 + i); // C2 .. C5

/**
 * Body of the SENSE module: microphone / virtual-voice sources, tuner and
 * level readout, and the settings that shape PITCH CV (root), ONSET TRIG
 * (which drum) and the tracker (gain, clarity).
 */
export const SensePanel: React.FC = () => {
  const engine = AudioEngine.getInstance();
  const hub = InputHub.getInstance();
  const sensor = hub.sensor;
  const [, force] = useState({});
  const refresh = () => force({});
  const [status, setStatus] = useState<SensorStatus>(sensor.getStatus());
  const [reading, setReading] = useState<SensorReading>(sensor.getReading());
  const [onsetLit, setOnsetLit] = useState(false);

  useEffect(() => {
    const unsubs = [
      sensor.subscribe((s, r) => {
        setStatus({ ...s });
        setReading({ ...r });
      }),
      engine.input.subscribe((e) => {
        if (e.kind === 'onset' && e.device.startsWith('sensor')) {
          setOnsetLit(true);
          setTimeout(() => setOnsetLit(false), 120);
        }
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [engine, sensor]);

  const micOn = status.mic === 'ready';
  const micAvailable = status.mic !== 'unsupported' && status.mic !== 'insecure';
  const settings = engine.input.getSensorSettings();
  const config = sensor.getConfig();
  const tuner = reading.hz !== null ? nearestNote(reading.hz) : null;
  const clear = reading.clarity >= (config.clarityThreshold ?? 0.8);

  const chip = (on: boolean, extra = '') =>
    `flex items-center justify-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-mono ${
      on ? 'bg-lime-500 border-lime-400 text-jungle-950 font-bold' : 'bg-jungle-850 border-jungle-700 text-cream-200/70'
    } ${extra}`;

  return (
    <div className="flex flex-col gap-2" data-testid="sense">
      <div className="grid grid-cols-2 gap-1.5">
        <button
          data-testid="sense-mic"
          title={status.micMessage}
          disabled={!micAvailable || status.mic === 'requesting'}
          onClick={() => {
            if (micOn) sensor.disableMic();
            else void sensor.enableMic();
          }}
          className={chip(micOn, micAvailable ? '' : 'opacity-50 cursor-not-allowed')}
        >
          <Mic size={11} />
          MIC {micOn ? 'ON' : status.mic === 'requesting' ? '...' : 'OFF'}
        </button>
        <button
          data-testid="sense-voice"
          title="Virtual voice: the computer keys sing into the tracker (Space = clap). No microphone needed."
          onClick={() => {
            sensor.setVoiceEnabled(!status.voice);
            refresh();
          }}
          className={chip(status.voice)}
        >
          <AudioLines size={11} />
          VOICE {status.voice ? 'ON' : 'OFF'}
        </button>
      </div>

      <p data-testid="sense-status" title={status.micMessage} className="text-[9px] font-mono text-cream-200/50 leading-tight truncate">
        {status.micMessage}
        {status.voice ? (status.mic === 'ready' ? ' · voice on' : ' · Voice on: keys sing, Space claps') : ''}
      </p>

      <div className="bg-jungle-950 border border-jungle-800 rounded-lg px-2 py-1 flex flex-col gap-1 font-mono">
        <div className="flex items-baseline justify-between gap-1">
          <span data-testid="sense-note" data-clear={clear ? 'true' : 'false'} className={`text-base font-bold leading-tight ${clear ? 'text-lime-400' : 'text-cream-200/40'}`}>
            {tuner ? tuner.name : '—'}
          </span>
          <span data-testid="sense-hz" className="text-[10px] text-cream-200/70">
            {reading.hz !== null ? `${reading.hz.toFixed(1)} Hz` : 'no pitch'}
          </span>
          <span data-testid="sense-clarity" className={`text-[9px] ${clear ? 'text-lime-400' : 'text-cream-200/40'}`} title="clarity">
            {Math.round(reading.clarity * 100)}%
          </span>
        </div>
        <div className="relative h-1.5 rounded bg-jungle-800" title="cents off the nearest note">
          <div className="absolute left-1/2 top-0 h-full w-px bg-cream-200/30" />
          {tuner && (
            <div
              data-testid="sense-cents"
              className={`absolute top-0 h-full w-1 rounded ${Math.abs(tuner.cents) < 10 ? 'bg-lime-400' : 'bg-mango-400'}`}
              style={{ left: `calc(${50 + tuner.cents}% - 2px)` }}
            />
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[9px] text-cream-200/60">
          <span>LEVEL</span>
          <div className="flex-1 h-1 rounded bg-jungle-800 overflow-hidden">
            <div className="h-full bg-papaya-500" style={{ width: `${Math.round(reading.level * 100)}%` }} />
          </div>
          <span data-testid="sense-level" className="w-7 text-right">{Math.round(reading.level * 100)}%</span>
          <div
            data-testid="sense-onset-led"
            data-lit={onsetLit ? 'true' : 'false'}
            title="onset"
            className={`w-2 h-2 rounded-full ${onsetLit ? 'bg-tomato-400 shadow-glow-tomato' : 'bg-jungle-700'}`}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Stepper
          label="GAIN"
          testId="sense-gain"
          value={config.gain}
          min={0.1}
          max={4}
          step={0.1}
          digits={1}
          unit="x"
          onChange={(val) => {
            sensor.updateConfig({ gain: val });
            refresh();
          }}
        />
        <Stepper
          label="CLARITY"
          testId="sense-clarity-threshold"
          value={Math.round((config.clarityThreshold ?? 0.8) * 100)}
          min={50}
          max={98}
          step={2}
          unit="%"
          onChange={(val) => {
            sensor.updateConfig({ clarityThreshold: val / 100 });
            refresh();
          }}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 text-[9px] font-mono text-cream-200/60">
        <label className="flex items-center justify-between gap-1" title="Singing the root gives PITCH CV = 0">
          ROOT
          <select
            data-testid="sense-root"
            value={settings.rootNote}
            onChange={(e) => {
              engine.input.updateSensorSettings({ rootNote: Number(e.target.value) });
              refresh();
            }}
            className="bg-jungle-950 border border-jungle-700 rounded px-1 py-0.5 text-[10px] text-cream-100"
          >
            {ROOT_CHOICES.map((n) => (
              <option key={n} value={n}>
                {noteName(n)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-1" title="Drum fired by ONSET TRIG">
          ONSET
          <select
            data-testid="sense-onset-drum"
            value={settings.onsetDrum}
            onChange={(e) => {
              engine.input.updateSensorSettings({ onsetDrum: e.target.value as 'kick' | 'snare' | 'hihat' });
              refresh();
            }}
            className="bg-jungle-950 border border-jungle-700 rounded px-1 py-0.5 text-[10px] text-cream-100"
          >
            <option value="kick">KICK</option>
            <option value="snare">SNARE</option>
            <option value="hihat">HAT</option>
          </select>
        </label>
      </div>
    </div>
  );
};

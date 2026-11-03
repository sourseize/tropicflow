import React, { useEffect, useState } from 'react';
import { AudioEngine } from '../../core/audio/AudioEngine.ts';
import type { KeyboardDevice } from '../../core/input/keyboard/KeyboardDevice.ts';
import type { WebMidiDevice } from '../../core/input/midi/WebMidiDevice.ts';
import { noteName } from '../../core/input/InputEvents.ts';
import type { MidiStatus } from '../../core/input/midi/WebMidiDevice.ts';
import { Stepper } from '../ui/Stepper.tsx';
import { Keyboard, Cable, Play, Square, Trash2 } from 'lucide-react';

/**
 * Body of the MIDI BRIDGE module: the computer-keys device toggle, Web MIDI
 * enable / input / channel, transpose, activity and the performance log
 * (replay / clear). Notes leave through the GATE OUT jack; cables decide
 * which instruments respond.
 */
interface MidiBridgePanelProps {
  /** The module's devices (each MIDI BRIDGE card shows its own). */
  keyboard: KeyboardDevice;
  midi: WebMidiDevice;
}

export const MidiBridgePanel: React.FC<MidiBridgePanelProps> = ({ keyboard, midi: midiDevice }) => {
  const engine = AudioEngine.getInstance();
  const hub = engine.inputHub;
  const [, force] = useState({});
  const refresh = () => force({});
  const [midi, setMidi] = useState<MidiStatus>(midiDevice.getStatus());
  const [lit, setLit] = useState(false);

  useEffect(() => {
    const unsubs = [
      midiDevice.subscribe((s) => setMidi({ ...s })),
      keyboard.subscribe(refresh),
      hub.subscribeReplay(refresh),
      engine.input.subscribe((e) => {
        if (e.kind === 'noteOn') {
          setLit(true);
          setTimeout(() => setLit(false), 120);
        }
        refresh();
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [engine, hub]);

  const activity = engine.input.getActivity();
  const keys = keyboard.getState();
  const keysOn = !engine.input.isDeviceMuted('keys');
  const midiOn = midiDevice.isEnabled();
  const midiAvailable = midi.state !== 'unsupported' && midi.state !== 'insecure';
  const logCount = engine.input.log.length();
  const replaying = hub.isReplaying();

  const chip = (on: boolean, extra = '') =>
    `flex items-center justify-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-mono ${
      on ? 'bg-papaya-500 border-papaya-400 text-white font-bold' : 'bg-jungle-850 border-jungle-700 text-cream-200/70'
    } ${extra}`;

  return (
    <div className="flex flex-col gap-2" data-testid="midi-bridge">
      <div className="grid grid-cols-2 gap-1.5">
        <button
          data-testid="midi-keys-toggle"
          title="Play with the computer keyboard (A-; notes, Z/X octave, C/V velocity, arrows mod/bend)"
          onClick={() => {
            engine.input.setDeviceMuted('keys', keysOn);
            refresh();
          }}
          className={chip(keysOn)}
        >
          <Keyboard size={11} />
          KEYS {keysOn ? 'ON' : 'OFF'}
        </button>
        <button
          data-testid="midi-enable"
          title={midi.message}
          disabled={!midiAvailable || midi.state === 'requesting'}
          onClick={() => {
            if (midiOn) midiDevice.disable();
            else void midiDevice.enable();
          }}
          className={chip(midiOn, midiAvailable ? '' : 'opacity-50 cursor-not-allowed')}
        >
          <Cable size={11} />
          MIDI {midiOn ? 'ON' : midi.state === 'requesting' ? '...' : 'OFF'}
        </button>
      </div>

      {midiOn ? (
        <div className="grid grid-cols-[1fr_auto] gap-1.5">
          <select
            data-testid="midi-input"
            title={midi.message}
            value={midi.selected}
            onChange={(e) => midiDevice.selectInput(e.target.value)}
            className="bg-jungle-950 border border-jungle-700 rounded px-1 py-0.5 text-[10px] font-mono text-cream-100 min-w-0"
          >
            <option value="all">ALL INPUTS ({midi.inputs.length})</option>
            {midi.inputs.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
                {i.connected ? '' : ' (unplugged)'}
              </option>
            ))}
          </select>
          <select
            data-testid="midi-channel"
            value={midi.channel ?? 'omni'}
            onChange={(e) => midiDevice.setChannel(e.target.value === 'omni' ? undefined : Number(e.target.value))}
            className="bg-jungle-950 border border-jungle-700 rounded px-1 py-0.5 text-[10px] font-mono text-cream-100"
          >
            <option value="omni">OMNI</option>
            {Array.from({ length: 16 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                CH {i + 1}
              </option>
            ))}
          </select>
        </div>
      ) : (
      <p data-testid="midi-status" title={midi.message} className="text-[9px] font-mono text-cream-200/50 leading-tight truncate">
        {midi.message}
      </p>
      )}


      <div className="flex items-center justify-between text-[10px] font-mono">
        <div className="flex items-center gap-1.5">
          <div
            data-testid="midi-led"
            data-lit={lit ? 'true' : 'false'}
            className={`w-2.5 h-2.5 rounded-full transition-colors ${lit ? 'bg-lime-400 shadow-glow-lime' : 'bg-jungle-700'}`}
          />
          <span data-testid="midi-last-note" className="text-cream-100">
            {activity.lastNote ? `${noteName(activity.lastNote.note)} v${Math.round(activity.lastNote.velocity * 127)}` : '—'}
          </span>
        </div>
        <span className="flex items-center gap-1 text-cream-200/60">
          OCT
          <button data-testid="midi-oct-down" onClick={() => keyboard.press('KeyZ')} className="px-1 rounded border border-jungle-700 hover:border-mango-500">
            -
          </button>
          <span data-testid="midi-octave" className="text-cream-100 w-4 text-center">
            {keys.octave > 0 ? `+${keys.octave}` : keys.octave}
          </span>
          <button data-testid="midi-oct-up" onClick={() => keyboard.press('KeyX')} className="px-1 rounded border border-jungle-700 hover:border-mango-500">
            +
          </button>
        </span>
        <span className="text-cream-200/60">
          VEL <span data-testid="midi-velocity" className="text-cream-100">{Math.round(keys.velocity * 100)}%</span>
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <Stepper
          label="TRANSPOSE"
          testId="midi-transpose"
          value={engine.input.getSettings().transpose}
          min={-24}
          max={24}
          unit="st"
          onChange={(val) => {
            engine.input.updateSettings({ transpose: val });
            refresh();
          }}
        />
        <Stepper
          label="BEND RANGE"
          testId="midi-bend-range"
          value={engine.input.getSettings().bendRange}
          min={0}
          max={12}
          unit="st"
          onChange={(val) => {
            engine.input.updateSettings({ bendRange: val });
            refresh();
          }}
        />
      </div>

      <div className="flex items-center gap-1.5 text-[10px] font-mono" title="Current MOD CV / PITCH CV values · performance log">
        <span className="text-cream-200/60 whitespace-nowrap">
          MOD <span data-testid="midi-cv-mod" className="text-cream-100">{Math.round((activity.controls.get('mod') ?? 0) * 100)}%</span>
        </span>
        <span className="text-cream-200/60 whitespace-nowrap">
          BEND{' '}
          <span data-testid="midi-cv-bend" className="text-cream-100">
            {((activity.controls.get('bend') ?? 0) * engine.input.getSettings().bendRange).toFixed(1)}st
          </span>
        </span>
        <span data-testid="midi-log-count" className="text-cream-200/60 whitespace-nowrap ml-auto">
          LOG {logCount}
        </span>
        <button
          data-testid="midi-replay"
          data-replaying={replaying ? 'true' : 'false'}
          disabled={logCount === 0 && !replaying}
          title="Replay the performance logged during the last groove (also what BOUNCE renders)"
          onClick={() => {
            if (replaying) hub.stopScript();
            else hub.replayLog();
            refresh();
          }}
          className={chip(replaying, 'disabled:opacity-40')}
        >
          {replaying ? <Square size={10} /> : <Play size={10} />}
        </button>
        <button
          data-testid="midi-log-clear"
          disabled={logCount === 0}
          title="Clear the log"
          onClick={() => {
            engine.input.log.clear();
            refresh();
          }}
          className="flex items-center px-1.5 py-1 rounded-lg bg-jungle-850 border border-jungle-700 text-cream-200/70 disabled:opacity-40"
        >
          <Trash2 size={10} className="text-tomato-400" />
        </button>
      </div>
    </div>
  );
};

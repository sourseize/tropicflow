import React, { useEffect, useState } from 'react';
import { AudioEngine } from '../../core/audio/AudioEngine.ts';
import { EventBus } from '../../core/events/EventBus.ts';
import { InputHub } from '../../core/input/InputHub.ts';
import { noteName } from '../../core/input/InputEvents.ts';
import { KEY_LAYOUT, noteForOffset } from '../../core/input/keyboard/KeyMap.ts';

/** Instrument chips = cables from the MIDI BRIDGE's GATE OUT (the canvas stays the source of truth). */
const TARGETS = [
  { key: 'marimba', label: '🥭 MARIMBA', portId: 'mrm-trig-in', on: 'bg-mango-500 text-jungle-950' },
  { key: 'synth', label: '⚡ SYNTH', portId: 'syn-gate-in', on: 'bg-papaya-500 text-white' },
  { key: 'drums', label: '🥁 DRUMS', portId: 'perc-trig-in', on: 'bg-tomato-500 text-white' },
] as const;

const GATE_OUT = 'midi-gate-out';

/**
 * The computer-keys device on screen. Keys light for notes from *any* device
 * (MIDI keyboard, replay, console), mouse presses go through the same
 * KeyboardDevice as the physical keys, and the chips patch GATE OUT.
 */
export const VirtualKeyboard: React.FC = () => {
  const engine = AudioEngine.getInstance();
  const hub = InputHub.getInstance();
  const [, force] = useState({});
  const refresh = () => force({});
  const [lit, setLit] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    const unsubs = [
      EventBus.getInstance().subscribe('PATCH_CHANGED', refresh),
      hub.keyboard.subscribe(refresh),
      engine.input.subscribe((e) => {
        if (e.kind !== 'noteOn' && e.kind !== 'noteOff') return;
        setLit((prev) => {
          const next = new Set(prev);
          if (e.kind === 'noteOn') next.add(e.note);
          else next.delete(e.note);
          return next;
        });
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [engine, hub]);

  const patched = new Set(engine.getPatch().filter((c) => c.fromPortId === GATE_OUT).map((c) => c.toPortId));
  const toggleTarget = (portId: string) =>
    EventBus.getInstance().publish({ type: 'PATCH_TOGGLE_REQUEST', timestamp: performance.now(), fromPortId: GATE_OUT, toPortId: portId });

  const state = hub.keyboard.getState();
  const keysOn = !engine.input.isDeviceMuted('keys');

  return (
    <div className="bg-jungle-900 border border-jungle-700/80 rounded-xl p-3 shadow-xl flex flex-col gap-2" data-testid="soundboard">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-2 h-2 rounded-full ${keysOn ? 'bg-papaya-500' : 'bg-jungle-700'}`} />
          <span className="text-xs font-mono font-bold tracking-wider text-cream-100 truncate">
            SOUNDBOARD / KEYS
          </span>
        </div>

        <div className="flex items-center bg-jungle-950 p-0.5 rounded-lg border border-jungle-800" title="Plug / unplug the MIDI BRIDGE's GATE OUT">
          {TARGETS.map((t) => {
            const on = patched.has(t.portId);
            return (
              <button
                key={t.key}
                data-testid={`keys-target-${t.key}`}
                data-on={on ? 'true' : 'false'}
                onClick={() => toggleTarget(t.portId)}
                className={`px-2 py-1 rounded text-[11px] font-mono transition-all whitespace-nowrap ${
                  on ? `${t.on} font-bold shadow-sm` : 'text-cream-200/60 hover:text-cream-100'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-end h-24 gap-1 p-1 bg-jungle-950 rounded-lg border border-jungle-800 overflow-x-auto">
        {KEY_LAYOUT.map((k) => {
          const note = noteForOffset(state, k.offset);
          const isPressed = lit.has(note);
          const common = {
            'data-testid': `key-${k.code}`,
            'data-note': note,
            'data-active': isPressed ? 'true' : 'false',
            onMouseDown: (e: React.MouseEvent) => hub.keyboard.press(k.code, e.timeStamp, e.shiftKey),
            onMouseUp: (e: React.MouseEvent) => hub.keyboard.release(k.code, e.timeStamp),
            onMouseLeave: (e: React.MouseEvent) => hub.keyboard.release(k.code, e.timeStamp),
          };
          if (k.black) {
            return (
              <button
                key={k.code}
                {...common}
                className={`w-7 h-16 -mx-3.5 z-10 rounded-b transition-all flex flex-col justify-end items-center pb-1 ${
                  isPressed
                    ? 'bg-mango-500 text-jungle-950 shadow-glow-mango scale-95'
                    : 'bg-jungle-900 border border-jungle-700 text-cream-200/60 hover:border-mango-500'
                }`}
              >
                <span className="text-[8px] font-mono">{k.label}</span>
              </button>
            );
          }
          return (
            <button
              key={k.code}
              {...common}
              className={`flex-1 h-full min-w-[26px] rounded-b border transition-all flex flex-col justify-end items-center pb-1 ${
                isPressed
                  ? 'bg-papaya-500 border-papaya-400 text-white shadow-glow-papaya'
                  : 'bg-cream-100/10 border-jungle-700/60 text-cream-200 hover:bg-cream-100/20'
              }`}
            >
              <span className="text-[9px] font-mono font-bold">{noteName(note)}</span>
              <span className="text-[8px] font-mono text-cream-200/50">{k.label}</span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between text-[9px] font-mono text-cream-200/40 leading-tight">
        <span>
          OCT <span className="text-cream-100" data-testid="keys-octave">{state.octave > 0 ? `+${state.octave}` : state.octave}</span>
          {' · '}VEL <span className="text-cream-100" data-testid="keys-velocity">{Math.round(state.velocity * 100)}%</span>
          {' · '}MOD <span className="text-cream-100">{Math.round(state.mod * 100)}%</span>
        </span>
        <span>Z/X oct · C/V vel · ⇧ accent · ↑↓ mod · ←→ bend</span>
      </div>
    </div>
  );
};

import React, { useEffect, useState } from 'react';
import { AudioEngine } from '../../core/audio/AudioEngine.ts';
import type { PercussionModule } from '../../modules/percussion/module.ts';
import type { MarimbaModule } from '../../modules/marimba/module.ts';
import type { SynthModule } from '../../modules/synth/module.ts';
import { EventBus } from '../../core/events/EventBus.ts';
import type { StepTriggeredEvent } from '../../core/events/DomainEvents.ts';
import { Music, Volume2, Sparkles, Disc } from 'lucide-react';

export const StepSequencer: React.FC = () => {
  const engine = AudioEngine.getInstance();
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [pattern, setPattern] = useState(engine.getPattern());
  const [activeTracks, setActiveTracks] = useState<string[]>([]);

  useEffect(() => {
    const eventBus = EventBus.getInstance();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const unsubscribe = eventBus.subscribe<StepTriggeredEvent>('STEP_TRIGGERED', (event) => {
      // Steps are scheduled up to 100 ms ahead of the audio clock; delay the
      // visual update so the playhead moves when the step actually sounds.
      const leadMs = Math.max(0, (event.audioTime - event.contextTime) * 1000);
      const timer = setTimeout(() => {
        timers.delete(timer);
        setCurrentStep(event.stepIndex);
        setActiveTracks(event.activeTracks);
      }, leadMs);
      timers.add(timer);
    });

    return () => {
      unsubscribe();
      timers.forEach((t) => clearTimeout(t));
    };
  }, []);

  // The instrument modules a track auditions on / is played by (absent modules show a hint).
  const [, bumpRack] = useState(0);
  useEffect(() => engine.rack.subscribe((change) => (change === 'modules' || change === 'reset') && bumpRack((v) => v + 1)), [engine]);
  const auditionTarget = (track: string): boolean => {
    const type = track === 'marimba' ? 'marimba' : track === 'synth' ? 'synth' : 'percussion';
    return engine.rack.findByType(type) !== null;
  };

  const handleStepToggle = (track: 'kick' | 'snare' | 'hihat' | 'marimba' | 'synth', stepIdx: number) => {
    engine.togglePatternStep(track, stepIdx);
    setPattern({ ...engine.getPattern() });
  };

  const tracks = [
    {
      id: 'kick' as const,
      name: 'TOMATO KICK',
      color: 'border-tomato-500 bg-tomato-500',
      activeColor: 'bg-tomato-500 text-white shadow-glow-tomato',
      glow: 'shadow-glow-tomato',
      icon: Disc,
      accentHex: '#FF382E',
    },
    {
      id: 'snare' as const,
      name: 'PAPAYA SNARE',
      color: 'border-papaya-500 bg-papaya-500',
      activeColor: 'bg-papaya-500 text-white shadow-glow-papaya',
      glow: 'shadow-glow-papaya',
      icon: Volume2,
      accentHex: '#FF6B35',
    },
    {
      id: 'hihat' as const,
      name: 'LIME HI-HAT',
      color: 'border-lime-500 bg-lime-500',
      activeColor: 'bg-lime-500 text-jungle-950 shadow-glow-lime',
      glow: 'shadow-glow-lime',
      icon: Sparkles,
      accentHex: '#70E000',
    },
    {
      id: 'marimba' as const,
      name: 'MANGO MARIMBA',
      color: 'border-mango-500 bg-mango-500',
      activeColor: 'bg-mango-500 text-jungle-950 shadow-glow-mango',
      glow: 'shadow-glow-mango',
      icon: Music,
      accentHex: '#FF9E00',
    },
    {
      id: 'synth' as const,
      name: 'TROPIC BASS',
      color: 'border-mango-400 bg-mango-400',
      activeColor: 'bg-mango-400 text-jungle-950 shadow-glow-mango',
      glow: 'shadow-glow-mango',
      icon: Music,
      accentHex: '#FFB733',
    },
  ];

  return (
    <div className="bg-jungle-900 border border-jungle-700/80 rounded-xl p-4 shadow-xl flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-mango-500" />
          <h3 className="text-xs font-mono font-bold tracking-wider text-cream-100">
            16-STEP TROPICAL GROOVE MATRIX
          </h3>
        </div>
        <div className="flex items-center gap-2 font-mono text-[10px] text-cream-200/60">
          <span>STEP</span>
          <span className="text-mango-400 font-bold bg-jungle-950 px-2 py-0.5 rounded border border-jungle-800">
            {String(currentStep + 1).padStart(2, '0')} / 16
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {tracks.map((track) => {
          const Icon = track.icon;
          const isTriggeringNow = activeTracks.includes(track.id);

          return (
            <div key={track.id} className="flex items-center gap-2">
              <button
                title={auditionTarget(track.id) ? 'Audition' : 'Add the instrument module to audition this track'}
                onClick={() => {
                  // Audition the track on the instrument module, if it is in the rack.
                  const drums = engine.rack.findByType<PercussionModule>('percussion')?.drums;
                  const marimba = engine.rack.findByType<MarimbaModule>('marimba')?.model;
                  const synth = engine.rack.findByType<SynthModule>('synth')?.voice;
                  if (track.id === 'kick') drums?.triggerKick();
                  else if (track.id === 'snare') drums?.triggerSnare();
                  else if (track.id === 'hihat') drums?.triggerHiHat();
                  else if (track.id === 'marimba') marimba?.strike(329.63);
                  else if (track.id === 'synth') synth?.triggerNote(130.81, 0.8, 0.2);
                }}
                data-missing-module={auditionTarget(track.id) ? undefined : 'true'}
                className={`w-36 flex items-center justify-between px-2.5 py-1.5 rounded-lg border text-left transition-all ${
                  isTriggeringNow
                    ? `${track.color} text-jungle-950 font-bold shadow-md`
                    : auditionTarget(track.id)
                      ? 'bg-jungle-950/70 border-jungle-800 text-cream-200/80 hover:border-jungle-600'
                      : 'bg-jungle-950/40 border-dashed border-jungle-800 text-cream-200/35'
                }`}
              >
                <div className="flex items-center gap-1.5 truncate">
                  <Icon size={12} style={{ color: isTriggeringNow ? '#070f0a' : track.accentHex }} />
                  <span className="text-[10px] font-mono tracking-tight font-bold truncate">
                    {track.name}
                  </span>
                </div>
                <div
                  className="w-1.5 h-1.5 rounded-full"
                  style={{
                    backgroundColor: track.accentHex,
                    boxShadow: isTriggeringNow ? `0 0 8px ${track.accentHex}` : undefined,
                  }}
                />
              </button>

              <div className="grid grid-cols-16 gap-1 flex-1">
                {pattern[track.id].map((isActive, stepIdx) => {
                  const isCurrent = currentStep === stepIdx;
                  const isQuarterBeat = stepIdx % 4 === 0;

                  return (
                    <button
                      key={stepIdx}
                      onClick={() => handleStepToggle(track.id, stepIdx)}
                      className={`h-7 rounded transition-colors duration-75 flex items-center justify-center relative font-mono text-[9px] ${
                        isActive
                          ? track.activeColor
                          : isQuarterBeat
                          ? 'bg-jungle-850 hover:bg-jungle-700/60 border border-jungle-700/70'
                          : 'bg-jungle-950 hover:bg-jungle-800/80 border border-jungle-800/50'
                      } ${
                        isCurrent
                          ? 'ring-2 ring-cream-100 scale-105 z-10'
                          : ''
                      }`}
                    >
                      {isActive && (
                        <div
                          className="w-1.5 h-1.5 rounded-full"
                          style={{
                            backgroundColor: track.id === 'kick' || track.id === 'snare' ? '#ffffff' : '#070f0a',
                          }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

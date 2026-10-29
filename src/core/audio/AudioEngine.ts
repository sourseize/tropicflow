import { AudioContextManager } from './AudioContextManager';
import { MasterBus } from './MasterBus';
import { DelayEffect } from './DelayEffect';
import { OscillatorVoice } from './OscillatorVoice';
import { MarimbaModel } from './MarimbaModel';
import { PercussionEngine } from './PercussionEngine';
import { AudioClock } from './AudioClock';
import { EventBus } from '../events/EventBus';
import { NoteOnEvent, StepTriggeredEvent } from '../events/DomainEvents';

export class AudioEngine {
  private static instance: AudioEngine;
  public readonly contextManager: AudioContextManager;
  public readonly masterBus: MasterBus;
  public readonly delay: DelayEffect;
  public readonly synth: OscillatorVoice;
  public readonly marimba: MarimbaModel;
  public readonly drums: PercussionEngine;
  public readonly clock: AudioClock;
  private readonly eventBus: EventBus;

  private pattern: {
    kick: boolean[];
    snare: boolean[];
    hihat: boolean[];
    marimba: boolean[];
    synth: boolean[];
  } = {
    kick:    [true,  false, false, false, true,  false, false, false, true,  false, false, false, true,  false, false, false],
    snare:   [false, false, false, false, true,  false, false, false, false, false, false, false, true,  false, false, false],
    hihat:   [true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true],
    marimba: [true,  false, false, true,  false, false, true,  false, false, true,  false, false, true,  false, true,  false],
    synth:   [false, false, true,  false, false, false, false, true,  false, false, true,  false, false, false, false, true],
  };

  private readonly marimbaNotes = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25];
  private readonly synthNotes = [130.81, 164.81, 196.00, 220.00, 261.63];

  private constructor() {
    this.contextManager = AudioContextManager.getInstance();
    this.masterBus = new MasterBus();
    this.delay = new DelayEffect();
    this.synth = new OscillatorVoice();
    this.marimba = new MarimbaModel();
    this.drums = new PercussionEngine();
    this.clock = new AudioClock();
    this.eventBus = EventBus.getInstance();

    this.wireAudioGraph();
    this.bindClock();
  }

  public static getInstance(): AudioEngine {
    if (!AudioEngine.instance) {
      AudioEngine.instance = new AudioEngine();
    }
    return AudioEngine.instance;
  }

  private wireAudioGraph(): void {
    this.synth.outputNode.connect(this.masterBus.inputNode);
    this.synth.outputNode.connect(this.delay.inputNode);

    this.marimba.outputNode.connect(this.masterBus.inputNode);
    this.marimba.outputNode.connect(this.delay.inputNode);

    this.drums.outputNode.connect(this.masterBus.inputNode);
    this.delay.outputNode.connect(this.masterBus.inputNode);
  }

  private bindClock(): void {
    this.clock.subscribe((stepIndex) => {
      const activeTracks: string[] = [];

      if (this.pattern.kick[stepIndex]) {
        this.drums.triggerKick(0.95);
        activeTracks.push('kick');
      }
      if (this.pattern.snare[stepIndex]) {
        this.drums.triggerSnare(0.8);
        activeTracks.push('snare');
      }
      if (this.pattern.hihat[stepIndex]) {
        const isOpen = stepIndex % 4 === 2;
        this.drums.triggerHiHat(0.65, isOpen);
        activeTracks.push('hihat');
      }
      if (this.pattern.marimba[stepIndex]) {
        const noteIdx = (stepIndex * 2) % this.marimbaNotes.length;
        const freq = this.marimbaNotes[noteIdx];
        this.marimba.strike(freq, 0.75);
        activeTracks.push('marimba');
      }
      if (this.pattern.synth[stepIndex]) {
        const bassIdx = (stepIndex) % this.synthNotes.length;
        const freq = this.synthNotes[bassIdx];
        this.synth.triggerNote(freq, 0.7, 0.18);
        activeTracks.push('synth');
      }

      const event: StepTriggeredEvent = {
        type: 'STEP_TRIGGERED',
        timestamp: performance.now(),
        stepIndex,
        activeTracks,
      };
      this.eventBus.publish(event);
    });
  }

  public async startAudio(): Promise<void> {
    await this.contextManager.resumeIfNeeded();
    this.clock.start();
    this.eventBus.publish({
      type: 'AUDIO_STARTED',
      timestamp: performance.now(),
    });
  }

  public stopAudio(): void {
    this.clock.stop();
    this.eventBus.publish({
      type: 'AUDIO_STOPPED',
      timestamp: performance.now(),
    });
  }

  public togglePatternStep(track: keyof typeof this.pattern, stepIndex: number): boolean {
    if (this.pattern[track] && stepIndex >= 0 && stepIndex < 16) {
      this.pattern[track][stepIndex] = !this.pattern[track][stepIndex];
      return this.pattern[track][stepIndex];
    }
    return false;
  }

  public getPattern() {
    return this.pattern;
  }

  public playDirectNote(channel: 'synth' | 'marimba', frequency: number): void {
    this.contextManager.resumeIfNeeded();
    if (channel === 'synth') {
      this.synth.triggerNote(frequency, 0.85, 0.3);
    } else {
      this.marimba.strike(frequency, 0.9);
    }

    const event: NoteOnEvent = {
      type: 'NOTE_ON',
      timestamp: performance.now(),
      channel,
      frequency,
      velocity: 0.85,
    };
    this.eventBus.publish(event);
  }
}

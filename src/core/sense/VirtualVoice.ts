/**
 * A stand-in for the microphone that the computer keys can "sing" through:
 * a soft sawtooth with vibrato and a little breath noise that glides between
 * the notes of held keys, plus a clap (noise burst) for onset tests. Its
 * output feeds the same tracker path as the microphone, so everything about
 * the SENSE module can be exercised without a mic.
 */
import { SeededRandom } from '../util/SeededRandom.ts';
import { midiNoteToHz } from '../input/InputEvents.ts';

export class VirtualVoice {
  public readonly outputNode: GainNode;
  private readonly ctx: BaseAudioContext;
  private readonly osc: OscillatorNode;
  private readonly lfo: OscillatorNode;
  private readonly breath: AudioBufferSourceNode;
  private readonly voiceGain: GainNode;
  private readonly noiseBuffer: AudioBuffer;
  private held: number[] = [];
  private started = false;

  /** Every persistent node, for dispose(). */
  private readonly nodes: AudioNode[] = [];

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.outputNode = ctx.createGain();
    this.outputNode.gain.value = 1;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1800;
    filter.Q.value = 0.7;

    this.voiceGain = ctx.createGain();
    this.voiceGain.gain.value = 0;

    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc.frequency.value = 220;

    // Vibrato: 5.5 Hz, +-12 cents.
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 5.5;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 12;
    this.lfo.connect(lfoDepth).connect(this.osc.detune);

    // Breath: a little filtered noise under the tone.
    const rng = new SeededRandom(0xb4ea7);
    this.noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1), ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = rng.bipolar();
    this.breath = ctx.createBufferSource();
    this.breath.buffer = this.noiseBuffer;
    this.breath.loop = true;
    const breathGain = ctx.createGain();
    breathGain.gain.value = 0.03;
    const breathFilter = ctx.createBiquadFilter();
    breathFilter.type = 'bandpass';
    breathFilter.frequency.value = 2500;
    breathFilter.Q.value = 0.5;
    this.breath.connect(breathFilter).connect(breathGain).connect(this.voiceGain);

    this.osc.connect(filter).connect(this.voiceGain);
    this.voiceGain.connect(this.outputNode);
    this.nodes.push(this.outputNode, filter, this.voiceGain, this.osc, this.lfo, lfoDepth, this.breath, breathGain, breathFilter);
  }

  /** Stop the sources and tear the graph down. Idempotent. */
  public dispose(): void {
    if (this.started) {
      this.started = false;
      try {
        this.osc.stop();
        this.lfo.stop();
        this.breath.stop();
      } catch {
        /* already stopped */
      }
    }
    for (const n of this.nodes) n.disconnect();
  }

  /** Start the sources (idempotent). */
  public start(): void {
    if (this.started) return;
    this.started = true;
    const t = this.ctx.currentTime;
    this.osc.start(t);
    this.lfo.start(t);
    this.breath.start(t);
  }

  public isSinging(): boolean {
    return this.held.length > 0;
  }

  /** Sing a note: glide to it (60 ms) and open the voice. */
  public noteOn(note: number, when: number = this.ctx.currentTime): void {
    this.start();
    const t = Math.max(when, this.ctx.currentTime);
    this.held = [...this.held.filter((n) => n !== note), note];
    this.osc.frequency.setTargetAtTime(midiNoteToHz(note), t, 0.02);
    this.voiceGain.gain.setTargetAtTime(0.5, t, 0.015);
  }

  /** Release a note: glide back to the previous held note, or close the voice. */
  public noteOff(note: number, when: number = this.ctx.currentTime): void {
    const t = Math.max(when, this.ctx.currentTime);
    this.held = this.held.filter((n) => n !== note);
    if (this.held.length > 0) {
      this.osc.frequency.setTargetAtTime(midiNoteToHz(this.held[this.held.length - 1]), t, 0.02);
    } else {
      this.voiceGain.gain.setTargetAtTime(0, t, 0.03);
    }
  }

  public releaseAll(when: number = this.ctx.currentTime): void {
    this.held = [];
    this.voiceGain.gain.setTargetAtTime(0, Math.max(when, this.ctx.currentTime), 0.03);
  }

  /**
   * A clap: a 40 ms noise burst with a linear decay straight into the output.
   * Long enough that the tracker's ~16 ms polls cannot miss it (a 5 ms click
   * could fall between two polls under load).
   */
  public clap(strength: number = 0.8, when: number = this.ctx.currentTime): void {
    this.start();
    const t = Math.max(when, this.ctx.currentTime);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.05, Math.min(1, strength)), t);
    g.gain.linearRampToValueAtTime(0, t + 0.04);
    src.connect(g).connect(this.outputNode);
    src.start(t);
    src.stop(t + 0.045);
    src.addEventListener('ended', () => g.disconnect());
  }
}

import type { AudioEngine } from '../core/audio/AudioEngine';
import type { InputHub } from '../core/input/InputHub';
import type { RenderConfig } from '../core/render/RenderConfig';
import type { WavBitDepth } from '../core/render/WavCodec';
import type { HarnessRenderResult } from '../harness/render-harness';

declare global {
  interface Window {
    /** Realtime engine singleton (set in main.tsx); used by UI tests and console debugging. */
    tropicflowEngine: AudioEngine;
    /**
     * Hardware bridge (set in main.tsx): inject MIDI bytes, replay scripts,
     * inspect devices. `tropicflowInput.send([0x90, 60, 100])` plays C4.
     */
    tropicflowInput: InputHub;
    /** Headless render API (set by src/harness/render-harness.ts when bundled for tests). */
    tropicflow: {
      presets: string[];
      presetConfig(name: string): RenderConfig;
      render(config: RenderConfig, bitDepth?: WavBitDepth, oggKbps?: number): Promise<HarnessRenderResult>;
      capabilities(): { secureContext: boolean; audioWorklet: boolean; opusEngine: 'webcodecs' | 'mediarecorder' | null };
    };
  }
}

export {};

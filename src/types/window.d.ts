import type { AudioEngine } from '../core/audio/AudioEngine';
import type { RenderConfig } from '../core/render/RenderConfig';
import type { WavBitDepth } from '../core/render/WavCodec';
import type { HarnessRenderResult } from '../harness/render-harness';

declare global {
  interface Window {
    /** Realtime engine singleton (set in main.tsx); used by UI tests and console debugging. */
    tropicflowEngine: AudioEngine;
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

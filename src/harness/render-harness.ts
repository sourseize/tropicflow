/**
 * Browser-side entry point for headless rendering. Bundled by
 * scripts/lib/browserRender.ts and injected into a Playwright page; exposes
 * `window.tropicflow` so Node can request deterministic renders from the real
 * browser Web Audio implementation.
 */
import { renderOffline } from '../core/render/OfflineRenderer.ts';
import { encodeWav, type WavBitDepth } from '../core/render/WavCodec.ts';
import { detectOpusEngine, encodeOggOpus } from '../core/export/OpusEncoder.ts';
import { RENDER_PRESETS } from '../core/render/presets.ts';
import type { RenderConfig, ScoreEvent } from '../core/render/RenderConfig.ts';

export interface HarnessRenderResult {
  wavBase64: string;
  /** Pre-compressor tap, same format. */
  tapWavBase64: string;
  score: ScoreEvent[];
  sampleRate: number;
  frames: number;
  patternEnd: number;
  busLatency: number;
  /** Ogg Opus of the master output, when `oggKbps` was requested. */
  oggBase64?: string;
  /** Which Opus engine produced it ('webcodecs' unless the page is not a secure context). */
  oggEngine?: string;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

const api = {
  presets: Object.keys(RENDER_PRESETS),
  presetConfig(name: string): RenderConfig {
    const factory = RENDER_PRESETS[name];
    if (!factory) throw new Error(`Unknown preset "${name}"`);
    return factory();
  },
  async render(config: RenderConfig, bitDepth: WavBitDepth = 32, oggKbps?: number): Promise<HarnessRenderResult> {
    const result = await renderOffline(config);
    const wav = encodeWav(result.channels, result.sampleRate, bitDepth);
    const tap = encodeWav(result.tapChannels, result.sampleRate, bitDepth);
    const out: HarnessRenderResult = {
      wavBase64: toBase64(wav),
      tapWavBase64: toBase64(tap),
      score: result.score,
      sampleRate: result.sampleRate,
      frames: result.channels[0].length,
      patternEnd: result.patternEnd,
      busLatency: result.busLatency,
    };
    if (oggKbps) {
      const engine = detectOpusEngine();
      if (!engine) throw new Error('Opus encoding is not available in this browser context');
      const ogg = await encodeOggOpus(result.channels, result.sampleRate, { bitrateKbps: oggKbps });
      out.oggBase64 = toBase64(ogg.buffer.slice(ogg.byteOffset, ogg.byteOffset + ogg.byteLength) as ArrayBuffer);
      out.oggEngine = engine;
    }
    return out;
  },
  /** Capabilities of this page, for tooling diagnostics. */
  capabilities() {
    return {
      secureContext: typeof window !== 'undefined' && window.isSecureContext,
      audioWorklet: typeof AudioWorkletNode !== 'undefined',
      opusEngine: detectOpusEngine(),
    };
  },
};

window.tropicflow = api;

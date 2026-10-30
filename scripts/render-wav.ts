/**
 * Render a preset or JSON config to a WAV file using headless Chromium.
 *
 *   npm run render:wav -- --preset default-groove --bars 2 --out out.wav
 *   npm run render:wav -- --config my-config.json --out out.wav --score out.score.json
 *
 * Writes <out>.wav (master output), <out>.score.json (scheduled notes) and,
 * with --tap, the pre-compressor tap used for exact timing verification.
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserRenderer } from './lib/browserRender.ts';
import type { RenderConfig } from '../src/core/render/RenderConfig.ts';
import type { WavBitDepth } from '../src/core/render/WavCodec.ts';

const { values } = parseArgs({
  options: {
    preset: { type: 'string', default: 'default-groove' },
    config: { type: 'string' },
    out: { type: 'string', default: 'render.wav' },
    score: { type: 'string' },
    tap: { type: 'string' },
    bars: { type: 'string' },
    bpm: { type: 'string' },
    swing: { type: 'string' },
    'sample-rate': { type: 'string' },
    'bit-depth': { type: 'string', default: '32' },
    /** Comma-separated tracks to solo (e.g. "hihat" or "kick,snare"). */
    solo: { type: 'string' },
    /** Bypass the delay (wet mix 0) so stems contain only direct hits. */
    dry: { type: 'boolean', default: false },
    'list-presets': { type: 'boolean', default: false },
  },
});

async function main(): Promise<void> {
  const renderer = await BrowserRenderer.create();
  try {
    if (values['list-presets']) {
      console.log((await renderer.presets()).join('\n'));
      return;
    }

    let config: RenderConfig;
    if (values.config) {
      config = JSON.parse(fs.readFileSync(values.config, 'utf8')) as RenderConfig;
    } else {
      config = await renderer.presetConfig(values.preset!);
    }
    if (values.bars) config.bars = Number(values.bars);
    if (values.bpm) config.bpm = Number(values.bpm);
    if (values.swing) config.swing = Number(values.swing);
    if (values['sample-rate']) config.sampleRate = Number(values['sample-rate']);
    if (values.solo) config.solo = values.solo.split(',').map((t) => t.trim());
    if (values.dry) config.delay = { ...(config.delay ?? {}), mix: 0 };
    const bitDepth = Number(values['bit-depth']) as WavBitDepth;

    const started = Date.now();
    const result = await renderer.render(config, bitDepth);
    const outPath = path.resolve(values.out!);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, result.wav);

    if (values.tap) fs.writeFileSync(path.resolve(values.tap), result.tapWav);
    const scorePath = values.score ?? outPath.replace(/\.wav$/i, '') + '.score.json';
    fs.writeFileSync(scorePath, JSON.stringify({ config, busLatency: result.busLatency, patternEnd: result.patternEnd, score: result.score }, null, 2));

    console.log(
      `Rendered ${config.bars} bar(s) @ ${config.bpm} BPM, ${result.sampleRate} Hz, ${result.frames} frames ` +
        `(${(result.frames / result.sampleRate).toFixed(2)} s) in ${Date.now() - started} ms`
    );
    console.log(`  wav:   ${outPath}`);
    console.log(`  score: ${scorePath} (${result.score.length} note events, bus latency ${(result.busLatency * 1000).toFixed(2)} ms)`);
    if (values.tap) console.log(`  tap:   ${path.resolve(values.tap)} (pre-compressor)`);
  } finally {
    await renderer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Render a preset or JSON config to a WAV file using headless Chromium.
 *
 *   npm run render:wav -- --preset default-groove --bars 2 --out out.wav
 *   npm run render:wav -- --config my-config.json --out out.wav --score out.score.json
 *   npm run render:wav -- --preset chamber-only --ogg 128 --out out/chamber.wav   (+ out/chamber.ogg)
 *   npm run render:wav -- --preset default-groove --input performance.json --out out/take.wav
 *
 * --input replays a performance (an input script: the JSON from the MIDI
 * BRIDGE's log, or the `config.inputScript` of a bounce score file) through
 * the MIDI BRIDGE; GATE OUT cables decide which instruments respond.
 * --sense analyses a mono/stereo WAV (a recording of a voice, claps...) with
 * the SENSE module's pitch / level / onset detectors and feeds the result in
 * as sensor events (PITCH CV, LEVEL CV, ONSET TRIG per the cables).
 *
 * Writes <out>.wav (master output), <out>.score.json (scheduled notes) and,
 * with --tap, the pre-compressor tap used for exact timing verification.
 * With --ogg <kbps> the master output is also encoded to Ogg Opus by the
 * browser's WebCodecs encoder (verify it with `npm run inspect:ogg`).
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserRenderer } from './lib/browserRender.ts';
import type { RenderConfig } from '../src/core/render/RenderConfig.ts';
import type { WavBitDepth } from '../src/core/render/WavCodec.ts';
import { parseInputScript } from '../src/core/input/InputLog.ts';
import { decodeWav } from '../src/core/render/WavCodec.ts';
import { toMono } from '../src/core/analysis/AudioAnalysis.ts';
import { analyseBuffer } from '../src/core/sense/SensorAnalysis.ts';

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
    /** Also write <out>.ogg (Opus) at this bitrate in kb/s. */
    ogg: { type: 'string' },
    /** Input script JSON (or a score file containing config.inputScript) replayed through the MIDI BRIDGE. */
    input: { type: 'string' },
    /** Semitones added to every replayed note. */
    transpose: { type: 'string' },
    /** WAV file analysed offline by the SENSE detectors into sensor events. */
    sense: { type: 'string' },
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
    if (values.input) {
      const raw = JSON.parse(fs.readFileSync(values.input, 'utf8')) as { config?: { inputScript?: unknown } };
      config.inputScript = parseInputScript(raw.config?.inputScript ?? raw);
    }
    if (values.transpose) config.bridge = { ...(config.bridge ?? {}), transpose: Number(values.transpose) };
    if (values.sense) {
      const wav = decodeWav(fs.readFileSync(values.sense));
      const mono = wav.channels.length === 1 ? wav.channels[0] : toMono(wav.channels);
      const events = analyseBuffer(mono, wav.sampleRate, { device: 'sensor:file' });
      const existing = config.inputScript?.events ?? [];
      config.inputScript = { version: 1, events: [...existing, ...events].sort((a, b) => a.time - b.time) };
      console.log(`  sense: ${values.sense} -> ${events.filter((e) => e.kind === 'pitch').length} pitch, ${events.filter((e) => e.kind === 'onset').length} onset, ${events.filter((e) => e.kind === 'level').length} level events`);
    }
    const bitDepth = Number(values['bit-depth']) as WavBitDepth;
    const oggKbps = values.ogg ? Number(values.ogg) : undefined;
    if (oggKbps !== undefined && !(oggKbps >= 6 && oggKbps <= 510)) throw new Error('--ogg expects a bitrate in kb/s between 6 and 510');

    const started = Date.now();
    const result = await renderer.render(config, bitDepth, oggKbps);
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
    if (result.ogg) {
      const oggPath = outPath.replace(/\.wav$/i, '') + '.ogg';
      fs.writeFileSync(oggPath, result.ogg);
      console.log(`  ogg:   ${oggPath} (${(result.ogg.length / 1024).toFixed(0)} KB, Opus ${oggKbps} kb/s via ${result.oggEngine})`);
    }
  } finally {
    await renderer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Inspect and validate an Ogg Opus file without any external tool.
 *
 *   npm run inspect:ogg -- out/groove.ogg
 *   npm run inspect:ogg -- out/groove.ogg --json
 *   npm run inspect:ogg -- out/groove.ogg --expect-seconds 4.0 --tolerance-ms 1
 *
 * Checks: capture patterns, every page CRC, BOS/EOS flags, OpusHead/OpusTags,
 * monotonic granule positions, and that the duration implied by the last
 * granule position matches --expect-seconds when given.
 * Exit code 0 = valid, 1 = problems found.
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { OPUS_SAMPLE_RATE, parseOggPages, parseOpusHead } from '../src/core/export/OggOpus.ts';
import { opusPacketSamples } from '../src/core/export/OpusPacket.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean', default: false },
    'expect-seconds': { type: 'string' },
    'tolerance-ms': { type: 'string', default: '1' },
  },
});

const file = positionals[0];
if (!file) {
  console.error('usage: npm run inspect:ogg -- <file.ogg> [--json] [--expect-seconds N] [--tolerance-ms N]');
  process.exit(2);
}

const bytes = new Uint8Array(fs.readFileSync(file));
const problems: string[] = [];

let pages: ReturnType<typeof parseOggPages> = [];
try {
  pages = parseOggPages(bytes);
} catch (err) {
  problems.push(`structure: ${(err as Error).message}`);
}

const badCrc = pages.filter((p) => !p.crcOk).map((p) => p.pageSequence);
if (badCrc.length) problems.push(`CRC mismatch on page(s) ${badCrc.join(', ')}`);
if (pages.length && !pages[0].flags.bos) problems.push('first page is not BOS');
if (pages.length && !pages[pages.length - 1].flags.eos) problems.push('last page is not EOS');
pages.forEach((p, i) => {
  if (p.pageSequence !== i) problems.push(`page ${i} has sequence number ${p.pageSequence}`);
});

let head: ReturnType<typeof parseOpusHead> | null = null;
let tags: { vendor: string; comments: string[] } | null = null;
try {
  if (pages.length < 2) throw new Error('fewer than two header pages');
  head = parseOpusHead(pages[0].packets[0]);
  const t = pages[1].packets[0];
  if (String.fromCharCode(...t.subarray(0, 8)) !== 'OpusTags') throw new Error('second packet is not OpusTags');
  const view = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const dec = new TextDecoder();
  let p = 8;
  const vendorLen = view.getUint32(p, true);
  p += 4;
  const vendor = dec.decode(t.subarray(p, p + vendorLen));
  p += vendorLen;
  const n = view.getUint32(p, true);
  p += 4;
  const comments: string[] = [];
  for (let i = 0; i < n; i++) {
    const len = view.getUint32(p, true);
    p += 4;
    comments.push(dec.decode(t.subarray(p, p + len)));
    p += len;
  }
  tags = { vendor, comments };
} catch (err) {
  problems.push(`headers: ${(err as Error).message}`);
}

const audioPages = pages.slice(2);
const packets = audioPages.flatMap((p) => p.packets);
let samples = 0;
let lastGranule = -1n;
for (const p of audioPages) {
  if (p.granulePosition !== 0xffffffffffffffffn) {
    if (p.granulePosition < lastGranule) problems.push(`granule position goes backwards on page ${p.pageSequence}`);
    lastGranule = p.granulePosition;
  }
}
const packetDurations = new Map<number, number>();
for (const pk of packets) {
  try {
    const n = opusPacketSamples(pk);
    samples += n;
    packetDurations.set(n, (packetDurations.get(n) ?? 0) + 1);
  } catch (err) {
    problems.push(`packet: ${(err as Error).message}`);
  }
}

const finalGranule = audioPages.length ? audioPages[audioPages.length - 1].granulePosition : 0n;
const preSkip = head?.preSkip ?? 0;
const durationSeconds = Number(finalGranule - BigInt(preSkip)) / OPUS_SAMPLE_RATE;
if (audioPages.length && Number(finalGranule) > samples) problems.push(`final granule ${finalGranule} exceeds decoded samples ${samples}`);
if (audioPages.length && Number(finalGranule) < preSkip) problems.push('final granule smaller than pre-skip');

if (values['expect-seconds']) {
  const expected = Number(values['expect-seconds']);
  const tol = Number(values['tolerance-ms']) / 1000;
  if (Math.abs(durationSeconds - expected) > tol) {
    problems.push(`duration ${durationSeconds.toFixed(4)} s differs from expected ${expected} s by more than ${values['tolerance-ms']} ms`);
  }
}

const audioBytes = packets.reduce((n, p) => n + p.length, 0);
const report = {
  file,
  bytes: bytes.length,
  pages: pages.length,
  audioPages: audioPages.length,
  packets: packets.length,
  packetDurationsMs: Object.fromEntries([...packetDurations].map(([n, c]) => [(n / 48).toString(), c])),
  head,
  tags,
  preSkipMs: preSkip / 48,
  trimmedSamples: samples - Number(finalGranule),
  durationSeconds,
  bitrateKbps: durationSeconds > 0 ? (audioBytes * 8) / durationSeconds / 1000 : 0,
  containerOverheadPercent: bytes.length > 0 ? ((bytes.length - audioBytes) / bytes.length) * 100 : 0,
  valid: problems.length === 0,
  problems,
};

if (values.json) {
  console.log(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
} else {
  console.log(`${file}: ${report.valid ? 'valid Ogg Opus' : 'INVALID'}`);
  console.log(`  ${report.bytes} bytes, ${report.pages} pages (${report.audioPages} audio), ${report.packets} packets`);
  if (head) {
    console.log(`  OpusHead: v${head.version}, ${head.channels} ch, pre-skip ${head.preSkip} (${report.preSkipMs.toFixed(2)} ms), input ${head.inputSampleRate} Hz, gain ${head.outputGain}, mapping ${head.mappingFamily}`);
  }
  if (tags) console.log(`  OpusTags: ${tags.vendor}${tags.comments.length ? ' | ' + tags.comments.join(' | ') : ''}`);
  console.log(`  packets: ${Object.entries(report.packetDurationsMs).map(([ms, c]) => `${c} x ${ms} ms`).join(', ')}`);
  console.log(`  duration: ${durationSeconds.toFixed(4)} s (${report.trimmedSamples} samples trimmed at the end), ~${report.bitrateKbps.toFixed(0)} kb/s, container overhead ${report.containerOverheadPercent.toFixed(1)} %`);
  for (const p of problems) console.log(`  ! ${p}`);
}
process.exit(report.valid ? 0 : 1);

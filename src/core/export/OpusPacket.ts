/**
 * Opus packet helpers (RFC 6716 §3): the TOC byte tells how many samples a
 * packet carries, which the Ogg muxer needs for granule positions.
 */

/** Frame duration in 48 kHz samples for each of the 32 TOC configurations. */
const FRAME_SAMPLES: number[] = (() => {
  const ms = [
    10, 20, 40, 60, // 0-3   SILK NB
    10, 20, 40, 60, // 4-7   SILK MB
    10, 20, 40, 60, // 8-11  SILK WB
    10, 20, // 12-13 Hybrid SWB
    10, 20, // 14-15 Hybrid FB
    2.5, 5, 10, 20, // 16-19 CELT NB
    2.5, 5, 10, 20, // 20-23 CELT WB
    2.5, 5, 10, 20, // 24-27 CELT SWB
    2.5, 5, 10, 20, // 28-31 CELT FB
  ];
  return ms.map((m) => Math.round(m * 48));
})();

/** Number of 48 kHz samples an Opus packet decodes to (0 for an empty packet). */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  const code = toc & 0x03;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else {
    if (packet.length < 2) throw new Error('opusPacketSamples: truncated code-3 packet');
    frames = packet[1] & 0x3f;
  }
  return frames * FRAME_SAMPLES[config];
}

/**
 * Deterministic PRNG (mulberry32). Used wherever the audio path needs
 * "randomness" (noise buffers, physics jitter) so that a given seed always
 * produces the same output and rendered WAVs are reproducible.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  public next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  public range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform float in [-1, 1). */
  public bipolar(): number {
    return this.next() * 2 - 1;
  }
}

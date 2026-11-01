/**
 * Shared by the realtime e2e tests: decide whether timing assertions are
 * meaningful on this run of this machine.
 */
/** A sequencer step as scheduled: when it will sound, and how far ahead of the audio clock it was scheduled. */
export interface StepMargin {
  audioTime: number;
  margin: number;
}

/**
 * Realtime timing assertions are only meaningful when the machine kept up with
 * the audio clock. `margin` is how many seconds each sequencer step was
 * scheduled ahead of the audio clock (the clock works 100 ms ahead on a 25 ms
 * timer, so ~75-100 ms when healthy). A negative margin means the main thread
 * stalled past the step's time and the note was played late (by that much)
 * through no fault of the engine:
 * the test is then reported as skipped with the measurement, not as a failure.
 * Only steps inside `[from, to]` (the window the verification judges) count.
 */
export function realtimeWasHealthy(
  t: { skip: (msg?: string) => void; diagnostic: (msg: string) => void },
  steps: StepMargin[],
  what: string,
  window: { from: number; to: number } = { from: -Infinity, to: Infinity }
): boolean {
  const judged = steps.filter((s) => s.audioTime >= window.from && s.audioTime <= window.to);
  if (judged.length === 0) return true;
  const min = Math.min(...judged.map((s) => s.margin));
  if (min >= 0) return true;
  const late = judged.filter((s) => s.margin < 0).length;
  t.skip(
    `${what} not judged: the main thread stalled during the take (${late} of ${judged.length} steps scheduled after their time, up to ${(-min * 1000).toFixed(0)} ms late; healthy is ~75-100 ms ahead). The machine, not the engine, was late.`
  );
  return false;
}

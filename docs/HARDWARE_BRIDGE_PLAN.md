# Hardware Bridge & Sensory Modulator - implementation plan

Goal: two new modules on the modular canvas, patched with the existing cables:

- **MIDI BRIDGE** - a physical MIDI keyboard (Web MIDI) *or* the computer keyboard
  produces note-on/off, velocity, mod wheel and pitch bend.
- **SENSE (MIC)** - a microphone (getUserMedia) *or* a keyboard-driven "virtual voice"
  is pitch-tracked and level-tracked; the result is CV plus an onset trigger.

Both modules must follow the project's rule: **everything is verified numerically,
never by ear, and every input is replayable.** Hardware is therefore only one of
several *device adapters* behind one event stream; the computer keyboard is a
first-class device, not a fallback.

---

## 1. What the codebase already gives us

| Existing piece | How it is reused |
|---|---|
| `AudioEngine.playNote(cmd, when, source)` + `TRIGGER_SOURCES` map (`clk-trig-1` -> `sequencer`, `chm-trig-out` -> `chamber`) | Add `midi-gate-out` -> `'midi'` and `sns-onset-out` -> `'sensor'`. Cables from the new jacks gate instruments exactly like the clock and chamber. |
| `OscillatorVoice.triggerNote()` without a duration = held note, `releaseNote()` | Already implemented, **never called** today. Gives note-on/note-off for the synth immediately. |
| `NOTE_OFF` domain event | Declared, never published. |
| CV jacks (`mrm-cv-in` PITCH CV, `syn-filter-cv` CUTOFF CV, `del-time-cv` TIME CV, `clk-swing-1` SWING CV) | Accepted by `PatchRouter`, no effect yet ("Functional CV cables" is the first roadmap item). The sensor and the MIDI bridge are the CV *sources* that make them meaningful. |
| `TakeRecorder` inline-Blob AudioWorklet + sync marker | Same pattern for a pitch/onset tracker worklet (phase 3b); sync marker gives sample-exact onset times. |
| `RenderConfig` / `OfflineRenderer` / `ScoreEvent` / `verifyScore` | A MIDI performance becomes a `script` in the config -> offline bounce -> score -> verified with the tools that already exist. |
| `AudioAnalysis.ts` (FFT, band levels, onsets) | Pitch/onset detectors live next to it, pure TS, unit-tested in Node on synthetic signals. |
| `tests/e2e/ui.test.ts` stubs browser APIs with `page.addInitScript` (removes `AudioEncoder`, hides `audioWorklet`) | Same mechanism fakes `navigator.requestMIDIAccess` and `navigator.mediaDevices.getUserMedia`. |
| `createMediaStreamDestination()` (used by `MediaRecorderOpus.ts`) | Builds a fake microphone `MediaStream` from an oscillator, in-page, on any browser. |
| `window.tropicflowEngine` exposed for tests | Add `window.tropicflowInput` (send MIDI bytes, play a script, set the virtual voice). |

Constraints discovered:

- `requestMIDIAccess` and `getUserMedia` need a **secure context** (localhost / https), the same
  limitation REC already has. The keyboard-driven virtual devices work everywhere; the UI must say
  why hardware is unavailable (copy the `rec-status` / `unsupportedReason` pattern).
- `VirtualKeyboard` only listens to `keydown`, never `keyup`, ignores velocity, and does not check
  whether the event target is a text input. The refactor fixes all three.
- `OscillatorVoice.heldVoices` is keyed by frequency. Pitch bend / glide on a held note needs a
  key by note id (MIDI note number or key name). Small refactor.
- The canvas is `overflow-hidden`, 1500 px wide in the tests; the chamber card ends at x = 1280.
  Two more 288 px cards do not fit. Either narrow cards for the two new modules stacked at x = 1290
  or shift the layout; the e2e tests click jacks by bounding box, so the jacks must be on-screen at
  1500 x 950.

---

## 2. Architecture

```
src/core/input/
  InputEvents.ts       event types, device ids, note/Hz helpers (pure)          [phase 0]
  InputBus.ts          fan-out of timed events to the engine + UI                [phase 0]
  TimestampMapper.ts   DOM timeStamp -> audio-context time, constant latency     [phase 0]
  midi/MidiParser.ts   bytes -> events (running status, channel filter), encoder [phase 0]
  midi/WebMidiDevice.ts  navigator.requestMIDIAccess adapter, hot-plug, device list
  keyboard/KeyMap.ts   pure reducer: key down/up -> note/octave/velocity/mod/bend [phase 0]
  keyboard/KeyboardDevice.ts  window keydown/keyup -> KeyMap -> InputBus
  InputLog.ts          InputLog (record), InputScript (+ validation), ScriptPlayer [phase 0]
src/core/cv/
  CvBus.ts             control-rate value streams: source jack -> target jack via cables
  CvTargets.ts         what each cv-in does (setTargetAtTime on the right AudioParam)
src/core/sense/
  PitchDetector.ts     YIN/MPM on a Float32Array frame (pure)
  LevelOnset.ts        RMS envelope + onset detection on a stream (pure, stateful)
  SensorEngine.ts      AudioNode in -> Analyser/worklet -> detectors -> events + CV
  VirtualVoice.ts      keyboard-driven oscillator that stands in for the mic
```

### 2.1 Event model

```ts
type InputEvent =
  | { kind: 'noteOn';  note: number; velocity: number; time: number; device: DeviceId }
  | { kind: 'noteOff'; note: number; time: number; device: DeviceId }
  | { kind: 'control'; control: 'mod' | 'bend' | 'aftertouch' | number; value: number; time: number; device: DeviceId }
  | { kind: 'pitch';   hz: number; clarity: number; time: number; device: DeviceId }
  | { kind: 'level';   rms: number; time: number; device: DeviceId }
  | { kind: 'onset';   strength: number; time: number; device: DeviceId };
```

`time` is always **audio-context seconds** (the only clock the engine understands). Adapters are
responsible for the conversion:

- Web MIDI: `MIDIMessageEvent.timeStamp` is `performance.now()`-domain; use
  `ctx.getOutputTimestamp()` to map it: `contextTime + (ts - performanceTime) / 1000`. Schedule at
  `max(that, ctx.currentTime)`; the voices already clamp with `Math.max(when, ctx.currentTime)`.
- Computer keyboard: `event.timeStamp` likewise; no hardware latency to compensate.
- Sensor: frame time from the analyser poll (phase 3a) or the worklet block + sync marker (3b).

### 2.2 MIDI BRIDGE module (`type: 'midi'`)

Outputs: `GATE OUT` (trigger-out), `PITCH CV`, `VEL CV`, `MOD CV`, `BEND CV` (cv-out).
UI: device selector (lists `MIDIAccess.inputs`, plus "COMPUTER KEYS"), MIDI channel, octave shift,
activity LED, last note/velocity, status text ("NO WEB MIDI - open via localhost/https",
"NO DEVICES", "VIRTUAL: COMPUTER KEYS").

Gate semantics per target (decided by cables from `GATE OUT`, as today):

| Target | note-on | note-off |
|---|---|---|
| `syn-gate-in` | `synth.triggerNote(hz, vel)` **held** | `synth.releaseNote(id)` |
| `mrm-trig-in` | `marimba.strike(hz, vel)` | ignored (one-shot) |
| `perc-trig-in` | GM drum map: 35/36 kick, 38/40 snare, 42/44 closed hat, 46 open hat; others ignored | ignored |

Computer keyboard as a MIDI device (the "operated via the computer keyboard" requirement):
existing `A`-`K` + `W E T Y U O L ;` layout kept; `keyup` = note-off; `Z`/`X` octave; `C`/`V`
velocity step; `ArrowUp/Down` mod wheel; `ArrowLeft/Right` pitch bend (spring back on release);
`Shift` = accent. Ignored when the event target is an input/select/textarea or a modal is open.

### 2.3 Functional CV (roadmap item, needed by both modules)

CV is **control-rate** (main-thread values with times), not audio-rate signals. `CvBus` resolves
`resolvePatch(...).cv` links; each source publishes `(value in 0..1 or semitones, time)`, each
target applies it:

| cv-in | Effect |
|---|---|
| `syn-filter-cv` | cutoff = base * 2^(value*4) via `setTargetAtTime` (mod wheel / mic level) |
| `mrm-cv-in` | transposes subsequent marimba strikes (semitones) or, from the sensor, retunes to the tracked pitch |
| `del-time-cv` | delay time scaled (bend / level) |
| synth pitch (new `syn-pitch-cv`) | glides *held* synth notes: `bendHeld(id, hz, when, glideSeconds)` |

`clk-swing-1` (SWING CV out) becomes a real source as a side-effect.

### 2.4 SENSE (MIC) module (`type: 'sensor'`)

Outputs: `PITCH CV`, `LEVEL CV` (cv-out), `ONSET TRIG` (trigger-out -> clap into the mic, the kick fires).
UI: source selector ("MICROPHONE" / "VIRTUAL VOICE (KEYS)"), input gain, clarity threshold,
hold/glide, tuner readout (Hz, nearest note, cents), level meter, status/permission text.

Signal path: `MediaStreamAudioSourceNode | VirtualVoice.outputNode` -> `GainNode` ->
(3a) `AnalyserNode.getFloatTimeDomainData` polled every ~10 ms, 2048-frame window;
(3b, optional) inline-Blob `AudioWorkletProcessor` with the detector embedded, 128-frame hop,
sync marker for exact onset times (copy of the `TakeRecorder` technique).

Detectors (pure TS, `src/core/sense/`):
- `PitchDetector`: YIN (difference function + CMNDF + parabolic interpolation) or MPM; returns
  `{ hz, clarity }`; clarity gate rejects noise/silence; median-of-3 smoothing and octave-jump
  suppression in `SensorEngine`.
- `LevelOnset`: RMS envelope (fast attack / slow release) and onset = envelope rises by > X dB
  within Y ms, refractory period. Can share code with `detectOnsets()` in `AudioAnalysis.ts`.

`VirtualVoice`: an oscillator (triangle + slight vibrato + breath noise) whose pitch follows the
computer keys with a configurable glide, plus a "clap" key that emits a 20 ms noise burst. It feeds
the **same** tracker path as the microphone, so every test and manual check of the tracker runs
without a mic.

### 2.5 Replay and determinism

- `InputLog` records every event with its audio-context time while the transport runs; the take
  carries it (`Take.inputLog`) and the bounce score file includes it.
- `RenderConfig.inputScript?: InputEvent[]` (times relative to the render start). `OfflineRenderer`
  feeds it to the same `InputBus` before `startRendering()`, so MIDI notes / CC / sensor values are
  applied at exact times and appear in the score (`source: 'midi' | 'sensor'`).
- Sensor in offline renders: either a pre-computed `pitch`/`level`/`onset` event list, or an audio
  file analysed by the pure detectors ahead of time (deterministic, runs in Node).
- CLI: `npm run render:wav -- --input performance.json` and `compare:wav` works unchanged.

---

## 3. Phases

| Phase | Deliverable | Tests |
|---|---|---|
| 0 **done** | `src/core/input`: `InputEvents` (model + note/Hz helpers), `InputBus`, `MidiParser` (+ encoder), `TimestampMapper`, `keyboard/KeyMap` (pure reducer), `InputLog` / `InputScript` / `parseInputScript` / `ScriptPlayer`; `NoteSource` gains `'midi' \| 'sensor'`; `ScoreEvent.source` widened | 33 unit tests: parser (all status bytes, running status, sysex/system skipped, channel filter, 14-bit bend, encode round-trip), timestamp mapping incl. the `{0,0}` sample and constant-latency scheduling, key reducer (octave/velocity/accent/mod/bend/releaseAll), log/script validation and horizon-driven replay equal to an offline pass |
| 1 **done** | `InputBinding` (engine: note-on -> marimba / synth held / GM drums, gated by `midi-gate-out` cables; `releaseHeld`; `InputLog` armed with the transport), `InputHub` (`window.tropicflowInput`: timestamp polling, `send()`, `playScript`/`replayLog`, effective latency), `KeyboardDevice`, `WebMidiDevice` (status model: unsupported / insecure / idle / requesting / ready / denied / error, hot-plug, input + channel filter), MIDI BRIDGE card (KEYS / MIDI toggles, input + channel selects, TRANSPOSE, activity, LOG / REPLAY / CLEAR), soundboard rebuilt on `KEY_LAYOUT` with cable-toggling instrument chips, **min/max cards** + MIN ALL / MAX ALL, `RenderConfig.inputScript` + `bridge` replayed by `OfflineRenderer`, `captureRenderConfig` carries the log (BOUNCE = what you played), `midi-performance` preset, `render:wav --input/--transpose` | unit: `KeyboardDevice` (enable/disable, preventDefault, shortcuts, blur panic), `WebMidiDevice` (fake access: listing, routing, hot-plug, select, channel, every error status); render e2e: 3 tests (section 4); UI e2e `tests/e2e/input.test.ts`: 12 tests (section 4) |
| 2 **done** | `src/core/cv/CvBus` (sources `midi-pitch-cv` semitones, `midi-mod-cv`, `clk-swing-1`, sensor jacks reserved; targets `syn-filter-cv` octaves, new `syn-pitch-cv` + `mrm-cv-in` semitones, `del-time-cv` octaves; kind-aware scaling, sums, re-patch recompute), engine applies targets with `setTargetAtTime` at the event time and transposes note frequencies at note time (score stays truthful), `OscillatorVoice.setCutoffModulation` / `setPitchOffset` (held voices glide relative to their start offset), `DelayEffect.setTimeModulation`, `AudioClock.subscribeSwing`, BEND range knob + MOD/BEND readouts, default cables mod→cutoff and bend→synth pitch, `midi-cv` preset | unit `CvBus.test.ts`; render e2e `cv:` test; UI e2e `cv:` test (section 4) |
| 3a **done** | `src/core/sense`: `PitchDetector` (YIN + parabolic interpolation, -45 dBFS floor), `LevelOnset` (envelope with one-block-delayed baseline, peak-based strength, 120 dB/s release, refractory), `SensorAnalysis` (`SensorTracker` change-gated events, `analyseBuffer` for files), `SensorEngine` (mic via `getUserMedia` with a status model like MIDI's, virtual voice, 32768-sample analyser polled every 16 ms, UI notifications throttled), `VirtualVoice` (sawtooth + vibrato + breath, glide, 40 ms clap); `InputBinding` handles pitch -> `sns-pitch-cv` (semitones from ROOT), level -> `sns-level-cv`, onset -> notes at the root through `sns-onset-out` (drum selectable); keys tap (`Space`) -> virtual clap; bridge KEYS toggle now *mutes* the keys at the bridge so the voice can still use them; SENSE card (MIC / VOICE, tuner, cents, level, GAIN, CLARITY, ROOT, ONSET drum); `sensor-follow` preset; `render:wav --sense file.wav`; offline renderer applies events / chamber notes / steps in time order | unit `PitchDetector.test.ts` (7 tests); render e2e `sensor:`; UI e2e `tests/e2e/sense.test.ts` (8 tests) |
| 3b | Worklet tracker with sync marker (only if 3a latency/jitter is not good enough for `ONSET TRIG`) | e2e: onset timing error < 5 ms against the take |
| 4 | User guide section + screenshots (`scripts/screenshots.mjs`), README, `npm run check` reports Web MIDI / mic / secure-context capability | `UserGuide.test.ts` already validates images/anchors |

---

## 4. Simulating the hardware

### 4.1 End-to-end (headless Chromium, `tests/e2e/ui.test.ts` style)

**Computer keyboard** - nothing to fake: `page.keyboard.down('a')` / `up('a')` produce real
keydown/keyup with real timestamps. Verify: synth note is held while the key is down
(`engine.synth` held-voice count), released on keyup, and the on-screen key `data-active` toggles.

**Web MIDI** - `context.grantPermissions(['midi'])` makes the *real* API resolve in Chromium, but
the container has no devices: use that page for the "NO DEVICES" status test. For everything
else install a fake in `page.addInitScript`:

```ts
await page.addInitScript(() => {
  class FakeInput extends EventTarget {
    id = 'fake-1'; name = 'Fake Keys'; manufacturer = 'test'; state = 'connected'; type = 'input';
    onmidimessage: ((e: MIDIMessageEvent) => void) | null = null;
    send(bytes: number[], ts = performance.now()) {
      const e = new MIDIMessageEvent('midimessage', { data: new Uint8Array(bytes) });
      Object.defineProperty(e, 'timeStamp', { value: ts });     // own property shadows the getter
      this.onmidimessage?.(e); this.dispatchEvent(e);
    }
  }
  const input = new FakeInput();
  const access = { inputs: new Map([[input.id, input]]), outputs: new Map(), onstatechange: null, sysexEnabled: false };
  (navigator as any).requestMIDIAccess = async () => access;
  (window as any).__fakeMidi = { input, access };
});
```

Tests then call `page.evaluate(() => __fakeMidi.input.send([0x90, 60, 100]))`, hot-plug by
replacing the map and firing `onstatechange`, and reject the promise to cover the permission-denied
path. Because the app also exposes `window.tropicflowInput.send(bytes, ts?)`, most tests can skip
the fake and inject at the adapter boundary; keep at least one test on the fake `MIDIAccess` so the
Web MIDI adapter code (device listing, `onmidimessage`, `statechange`) is exercised.

**Timing / latency assertions** (the project's signature check): arm REC, start the groove, send
fake note-ons with known `timeStamp`s, stop, then `verifyScore` the take against the notes the
engine scheduled (mean error < 1 ms, like the existing recording test) and assert
`scheduledTime - midiTime` is small and stable (e.g. < 30 ms, jitter < 5 ms).

**Live vs offline of the same performance**: the take's `inputLog` -> `RenderConfig.inputScript`
-> `renderOffline` -> `compareBuffers` against the take: correlation > 0.99, lag < 2 ms. This is
the strongest single proof that the bridge is deterministic and replayable.

**Microphone, three levels:**

1. *In-page stub (portable, per-test control)*: `addInitScript` replaces
   `navigator.mediaDevices.getUserMedia` with a function that builds a stream from an oscillator:
   ```ts
   const ctx = new AudioContext(); const osc = new OscillatorNode(ctx, { frequency: 220 });
   const dest = ctx.createMediaStreamDestination(); osc.connect(dest); osc.start();
   (window as any).__fakeMic = { osc, ctx };
   navigator.mediaDevices.getUserMedia = async () => dest.stream;
   ```
   Tests change `__fakeMic.osc.frequency.value` and assert the module's tuner readout and the
   `pitch` events follow within ±1 %. Also covers the denied-permission path (throw `NotAllowedError`).
2. *Chromium's real capture path*: launch with
   `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<file.wav>%noloop`
   and `context.grantPermissions(['microphone'])` (or `--use-fake-ui-for-media-stream`).
   The WAV is synthesised in the test with `encodeWav(..., 16)` (16-bit PCM mono 48 kHz): a
   sequence of tones at known pitches and a few noise bursts at known times. Assert the tracked
   pitch sequence and that each burst produces an `ONSET TRIG` kick in the take within a few ms
   of the burst time plus the measured input latency. This runs the real `getUserMedia` ->
   `MediaStreamAudioSourceNode` chain. (The existing `launchChromium` merges extra `args`; the
   flags apply per browser launch, so this test opens its own browser like the insecure-context
   test opens its own context.)
3. *Virtual voice via keys*: `page.keyboard.down('h')` (A3 = 220 Hz) with the SENSE source set to
   VIRTUAL VOICE -> the tracker reports ~220 Hz; the "clap" key fires an onset. Same assertions as
   (1), through the product's own simulator.

**Render e2e (`tests/e2e/render.test.ts` style)**: presets `midi-performance` (script of notes,
velocities, a CC1 sweep, a bend) and `sensor-follow` (pitch event list driving `syn-pitch-cv` and
`mrm-cv-in`). Assert the score matches the script, every note verifies on its solo stem
(sample-accurate, same tolerances as today), the CC sweep raises the synth's high-band level, and
two renders are equivalent (SNR >= 90 dB). Add goldens after the sound is stable.

**Unit (Node, ms)**: `MidiParser`, `MidiClock`, `KeyMap`, `InputLog`, CV scaling, `PitchDetector`
(sine 80-1000 Hz within 0.5 %, sawtooth no octave error, vibrato tracked, white noise -> clarity
below threshold, silence -> no pitch), `LevelOnset` (bursts at known times, refractory), script
replay ordering.

### 4.2 Manual testing without hardware

- **Built-in simulators** (ship with the app): COMPUTER KEYS device on the MIDI BRIDGE and
  VIRTUAL VOICE on SENSE. Everything a hardware user can do is reachable from the keyboard.
- **DevTools console**: `tropicflowInput.send([0x90, 60, 100])`, `tropicflowInput.play(script)`,
  `tropicflowInput.virtualVoice({ hz: 220, level: 0.5 })`, `tropicflowInput.log()` to dump the
  current input log as JSON (drop it on the bounce dialog / CLI to replay).
- **Real Web MIDI path without a keyboard**: an OS virtual MIDI port - macOS IAC Driver
  (Audio MIDI Setup), Linux `modprobe snd-virmidi` + `aplaymidi -p <port> file.mid`, Windows
  loopMIDI - then any MIDI sender (`sendmidi`, a DAW, a phone MIDI app over the port).
- **Real mic path without speaking**: start Chrome by hand with the two fake-device flags above
  pointing at a WAV rendered by `npm run render:wav`; or a virtual audio device (PipeWire/Pulse
  `module-pipe-source`, macOS BlackHole) with a media player as source.
- **With hardware**: `npm run dev` on `localhost` is a secure context; from another machine on the
  LAN the page must be served over https for MIDI/mic (document this next to the REC note).

---

## 5. Decisions taken

1. **Canvas layout**: clicking a module header minimises it to a single ~28 px row (title, LED,
   jacks inline and still patchable); dragging the header moves it; the cursor stays an arrow.
   `MIN ALL` / `MAX ALL`, and `STACK` minimises everything and lays the cards out as stairs sized
   to the visible canvas (`src/core/graph/StairsLayout.ts`: rows per column from the height,
   balanced columns, each stair spanning its column's full width).
2. Analyser polling (3a) first; worklet (3b) only if onset jitter > ~10 ms.
3. Sensor PITCH CV **transposes** (marimba strikes and sequencer notes follow the tracked pitch);
   held-note glide stays a later refinement.
4. Computer keys may drive MIDI BRIDGE and VIRTUAL VOICE simultaneously: **per-module toggles**.

## 6c. Flaky-test treatment (phase 4)

The two pre-existing recording tests failed on this VM under load (A/B against a stash of the
original code: the original fails the same way, 2 of 4 runs), and could not be reproduced on a
desktop. Causes: (1) `the MAX slider...` assumed Playwright's click-to-click time was well under a
second - the assertion is now relative to the measured time REC was ticked; (2) `REC + START...`
asserts timing accuracy, which is meaningless when the main thread stalled - the test now records
the scheduling margin of every step and, if a step inside the judged window was scheduled late,
reports `skipped` with the measurement. Same treatment for the injected-performance test. The
probe had to judge the same window as the verification: the very first step after START is
routinely late (the recorder and React start at that moment) and is excluded by both.

## 6b. Findings while building phase 3

- **The offline renderer applied the script after all sequencer steps**, so CV never reached
  sequencer notes offline. It now walks time in order (events and queued chamber notes merged
  before each step). Chunking the physics per step instead shifted collision times by ~1e-9 s,
  which the chaotic multi-ball golden amplified to correlation 0.89 - hence the single physics
  pass with deferred notes, and the clock's bar-drop hook pre-driven from the probe clock.
- **Short clicks are lost to main-thread stalls**: with a 2048-sample analyser (46 ms) a 5 ms
  click was caught or missed by luck; stalls of ~200 ms were measured under test load. The
  analyser now keeps 32768 samples and the level detector consumes everything since the last
  poll; the virtual clap decays over 40 ms.
- `selectOption` leaves focus on the `<select>`, which the keyboard device rightly treats as a
  typing target; tests click the canvas before pressing Space.
- Chromium's fake capture device delivers with up to ~100 ms of jitter under load here; the
  live e2e checks the clap pattern coarsely and the deterministic offline analysis exactly.
- `getUserMedia` in this container: `NotFoundError` (no device) - the status model shows it.

## 6a. Findings while building phase 2

- **`cancelAndHoldAtTime()` scheduled ahead of time does not hold in Chromium** (measured with a
  ConstantSource: value 0.04 where 0.1 should have been held). Held synth notes therefore decayed
  through their whole hold in offline renders, and the sequencer's fixed-length synth notes had
  been releasing from the attack peak all along. Fixed by computing the envelope analytically
  (`envelopeValueAt`) and re-scheduling the partial ramp; goldens regenerated (correlation 1.000).
- The stem verifier's 4 ms onset baseline is shorter than one period of a sustained 130 Hz
  sawtooth; `StemVerifyOptions.stepOnset.baselineMs` now lets a test average over a period.
- A 12 dB/oct biquad opened from 1.8 kHz to 14.4 kHz lifts the 3-6 kHz band of a sawtooth by
  ~11 dB (not the ~16 dB of a naive estimate): thresholds were set from measurement.
- The wall-clock-spacing check of the live e2e was demoted to a diagnostic: the headless sink's
  output timestamp steps 10-20 ms even on intervals where `currentTime` drift looks clean.

## 6. Findings while building phase 1

- **Latency policy works as designed**: 8 injected events, `scheduled - mapped` = 47.0 ms on every
  one, none clamped to "now". Takes verify against the schedule at 0.3-0.8 ms mean error.
- **`getOutputTimestamp()` is steady when idle** (offset ±0.1 ms, refreshed every 10 ms) but under
  load a stale pair sneaks in now and then; the mapper keeps the largest offset of a 250 ms window.
- **The headless fake audio sink underruns under load**: the audio clock steps ~10 ms against the
  wall clock every few hundred ms (measured both through `getOutputTimestamp()` and
  `currentTime - performance.now()`). Wall-clock spacing of a performance cannot be preserved
  across a stall by any mapping; the e2e judges spacing only over stall-free intervals (0.0-0.1 ms
  there). On real hardware stalls are rare, so the check is tight.
- In-mix (`master`) verification of a live take is approximate when performed notes share a voice
  and pitch with the sequencer; the e2e records a performance over an empty pattern, dry, and
  demands zero failures, while the render e2e proves coexistence with the groove per stem.
- **Polling `getOutputTimestamp()` at 40 Hz degraded the engine's own scheduling** (the existing
  recording e2e went from 0.8 ms mean / 3.3 ms max to 1.2 / 6.5 ms and started dropping steps;
  A/B-tested against a stash of the original). The call touches the audio thread's position. The hub
  now samples at 10 Hz in the background plus once per event to stamp; baseline timing is restored.
- Node's type stripping rejects constructor parameter properties even in test fakes.

## 7. Spike results (headless Chromium 141, this container)

- `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream
  --use-file-for-fake-audio-capture=<wav>%noloop` + `grantPermissions(['microphone'])`: works.
  A 16-bit PCM 48 kHz WAV from `encodeWav` came through `getUserMedia` ->
  `createMediaStreamSource` -> `AnalyserNode` with the expected pitches and the noise burst at
  the expected time (device runs at 44.1 kHz; Chromium resamples the file).
- `AudioContext.getOutputTimestamp()` works but returns `{0, 0}` until the context has rendered;
  the timestamp mapper treats `performanceTime === 0` as "no sample yet".
- `new MIDIMessageEvent('midimessage', { data })` works and `Object.defineProperty(e, 'timeStamp',
  { value })` overrides the read-only timestamp: the fake `MIDIInput` design is valid.
- **Real Web MIDI cannot run here**: `grantPermissions(['midi', 'midi-sysex'])` is accepted, but
  `requestMIDIAccess()` rejects with `InvalidStateError: Platform dependent initialization failed`
  (no ALSA sequencer in the container). Consequences: the fake `requestMIDIAccess` is the only
  e2e path for device handling; the UI must treat `InvalidStateError`, `NotAllowedError`,
  `SecurityError` and a missing API as distinct status messages; the "real API" e2e test asserts
  only that the module reports a sensible status and does not crash.

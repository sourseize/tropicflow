# TROPICFLOW

A local-first spatial sound synthesis and modular computing workstation built with TypeScript targeting Node 22+. Operates 100% offline in modern browsers with zero external network requests or cloud services.

## Features

> **User guide with screenshots: [docs/USER_GUIDE.html](docs/USER_GUIDE.html)** (also served at `/docs/USER_GUIDE.html` by `npm start` and `npm run dev`; the GUIDE button in the header opens it).

- **Eurorack Modular Canvas**: Draggable hardware synthesizer modules with sagging patch cables. Cables are functional: audio cables route signal, trigger cables decide which modules the clock fires. Drag from a jack to another jack to connect, double-click a jack to unplug it.
- **Web Audio DSP Architecture**: Dedicated single-purpose audio voices including FM Marimba acoustic modeling, analog Percussion engine (Kick, Snare, Hi-Hat), dual-oscillator resonant synth lead/bass, and tape delay with damped feedback.
- **Sample-Accurate Lookahead Clock**: Every note is scheduled on the Web Audio timeline at its exact step time (no timer jitter), with micro-timing swing.
- **16-Step Polyrhythmic Groove Matrix**: Playhead synchronised to the moment each step actually sounds, with per-step auditioning.
- **MIDI Bridge / Live Keys**: a `MIDI BRIDGE` module on the canvas turns a physical MIDI keyboard (Web MIDI) *or* the computer keyboard into a trigger source: patch its `GATE OUT` to the marimba, the synth (held notes with note-off) and/or the drums (GM keys 36/38/42/46). Computer keys: `A`-`'` chromatic from C3, `Z`/`X` octave, `C`/`V` velocity, `Shift` accent, arrows = mod wheel / pitch bend; the on-screen soundboard lights for notes from any device. Every note is scheduled from its DOM timestamp with a **constant latency** (no main-thread jitter), logged relative to the groove start, replayable (`REPLAY`) and rendered by `BOUNCE`. Console / tests: `tropicflowInput.send([0x90, 60, 100])`. Plan and status: [docs/HARDWARE_BRIDGE_PLAN.md](docs/HARDWARE_BRIDGE_PLAN.md).
- **SENSE module (sensory modulator)**: a microphone (`getUserMedia`) *or* a keyboard-driven **virtual voice** (the keys sing, `Space` claps - no mic needed) is tracked in realtime: a YIN pitch detector and a level/onset detector (pure TypeScript, unit-tested on synthetic signals) feed three jacks - `PITCH CV` (semitones from a ROOT note: sing D4 over a C4 root and everything patched follows +2 st), `LEVEL CV` and `ONSET TRIG` (a clap fires the chosen drum, or a note, per the cables). Tuner, cents bar and level meter on the card. Sensor events go through the same input bus as MIDI, so they are logged, replayed, bounced, and a recording can be analysed offline (`render:wav --sense voice.wav`).
- **Functional CV cables**: the MIDI BRIDGE's `MOD CV` (mod wheel) and `PITCH CV` (pitch bend × BEND range) and the clock's `SWING CV` are real control voltages. Patch them into the synth's `CUTOFF CV` (up to +3 octaves), the synth's `PITCH CV` (bends held notes live, transposes new ones), the marimba's `PITCH CV` (transposes strikes) or the delay's `TIME CV`. Several sources into one jack add up; the default patch wires mod → cutoff and bend → synth pitch.
- **Min / max / stack cards**: click a module header to minimise it to a single row (jacks stay patchable), drag to move; `MIN ALL` / `MAX ALL`, and `STACK` arranges every minimised card as stairs sized to the visible canvas (more columns when the height runs out).
- **Dual Real-Time Visualizer**: Phosphor CRT Oscilloscope and 64-band FFT Spectrum Analyzer.
- **Gravity Chamber / Collision Beat Drop**: a deterministic 2-D physics box patched into the modular canvas. Balls fall under gravity and every collision triggers a note through a configurable **Collision Mapper** (surface → instrument, scale, root, velocity curve). Drop balls by hand (now or on the next bar), automatically every Nth bar, or by clicking in the chamber; draw pegs and ramps with the mouse and set their notes with the wheel. Tempo-independent physics with an optional QUANTIZE knob that snaps hits toward the 16th grid; export/import chambers as JSON. **User guide: [docs/USER_GUIDE.html → Gravity chamber](docs/USER_GUIDE.html#chamber).**
- **Live Take Recording**: tick **REC** next to START GROOVE and everything you hear while the groove runs (sequencer, chamber hits, keyboard, knob tweaks) is captured sample-accurately through an AudioWorklet tap on the master bus. The **MAX** slider (1-10 min, default 1) stops a take by itself. **User guide: [Recording & export](#recording--export).**
- **Export dialog**: WAV (16 / 24 / 32-bit float, lossless) or **OGG (Opus)** at 64-256 kb/s, with start / duration sliders, size estimate and an encode progress bar. Opus is encoded by the browser's WebCodecs `AudioEncoder` (or, where that is missing, by `MediaRecorder` in realtime) and muxed into Ogg by a pure-TypeScript muxer: no extra dependencies, still 100 % offline.
- **Deterministic Offline Bounce**: `BOUNCE` renders the current patch (sequencer *and* chamber, from its current ball state) faster than realtime, opens the same export dialog, and keeps a JSON *score* of every scheduled note so the file can be verified by software (see [Testing](#testing-without-listening)).

## Tech Stack & Architecture

- **Runtime**: Node >= 22.18 (runs the TypeScript tests natively - no transpiler)
- **Language**: TypeScript 5.7+ (strict mode, `verbatimModuleSyntax`)
- **UI & Styling**: React 19, Tailwind CSS, Lucide Icons
- **Audio & Visuals**: Web Audio API, HTML5 Canvas 2D
- **Build**: Vite (also bundles the test harness - no second bundler)
- **Testing**: Node's built-in test runner, Playwright + headless Chromium for real Web Audio rendering
- **Patterns**: Hexagonal Architecture, Event-Driven Pub/Sub, Single Responsibility Principle

```
src/core/audio      voices, clock, engine, patch application   (no DOM, context injected)
src/core/graph      module/port model + pure patch resolution  (PatchRouter), STACK stairs layout
src/core/cv         CvBus: cv-out -> cv-in routing through cables, kind-aware scaling (pure)
src/core/sense      PitchDetector (YIN), LevelOnset, SensorAnalysis (events, whole-buffer analysis) - pure;
                    SensorEngine (mic / virtual voice -> AnalyserNode polling -> input bus), VirtualVoice
src/core/physics    PhysicsChamber (simulation), CollisionMapper (hit -> note), ChamberEngine (scheduling)
src/core/render     OfflineRenderer, RenderConfig, WAV codec, presets
src/core/record     TakeRecorder: AudioWorklet tap on the master output (live takes)
src/core/export     Ogg/Opus muxer (pure), WebCodecs Opus encoder, range/fade/file-name helpers
src/core/input      hardware bridge: InputEvent model, MIDI parser, computer-keyboard reducer, timestamp
                    mapper, log/script replay (pure); InputBinding (events -> notes, gated by cables),
                    KeyboardDevice / WebMidiDevice adapters, InputHub (realtime wiring, window.tropicflowInput)
src/core/analysis   onset/band/buffer analysis used by tests and CLI
src/harness         browser entry for headless rendering
scripts/            render-wav, compare-wav CLIs
tests/unit          pure Node tests (ms)
tests/e2e           Chromium render tests + UI tests (seconds)
tests/golden        reference WAV + score
```

### Determinism

The engine is designed so that **the same input always produces the same audio**:

- Voices receive an explicit `BaseAudioContext` and a `when` time; the sequencer passes the clock's scheduled step time, so notes land sample-accurately regardless of timer jitter.
- No `setTimeout` in the audio path (envelopes and note-offs are pre-scheduled; cleanup uses `ended` events).
- Noise is generated from a seeded PRNG (`SeededRandom`), not `Math.random()`.
- The same `AudioEngine` runs on an `OfflineAudioContext` for rendering.

Two renders of the same config are equivalent to within floating-point summation noise (typically > 110 dB SNR). They are not always *bit*-identical: Chromium sums multiple connections into one node in pointer-hash order, so the last bits of a mixed signal can differ between runs. Single-voice renders are bit-exact.

### Gravity chamber internals

- `PhysicsChamber` integrates with a fixed 1 ms sub-step, but collision *times* are solved analytically inside the sub-step (quadratic for walls, sampled bisection for pegs/segments/balls), so a hit is timed to ~1e-9 s and does not depend on the sub-step. Free fall from height *d* hits the floor at exactly `sqrt(2d/g)`; bounce intervals follow the restitution series (`tests/unit/PhysicsChamber.test.ts`).
- Resting contact, friction, sleep and a per-contact refractory stop a settling ball from machine-gunning the kick; balls are removed once asleep (configurable).
- `ChamberEngine` queues drops at exact times (e.g. bar boundaries), maps collisions to notes (`CollisionMapper`, pure), optionally quantizes against the clock's *actual* step grid, and keeps snapshots so the UI draws the chamber at the audible time rather than the simulated (future) time.
- Which instruments the chamber may play is decided by cables from its `HIT TRIG` jack, exactly like the clock's `TRIG OUT`.
- The same simulation runs in Node and in the browser; `tests/e2e/render.test.ts` asserts the browser's collision times equal an independent Node simulation of the same config.

### Recording & export

**Recording** happens while the transport runs *and* the REC box is ticked: tick REC then START GROOVE (or tick it mid-groove to start right away); STOP ENGINE, unticking REC, or reaching the MAX length finalises the take. Notes played on the keyboard while the engine is stopped are not recorded. A new take replaces the previous one; the header shows the take length next to an **EXPORT** button.

What is captured is exactly what reaches the speakers: post-compressor, post-MASTER volume, stereo at the context's sample rate, as 32-bit floats in memory (about 23 MB per minute at 48 kHz, hence the 10-minute ceiling).

**Export** (from a take or from BOUNCE):

| Parameter | Values |
|---|---|
| Format | `WAV` lossless (16 / 24-bit PCM or 32-bit float) or `OGG` (Opus, VBR) |
| Start / Duration | sliders in 0.1 s steps (same controls as TEMPO / MASTER); clamped to the source, an end within 50 ms of the source end means "to the end" |
| Bitrate (OGG) | 64, 96, 128 (default), 160, 192, 256 kb/s |
| Edges | 5 ms linear fade-in/out at the cut points, so slices never click |

File names encode the settings, e.g. `tropicflow-take-120bpm-20250101-1432-2.5s-8s-96k.ogg` or `tropicflow-120bpm-2bars.wav` (a full-range 32-bit float bounce keeps the plain name, as before).

Implementation notes:

- `TakeRecorder` loads its `AudioWorkletProcessor` from an inline Blob URL (no bundler configuration). The worklet batches 4096-frame blocks to the main thread; the recorder assembles the take on stop and enforces the length limit.
- Each take carries `startContextTime`: a `ConstantSourceNode` scheduled at a known context time feeds the worklet's *second* input, and the frame where it rises pins the take to the Web Audio timeline sample-exactly (the worklet's own `currentFrame` turned out not to share the context's origin in Chromium). A note scheduled at `t` is therefore at `t - startContextTime + busLatency` in the take, which `tests/e2e/ui.test.ts` verifies with `verifyScore` (mean error < 1 ms).
- Opus needs 48 kHz, so the slice is resampled with an `OfflineAudioContext` first; the encoder's reported pre-skip (312 samples) goes into `OpusHead`, and the last Ogg page's granule position is `preSkip + length` so decoders trim the padded final frame: `ffmpeg` decodes exactly the requested duration. The muxer and its reader are pure TypeScript (`src/core/export/OggOpus.ts`) and unit-tested in Node (CRC against a bitwise reference, lacing, granules, EOS).
- **Without WebCodecs** (Firefox < 130, Safari, or the app opened over plain `http://<ip>` where browsers hide WebCodecs) the OGG option still works through `MediaRecorder`, in realtime. MediaRecorder's start/stop are not sample-accurate (Chromium loses ~100 ms around a clip), so the slice is played inside a programme `[lead silence][sync burst][gap][slice][tail]`; the recording is decoded to locate the burst, then Ogg's pre-skip hides the lead-in and the granule position trims the tail. Chromium writes WebM, which a minimal EBML reader (`WebmOpus.ts`) unpacks; Firefox writes Ogg directly. Measured against the raw take: correlation > 0.99, lag < 0.1 ms (`tests/e2e/ui.test.ts`).
- **Recording requires AudioWorklet**, i.e. a secure context (`http://localhost` or `https://`). Over `http://<ip>` the REC box is disabled and says so. There is deliberately no `ScriptProcessorNode` fallback: measured in Chromium, it drops or repeats whole 128-frame render quanta when the main thread is busy, so its takes would be quietly wrong.

### Known signal-path facts (measured)

- The master bus `DynamicsCompressorNode` adds a **6 ms lookahead latency** (Blink/Gecko/WebKit). A note scheduled at `t` becomes audible at `t + 6 ms`. The offline renderer measures this (`busLatency`) and records both `time` and `audibleTime` in the score. Live takes contain the same 6 ms offset.
- `AudioWorkletGlobalScope.currentFrame` in Chromium starts counting when the worklet thread begins rendering, not at context creation; do not use it to align captured audio with `AudioContext.currentTime` (see [Recording & export](#recording--export) for the marker-based alternative).
- **`AudioParam.cancelAndHoldAtTime()` scheduled ahead of time does not hold in Chromium**: a release ramp placed after it starts from the *previous* automation event (measured offline: a "held" synth note decayed through its whole hold). `OscillatorVoice` therefore computes the envelope value analytically and re-schedules the partial ramp with `cancelScheduledValues` + `exponentialRampToValueAtTime`. This also corrected the sequencer's fixed-length synth notes (their release used to start from the attack peak); the goldens were regenerated.
- **Input latency policy**: a MIDI / key event stamped at DOM time `T` is scheduled at `map(T) + L`, where `map` uses `AudioContext.getOutputTimestamp()` and `L = max(20 ms, baseLatency + outputLatency + 5 ms)` (47 ms in headless Chromium). Constant by design: the spacing of what was played is preserved instead of jittering with the main thread. `getOutputTimestamp()` occasionally returns a *stale* pair under load, so the mapper keeps the largest offset of the last 250 ms; it is sampled at 10 Hz plus once per event, because polling it at 40 Hz measurably worsened the engine's own scheduling jitter (it touches the audio thread's position).
- **Offline renders apply input events, chamber notes and sequencer steps in time order** (`OfflineRenderer`): CV changes reach the notes that follow them, exactly as in realtime. The physics still runs in a single pass (its collision times are sub-step exact only then) with its notes queued and merged by time.
- **`AnalyserNode` polling is kept long**: the SENSE tracker reads a 32768-sample window (~743 ms) every 16 ms and analyses only what arrived since the previous poll, so main-thread stalls (measured: ~200 ms in headless Chromium under test load) lose no onsets. `cancelAndHoldAtTime`-style short clicks are avoided: the virtual voice's clap decays linearly over 40 ms.
- **Headless Chromium's fake audio sink underruns under load**: the audio clock stalls ~10 ms at a time against the wall clock (measured in `tests/e2e/input.test.ts`). Takes still verify to < 1 ms because the schedule and the recording share the audio clock; wall-clock spacing is only judged over stall-free intervals.

## Getting Started

### Prerequisites

Node 22.18 or higher. Nothing else.

### Installation and the usual flow

```bash
npm install          # works in any mode (NODE_ENV=production included): every tool an npm
                     # script needs is a regular dependency, there are no devDependencies
npm run build        # type-check + Vite production build -> dist/
npm start            # serve dist/ at http://localhost:4173 (builds first if dist/ is missing)
npm run dev          # or: Vite dev server with hot reload at http://localhost:5173
```

For the end-to-end audio tests a Chromium is needed once:

```bash
npm run setup        # finds a browser that launches (or downloads Playwright's) and saves the
                     # choice in .tropicflow/browser.json; installs anything missing
npm test
```

`npm run setup` is idempotent; re-run it after installing a browser or moving machines. Tests and scripts use the saved browser automatically; `TROPICFLOW_CHROMIUM=/path` or `TROPICFLOW_CHANNEL=chrome` still override it. `npm run check` only diagnoses (note: `npm doctor` is a different, built-in npm command).

### Why the tooling is shaped this way

- **No devDependencies.** This is a local workstation, not a library: `npm install` must be enough whatever `NODE_ENV` is, so build/test tools are plain dependencies.
- **No transpiler layer for tests.** Node >= 22.18 strips TypeScript types natively; tests and CLI scripts run with `node file.ts`. The code therefore uses explicit `.ts` import extensions, `import type` for types (enforced by `verbatimModuleSyntax`) and no constructor parameter properties.
- **One bundler.** Vite builds the app and, through its JS API, the headless test harness. There is no direct esbuild/tsx dependency, so no version conflicts between bundler copies.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `sh: vite: command not found` (or `tsc`) | `node_modules` incomplete | `npm install` (tools are regular dependencies; any install mode works), then `npm run check` |
| `Unknown file extension ".ts"` or import errors running tests | Node older than 22.18 | upgrade Node (https://nodejs.org) |
| `Could not start any Chromium for the audio tests` | see the per-browser reasons printed under it | The tests try, in order: `TROPICFLOW_CHROMIUM=/path/to/chrome`, `TROPICFLOW_CHANNEL=chrome\|msedge\|chromium`, Playwright's downloaded Chromium, any installed Chrome/Edge/Chromium. `npm run check` launches each candidate and prints why it fails. |
| `... executable does not exist` | Playwright's browser is not downloaded, or the path in `TROPICFLOW_CHROMIUM` is wrong | `npx playwright install chromium` (`npm run setup`), or point `TROPICFLOW_CHROMIUM` at a real binary, or `TROPICFLOW_CHANNEL=chrome` to use your desktop Chrome |
| `... missing shared libraries: libnss3.so, ...` | the browser binary is there but OS libraries are not (headless server / minimal container) | with sudo on Debian/Ubuntu: `sudo npx playwright install-deps chromium`. Without sudo: use a browser already installed (`TROPICFLOW_CHANNEL=chrome`), or run the tests in `mcr.microsoft.com/playwright:v1.56.1-noble` (Docker image with all libraries). |
| E2E UI tests skipped | no production build | `npm run build` first (or `npm run test:e2e:ui`) |
| A realtime e2e test reports `# SKIP ... The machine, not the engine, was late` | the main thread stalled during the take (loaded or virtualised machine) | nothing to fix in the code; run on a quieter machine for the full judgement |
| MIDI / MIC greyed out in the app | insecure context, no Web MIDI / no MIDI service / no microphone | open via `http://localhost`, or use the computer keys / VOICE; `npm run check` reports the browser's capabilities |

`npm run check` also reports what the test browser can do for the hardware bridge: Web MIDI (API, service, inputs) and audio capture (API, inputs).

Always run tools through npm scripts (`npm run dev`, not a global `vite`). The unit tests (`npm run test:unit`, 129 tests incl. all physics, MIDI parsing, pitch/onset detection) need no browser at all.

### Development Server

```bash
npm run dev
```

Visit `http://localhost:5173`.

### Production Build

```bash
npm run build
npm run preview
```

## Testing without listening

The audio output is verified numerically, never by ear.

**Realtime tests on a loaded machine.** Two kinds of e2e tests run the engine in realtime (live recording, live MIDI input). Their timing assertions are only meaningful if the machine kept up with the audio clock, so they measure it: every sequencer step records how far ahead of the audio clock it was scheduled (the clock works 100 ms ahead; healthy is 75-100 ms). If any step inside the judged window was scheduled *after* its time - the main thread stalled, the note was played late through no fault of the engine - the test is reported as **skipped with the measurement** (`# SKIP ... The machine, not the engine, was late.`), never as a failure. A take that verifies is still reported in full. Measured on a loaded 4-core VM: skipped in roughly 1 run in 5; on a desktop the window is never late. (`tests/e2e/lib/realtime.ts`)

| Layer | Command | What it proves | Runtime |
|---|---|---|---|
| Unit | `npm run test:unit` | clock math (step/swing timing, grid quantization), patch resolution rules, WAV codec round-trips, analysis functions on synthetic signals, seeded PRNG, physics (analytic free-fall/bounce series, energy, no tunnelling, pegs/ramps/ball-ball, resting/sleep, determinism), collision mapping, chamber scheduling (queued drops, auto-drop per bar, quantize, snapshots, config round-trip) | ~1 s |
| Unit (export) | `npm run test:unit` | Ogg page writer/reader (CRC vs a bitwise reference, lacing, granules from Opus TOC, continued packets, EOS), OpusHead/OpusTags, WebM/EBML demuxing (sized and unknown-size elements), range clamping / end snapping / edge fades / file names | part of the above |
| Render E2E | `npm run test:e2e` | see below; also: the harness runs in a secure context and encodes a render to Ogg Opus of exactly the rendered length | ~10 s |
| Sense E2E | `node --test tests/e2e/sense.test.ts` (part of `npm run test:e2e`) | the SENSE module in the built app: the virtual voice via the keys (tuner within 15 cents, PITCH CV -3 st for A3 over C4, a sung D4 transposes a struck C4 to D4 through a dragged PITCH CV cable, Space claps fire the chosen drum through ONSET TRIG without double triggers), the real `getUserMedia` status on this machine, a **stubbed microphone** (an oscillator: tracked, retuned, stopped; permission refused explained), and **Chromium's fake capture device** playing a WAV synthesised in the test (tones reported in order and in tune, claps firing the drum; the same file analysed offline gives every onset at its exact time) | ~35 s |
| Input E2E | `node --test tests/e2e/input.test.ts` (part of `npm run test:e2e`) | the MIDI BRIDGE in the built app: **CV** (mod-wheel keys open the cutoff by the expected octaves, bend keys bend a held synth note and transpose a new one while the marimba stays put, unplugging the CV cable on the canvas disconnects the wheel, re-plugging by drag reconnects it), header click minimises / drag moves, STACK lays stairs, computer keys hold/release synth notes and light the on-screen keys, octave/velocity/accent/mod/bend keys, form fields and a disabled device do not play, on-screen keys by mouse, the real Web MIDI API's status on this machine, a **fake Web MIDI device** (installed with `addInitScript`: listing, messages, GM drum keys, hot-plug, input and channel filters), a performance injected with DOM timestamps while recording lands in the take at its scheduled times (mean error < 1 ms) with a constant latency, the log replays with exact spacing and BOUNCE renders it (WAV verifies against the SCORE), min/max cards keep their jacks patchable | ~45 s |
| UI E2E | `npm run test:e2e:ui` (`npm run test:e2e` runs the e2e files one at a time: realtime-audio tests in parallel Chromium instances compete for CPU and lose timing accuracy; the whole e2e run takes ~4 min) | real clicks in the built app: start/stop, unplug/plug cables by mouse, bounce → export dialog → WAV + score download verifies, chamber DROP/CLEAR, canvas interactions (drop, pegs, ramps, wheel notes), mapper panel, bar-synced drops, export/import; **recording**: REC + START records a take whose notes verify against the live schedule (mean error < 1 ms), OGG export of a sub-range is valid Ogg Opus of the requested length and decodes in the browser, the MAX slider stops a take by itself, the MediaRecorder fallback (WebCodecs removed) is sample-aligned with the take (correlation > 0.99, lag < 2 ms), ABORT stops a running encode without a download, and without AudioWorklet REC is disabled with an explanation | ~60 s |

`tests/e2e/render.test.ts` renders with the real engine inside headless Chromium and checks:

1. **Determinism** - two renders of the same config are equivalent (SNR >= 90 dB, zero lag).
2. **Score** - the scheduled notes are exactly the pattern at exactly `60/bpm/4` spacing.
3. **Timing, sample-accurate** - each track is rendered as a *solo stem* (dry, pre-compressor tap). Every scheduled note must produce an onset inside its window (drums +-0.6 ms, marimba up to +3.5 ms for its 3 ms attack, synth up to +18 ms for its 15 ms attack) and there must be no unexplained onsets. Run at 118 BPM/48 kHz and 240 BPM/44.1 kHz/swing.
4. **Linearity** - the mixed pre-compressor bus equals the sum of the stems (> 80 dB SNR), proving routing/summing.
5. **In-mix check** - the final master output (compressed, with delay) verified approximately (+-5 ms) per note, with the instrument identified by a rise in its frequency band.
6. **Routing** - unplugging the drums' audio cable *or* trigger cable removes kick-band energy (> 12 dB) at the kick steps; an empty patch renders digital silence.
7c. **Sensor** - the `sensor-follow` preset: tracked-pitch events transpose the sequencer's marimba from the moment they arrive (bar 2 at +2 st, bar 1 untouched), onset events fire the configured drum at their exact times with their strength as velocity (verified on the snare stem), no cables = no effect, the drum follows the sensor settings.
7b. **CV** - the `midi-cv` preset: the mod wheel opens the synth filter (3-6 kHz band +11 dB against the same moment unpatched, identical before the wheel moves), a held note's spectral peak moves 261.6 → 293.7 Hz when the pitch wheel bends it, notes played while bent are transposed in the score (synth, and the marimba through an extra cable; not the synth when its cable is removed), deterministic.
7a. **MIDI** - the `midi-performance` preset replays a scripted performance through the bridge: every note lands in the score at its script time with its velocity, `GATE OUT` cables gate which instruments respond, transpose shifts every frequency, each performed note verifies sample-accurately on its solo stem next to the groove, two renders are equivalent, a malformed script is rejected with a reason.
7. **Chamber** - the `chamber-only` preset (3 balls, pegs, no sequencer) yields >= 20 physics-driven notes; each stem verifies every hit at its collision time (drums to ~0.01-0.5 ms); the browser's collision times equal an independent Node simulation; two renders are equivalent; `quantize: 1` puts every hit on the 16th grid; removing the chamber's trigger cable to the drums silences its drum hits; `chamber-groove` (auto-drop every bar over the default groove) verifies sequencer and chamber notes together per stem, reporting notes that are physically masked by a louder note of the same voice.
8. **Golden** - `tests/golden/default-groove-1bar.wav` and `chamber-only-1bar.wav` must match (correlation > 0.999, windowed level diff < 1 dB, zero lag). Regenerate after an intentional sound change with `npm run golden:update`.

### Comparing WAV files yourself

Ogg exports can be validated without ffmpeg: `npm run inspect:ogg -- file.ogg [--expect-seconds N] [--json]` checks capture patterns, every page CRC, BOS/EOS, OpusHead/OpusTags, granule monotonicity and the implied duration (exit code 1 on any problem). `npm run render:wav -- --ogg 128 ...` also writes an `.ogg` next to the WAV, encoded by the browser's WebCodecs encoder (the render harness is served from `http://localhost` so it is a secure context). `npm run docs:shots` regenerates the user-guide screenshots from the production build.

```bash
# Render a preset (or --config my.json) to WAV + score, optionally the pre-compressor tap
npm run render:wav -- --preset default-groove --bars 2 --out out/groove.wav --tap out/groove.tap.wav
npm run render:wav -- --preset default-groove --bars 2 --ogg 128 --out out/groove.wav   # + out/groove.ogg
npm run inspect:ogg -- out/groove.ogg
npm run render:wav -- --list-presets

# Replay a performance (the MIDI BRIDGE's log JSON, or a bounce score file) through the bridge
npm run render:wav -- --preset default-groove --input performance.json --transpose 12 --out out/take.wav

# Feed a recording (voice, claps) through the SENSE detectors offline: pitch -> PITCH CV, claps -> ONSET TRIG
npm run render:wav -- --preset sensor-follow --sense voice.wav --out out/sense.wav

# Render one instrument, dry, for sample-accurate checks
npm run render:wav -- --preset default-groove --solo hihat --dry --out out/hat.wav --tap out/hat.tap.wav

# Physics-driven material
npm run render:wav -- --preset chamber-only --out out/chamber.wav --tap out/chamber.tap.wav
npm run render:wav -- --preset chamber-only --solo kick --out out/ck.wav --tap out/ck.tap.wav
npm run compare:wav -- out/ck.tap.wav --score out/ck.score.json --signal tap --stem kick

# A vs B: bit-exact flag, max diff, SNR, correlation/lag, windowed level diff, onset agreement
npm run compare:wav -- out/groove.wav tests/golden/default-groove-1bar.wav

# WAV vs its score (the bounce from the UI works too: BOUNCE, EXPORT WAV, then SCORE)
npm run compare:wav -- out/groove.wav --score out/groove.score.json                       # approximate, in-mix
npm run compare:wav -- out/hat.tap.wav --score out/hat.score.json --signal tap --stem hihat   # exact

# machine-readable
npm run compare:wav -- a.wav b.wav --json
```

Exit code is `1` when any tolerance is exceeded.

### What the stem verifier reports

For each scheduled note: found at its time (within the track's window), **masked** (a louder note of the same voice sounds within 30 ms, or a >= 2x louder one within its 150 ms decay - physically indistinguishable, not an error), or **failed**. Plus any **unexpected onsets** outside every scheduled note's decay.

## Continuous integration

`.github/workflows/ci.yml` runs `npm ci`, type-check, unit tests, the Chromium render tests and the UI tests on every push (`npx playwright install --with-deps chromium` provides the browser).

## Roadmap

- SENSE tracker on an AudioWorklet with sample-exact onset times (phase 3b of [docs/HARDWARE_BRIDGE_PLAN.md](docs/HARDWARE_BRIDGE_PLAN.md)), MIDI clock sync, MIDI output.
- Multiple chambers / ball-size-to-pitch mapping.

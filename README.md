# TROPICFLOW

A local-first spatial sound synthesis and modular computing workstation built with TypeScript targeting Node 22+. Operates 100% offline in modern browsers with zero external network requests or cloud services.

## Features

- **Eurorack Modular Canvas**: Draggable hardware synthesizer modules with sagging patch cables. Cables are functional: audio cables route signal, trigger cables decide which modules the clock fires. Drag from a jack to another jack to connect, double-click a jack to unplug it.
- **Web Audio DSP Architecture**: Dedicated single-purpose audio voices including FM Marimba acoustic modeling, analog Percussion engine (Kick, Snare, Hi-Hat), dual-oscillator resonant synth lead/bass, and tape delay with damped feedback.
- **Sample-Accurate Lookahead Clock**: Every note is scheduled on the Web Audio timeline at its exact step time (no timer jitter), with micro-timing swing.
- **16-Step Polyrhythmic Groove Matrix**: Playhead synchronised to the moment each step actually sounds, with per-step auditioning.
- **Live Soundboard & Keys**: Tactile keyboard playable via click or computer keys (`A`-`K`).
- **Dual Real-Time Visualizer**: Phosphor CRT Oscilloscope and 64-band FFT Spectrum Analyzer.
- **Gravity Chamber / Collision Beat Drop**: a deterministic 2-D physics box patched into the modular canvas. Balls fall under gravity and every collision triggers a note through a configurable **Collision Mapper** (surface → instrument, scale, root, velocity curve). Drop balls by hand (now or on the next bar), automatically every Nth bar, or by clicking in the chamber; draw pegs and ramps with the mouse and set their notes with the wheel. Tempo-independent physics with an optional QUANTIZE knob that snaps hits toward the 16th grid; export/import chambers as JSON. **User guide: [docs/GRAVITY_CHAMBER.md](docs/GRAVITY_CHAMBER.md).**
- **Deterministic Offline Bounce**: `BOUNCE WAV` renders the current patch (sequencer *and* chamber, from its current ball state) faster than realtime to a 32-bit float WAV, plus a JSON *score* of every scheduled note so the file can be verified by software (see [Testing](#testing-without-listening)).

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
src/core/graph      module/port model + pure patch resolution  (PatchRouter)
src/core/physics    PhysicsChamber (simulation), CollisionMapper (hit -> note), ChamberEngine (scheduling)
src/core/render     OfflineRenderer, RenderConfig, WAV codec, presets
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

### Known signal-path facts (measured)

- The master bus `DynamicsCompressorNode` adds a **6 ms lookahead latency** (Blink/Gecko/WebKit). A note scheduled at `t` becomes audible at `t + 6 ms`. The offline renderer measures this (`busLatency`) and records both `time` and `audibleTime` in the score.
- CV jacks (pitch / cutoff / time CV) are accepted by the patch system but have no audio effect yet.

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

Always run tools through npm scripts (`npm run dev`, not a global `vite`). The unit tests (`npm run test:unit`, 49 tests incl. all physics) need no browser at all.

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

| Layer | Command | What it proves | Runtime |
|---|---|---|---|
| Unit | `npm run test:unit` | clock math (step/swing timing, grid quantization), patch resolution rules, WAV codec round-trips, analysis functions on synthetic signals, seeded PRNG, physics (analytic free-fall/bounce series, energy, no tunnelling, pegs/ramps/ball-ball, resting/sleep, determinism), collision mapping, chamber scheduling (queued drops, auto-drop per bar, quantize, snapshots, config round-trip) | ~1 s |
| Render E2E | `npm run test:e2e` | see below | ~10 s |
| UI E2E | `npm run test:e2e:ui` | real clicks in the built app: start/stop, unplug/plug cables by mouse, bounce + score download verifies, chamber DROP/CLEAR, canvas interactions (drop, pegs, ramps, wheel notes), mapper panel, bar-synced drops, export/import | ~20 s |

`tests/e2e/render.test.ts` renders with the real engine inside headless Chromium and checks:

1. **Determinism** - two renders of the same config are equivalent (SNR >= 90 dB, zero lag).
2. **Score** - the scheduled notes are exactly the pattern at exactly `60/bpm/4` spacing.
3. **Timing, sample-accurate** - each track is rendered as a *solo stem* (dry, pre-compressor tap). Every scheduled note must produce an onset inside its window (drums +-0.6 ms, marimba up to +3.5 ms for its 3 ms attack, synth up to +18 ms for its 15 ms attack) and there must be no unexplained onsets. Run at 118 BPM/48 kHz and 240 BPM/44.1 kHz/swing.
4. **Linearity** - the mixed pre-compressor bus equals the sum of the stems (> 80 dB SNR), proving routing/summing.
5. **In-mix check** - the final master output (compressed, with delay) verified approximately (+-5 ms) per note, with the instrument identified by a rise in its frequency band.
6. **Routing** - unplugging the drums' audio cable *or* trigger cable removes kick-band energy (> 12 dB) at the kick steps; an empty patch renders digital silence.
7. **Chamber** - the `chamber-only` preset (3 balls, pegs, no sequencer) yields >= 20 physics-driven notes; each stem verifies every hit at its collision time (drums to ~0.01-0.5 ms); the browser's collision times equal an independent Node simulation; two renders are equivalent; `quantize: 1` puts every hit on the 16th grid; removing the chamber's trigger cable to the drums silences its drum hits; `chamber-groove` (auto-drop every bar over the default groove) verifies sequencer and chamber notes together per stem, reporting notes that are physically masked by a louder note of the same voice.
8. **Golden** - `tests/golden/default-groove-1bar.wav` and `chamber-only-1bar.wav` must match (correlation > 0.999, windowed level diff < 1 dB, zero lag). Regenerate after an intentional sound change with `npm run golden:update`.

### Comparing WAV files yourself

```bash
# Render a preset (or --config my.json) to WAV + score, optionally the pre-compressor tap
npm run render:wav -- --preset default-groove --bars 2 --out out/groove.wav --tap out/groove.tap.wav
npm run render:wav -- --list-presets

# Render one instrument, dry, for sample-accurate checks
npm run render:wav -- --preset default-groove --solo hihat --dry --out out/hat.wav --tap out/hat.tap.wav

# Physics-driven material
npm run render:wav -- --preset chamber-only --out out/chamber.wav --tap out/chamber.tap.wav
npm run render:wav -- --preset chamber-only --solo kick --out out/ck.wav --tap out/ck.tap.wav
npm run compare:wav -- out/ck.tap.wav --score out/ck.score.json --signal tap --stem kick

# A vs B: bit-exact flag, max diff, SNR, correlation/lag, windowed level diff, onset agreement
npm run compare:wav -- out/groove.wav tests/golden/default-groove-1bar.wav

# WAV vs its score (the bounce from the UI works too: BOUNCE WAV then SCORE)
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

- Functional CV cables (pitch / cutoff / delay-time modulation).
- Multiple chambers / ball-size-to-pitch mapping.

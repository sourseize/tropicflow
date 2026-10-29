# TROPICFLOW

A local-first spatial sound synthesis and modular computing workstation built with TypeScript targeting Node 22+. Operates 100% offline in modern browsers with zero external network requests or cloud services.

## Features

- **Eurorack Modular Canvas**: Draggable hardware synthesizer modules with realistic sagging patch cables and interactive connector jacks.
- **Web Audio DSP Architecture**: Dedicated single-purpose audio voices including FM Marimba acoustic modeling, analog Percussion engine (Kick, Snare, Hi-Hat), dual-oscillator resonant synth lead/bass, and tape delay with damped feedback.
- **High-Precision Lookahead Clock**: Web Audio hardware clock-synchronized scheduler with micro-timing swing.
- **16-Step Polyrhythmic Groove Matrix**: Real-time playhead synchronized to domain events with per-step auditioning.
- **Live Soundboard & Keys**: Tactile keyboard playable via click or computer keys (`A`-`K`).
- **Dual Real-Time Visualizer**: Phosphor CRT Oscilloscope and 64-band FFT Spectrum Analyzer.

## Tech Stack & Architecture

- **Runtime**: Node >= 22.0.0
- **Language**: TypeScript 5.7+ (strict mode)
- **UI & Styling**: React 19, Tailwind CSS, Lucide Icons
- **Audio & Visuals**: Web Audio API, HTML5 Canvas 2D
- **Patterns**: Hexagonal Architecture, Event-Driven Pub/Sub CQRS, Single Responsibility Principle

## Getting Started

### Prerequisites

Node 22 or higher.

### Installation

```bash
npm install
```

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

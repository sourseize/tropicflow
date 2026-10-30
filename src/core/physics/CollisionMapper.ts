import type { CollisionEvent, SurfaceKind, WallSide } from './ChamberTypes.ts';

export type TrackName = 'kick' | 'snare' | 'hihat' | 'marimba' | 'synth';
export type MappedTrack = TrackName | 'none';

export interface SurfaceMapping {
  track: MappedTrack;
  /** Hi-hat only: open (long) or closed. */
  open?: boolean;
}

export interface NoteCommand {
  track: TrackName;
  frequency?: number;
  velocity: number;
  open?: boolean;
  /** Synth only: gate length in seconds. */
  duration?: number;
}

export interface ChamberMapping {
  floor: SurfaceMapping;
  ceiling: SurfaceMapping;
  left: SurfaceMapping;
  right: SurfaceMapping;
  peg: SurfaceMapping;
  segment: SurfaceMapping;
  ball: SurfaceMapping;
  /** Scale in semitones above the root, repeated per octave. */
  scale: number[];
  rootHz: number;
  /** Impact speed (units/s) that maps to velocity 1.0. */
  velocityScale: number;
  minVelocity: number;
  synthDuration: number;
}

/** Named scales (semitones above the root) selectable in the mapper UI. */
export const SCALES: Record<string, number[]> = {
  'major pentatonic': [0, 2, 4, 7, 9],
  'minor pentatonic': [0, 3, 5, 7, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  'whole tone': [0, 2, 4, 6, 8, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/** Root notes offered by the UI (name -> Hz). */
export const ROOT_NOTES: Record<string, number> = {
  C3: 130.81,
  D3: 146.83,
  E3: 164.81,
  F3: 174.61,
  G3: 196.0,
  A3: 220.0,
  B3: 246.94,
  C4: 261.63,
  D4: 293.66,
  E4: 329.63,
  F4: 349.23,
  G4: 392.0,
  A4: 440.0,
  C5: 523.25,
};

/** Name of the scale that equals `scale`, if any. */
export function scaleName(scale: number[]): string | null {
  for (const [name, s] of Object.entries(SCALES)) {
    if (s.length === scale.length && s.every((v, i) => v === scale[i])) return name;
  }
  return null;
}

/** All surface keys of a mapping, in UI order. */
export const SURFACE_KEYS = ['floor', 'ceiling', 'left', 'right', 'peg', 'segment', 'ball'] as const;
export type SurfaceKey = (typeof SURFACE_KEYS)[number];

/** Choices for a surface in the UI; 'hihat-open' is hihat with open=true. */
export const SURFACE_CHOICES = ['kick', 'snare', 'hihat', 'hihat-open', 'marimba', 'synth', 'none'] as const;
export type SurfaceChoice = (typeof SURFACE_CHOICES)[number];

export function surfaceChoice(m: SurfaceMapping): SurfaceChoice {
  if (m.track === 'hihat') return m.open ? 'hihat-open' : 'hihat';
  return m.track;
}

export function surfaceMappingFromChoice(choice: SurfaceChoice): SurfaceMapping {
  if (choice === 'hihat-open') return { track: 'hihat', open: true };
  if (choice === 'hihat') return { track: 'hihat', open: false };
  return { track: choice };
}

/** Major pentatonic, C4 root. Pegs are 'marimba', the floor is the kick drum. */
export const DEFAULT_MAPPING: ChamberMapping = {
  floor: { track: 'kick' },
  ceiling: { track: 'snare' },
  left: { track: 'hihat', open: false },
  right: { track: 'hihat', open: true },
  peg: { track: 'marimba' },
  segment: { track: 'synth' },
  ball: { track: 'snare' },
  scale: SCALES['major pentatonic'],
  rootHz: ROOT_NOTES.C4,
  velocityScale: 2.2,
  minVelocity: 0.25,
  synthDuration: 0.18,
};

export function degreeToFrequency(degree: number, scale: number[], rootHz: number): number {
  const n = scale.length;
  const octave = Math.floor(degree / n);
  const idx = ((degree % n) + n) % n;
  return rootHz * Math.pow(2, (scale[idx] + 12 * octave) / 12);
}

function surfaceMapping(kind: SurfaceKind, side: WallSide | undefined, mapping: ChamberMapping): SurfaceMapping {
  if (kind === 'wall') return mapping[side ?? 'floor'];
  return mapping[kind];
}

/** Pure: translate a collision into the note it should trigger (or null). */
export function mapCollision(event: CollisionEvent, mapping: ChamberMapping): NoteCommand | null {
  const sm = surfaceMapping(event.surfaceKind, event.side, mapping);
  if (sm.track === 'none') return null;

  const velocity = Math.max(mapping.minVelocity, Math.min(1, event.impactSpeed / mapping.velocityScale));
  const cmd: NoteCommand = { track: sm.track, velocity };

  if (sm.track === 'hihat') cmd.open = sm.open ?? false;
  if (sm.track === 'marimba' || sm.track === 'synth') {
    const degree = event.note ?? 0;
    cmd.frequency = degreeToFrequency(degree, mapping.scale, mapping.rootHz);
  }
  if (sm.track === 'synth') cmd.duration = mapping.synthDuration;
  return cmd;
}

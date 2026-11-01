import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareInputEvents,
  deviceKind,
  hzToMidiNote,
  midiDeviceId,
  midiNoteToHz,
  nearestNote,
  noteName,
  parseNoteName,
} from '../../src/core/input/InputEvents.ts';
import { MARIMBA_NOTES, SYNTH_NOTES } from '../../src/core/audio/AudioEngine.ts';
import { ROOT_NOTES } from '../../src/core/physics/CollisionMapper.ts';
import type { InputEvent } from '../../src/core/input/InputEvents.ts';

test('midiNoteToHz matches the frequencies the engine already uses', () => {
  assert.ok(Math.abs(midiNoteToHz(69) - 440) < 1e-9);
  assert.ok(Math.abs(midiNoteToHz(60) - 261.63) < 0.01);
  assert.ok(Math.abs(midiNoteToHz(48) - SYNTH_NOTES[0]) < 0.01, 'C3 = first synth note');
  assert.ok(Math.abs(midiNoteToHz(60) - MARIMBA_NOTES[0]) < 0.01, 'C4 = first marimba note');
  for (const [name, hz] of Object.entries(ROOT_NOTES)) {
    const note = parseNoteName(name)!;
    assert.ok(Math.abs(midiNoteToHz(note) - hz) < 0.01, `${name}: ${midiNoteToHz(note)} vs ${hz}`);
  }
  // Fractional notes are a quarter tone apart in frequency ratio.
  assert.ok(Math.abs(midiNoteToHz(60.5) / midiNoteToHz(60) - Math.pow(2, 1 / 24)) < 1e-12);
});

test('hzToMidiNote inverts midiNoteToHz and supports a different A4', () => {
  for (let n = 0; n <= 127; n += 7) assert.ok(Math.abs(hzToMidiNote(midiNoteToHz(n)) - n) < 1e-9);
  assert.ok(Math.abs(hzToMidiNote(432, 432) - 69) < 1e-12);
  assert.ok(Math.abs(midiNoteToHz(69, 432) - 432) < 1e-12);
});

test('noteName / parseNoteName round-trip, flats accepted, negative octaves', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61), 'C#4');
  assert.equal(noteName(69), 'A4');
  assert.equal(noteName(0), 'C-1');
  assert.equal(noteName(60.4), 'C4');
  for (let n = 0; n <= 127; n++) assert.equal(parseNoteName(noteName(n)), n);
  assert.equal(parseNoteName('Bb2'), 46);
  assert.equal(parseNoteName('f#3'), 54);
  assert.equal(parseNoteName('H2'), null);
  assert.equal(parseNoteName('C'), null);
});

test('nearestNote gives the tuner readout: note, name and signed cents', () => {
  const a = nearestNote(440);
  assert.deepEqual([a.note, a.name], [69, 'A4']);
  assert.ok(Math.abs(a.cents) < 1e-9);
  const sharp = nearestNote(440 * Math.pow(2, 20 / 1200));
  assert.equal(sharp.note, 69);
  assert.ok(Math.abs(sharp.cents - 20) < 1e-9);
  const flat = nearestNote(midiNoteToHz(60) * Math.pow(2, -30 / 1200));
  assert.equal(flat.name, 'C4');
  assert.ok(Math.abs(flat.cents + 30) < 1e-9);
  // Exactly halfway rounds to the upper note with -50 cents.
  const half = nearestNote(midiNoteToHz(60.5));
  assert.equal(half.note, 61);
  assert.ok(Math.abs(half.cents + 50) < 1e-6);
});

test('device ids carry their kind', () => {
  assert.equal(deviceKind(midiDeviceId('input-0')), 'midi');
  assert.equal(deviceKind('keys'), 'keys');
  assert.equal(deviceKind('sensor:mic'), 'sensor');
  assert.equal(deviceKind('script'), 'script');
  assert.equal(deviceKind('something-else'), 'script');
});

test('compareInputEvents orders by time and puts note-offs before note-ons at equal times', () => {
  const events: InputEvent[] = [
    { kind: 'noteOn', time: 1, device: 'keys', note: 60, velocity: 1 },
    { kind: 'noteOff', time: 1, device: 'keys', note: 60 },
    { kind: 'control', time: 1, device: 'keys', control: 'mod', value: 0.5 },
    { kind: 'noteOn', time: 0.5, device: 'keys', note: 62, velocity: 1 },
  ];
  const sorted = [...events].sort(compareInputEvents);
  assert.deepEqual(sorted.map((e) => `${e.time}:${e.kind}`), ['0.5:noteOn', '1:noteOff', '1:control', '1:noteOn']);
});

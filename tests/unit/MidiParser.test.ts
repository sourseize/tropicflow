import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MidiParser,
  bendToUnit,
  controlIdFor,
  decodeMidiMessage,
  encodeMidiEvent,
  midiMessageToEvents,
} from '../../src/core/input/midi/MidiParser.ts';
import type { InputEvent } from '../../src/core/input/InputEvents.ts';

test('decodeMidiMessage: every channel voice message, channel 1..16', () => {
  assert.deepEqual(decodeMidiMessage([0x90, 60, 100]), { type: 'noteOn', channel: 1, note: 60, velocity: 100 });
  assert.deepEqual(decodeMidiMessage([0x8f, 60, 64]), { type: 'noteOff', channel: 16, note: 60, velocity: 64 });
  assert.deepEqual(decodeMidiMessage([0x90, 60, 0]), { type: 'noteOff', channel: 1, note: 60, velocity: 0 }, 'velocity 0 = note off');
  assert.deepEqual(decodeMidiMessage([0xa2, 60, 99]), { type: 'polyAftertouch', channel: 3, note: 60, pressure: 99 });
  assert.deepEqual(decodeMidiMessage([0xb0, 1, 127]), { type: 'controlChange', channel: 1, controller: 1, value: 127 });
  assert.deepEqual(decodeMidiMessage([0xc5, 12]), { type: 'programChange', channel: 6, program: 12 });
  assert.deepEqual(decodeMidiMessage([0xd0, 77]), { type: 'channelAftertouch', channel: 1, pressure: 77 });
  assert.deepEqual(decodeMidiMessage([0xe0, 0x00, 0x40]), { type: 'pitchBend', channel: 1, value: 8192 });
  assert.deepEqual(decodeMidiMessage([0xe0, 0x7f, 0x7f]), { type: 'pitchBend', channel: 1, value: 16383 });
});

test('decodeMidiMessage rejects system messages, data bytes and truncated input', () => {
  assert.equal(decodeMidiMessage([]), null);
  assert.equal(decodeMidiMessage([60, 100]), null);
  assert.equal(decodeMidiMessage([0xf0, 0x43, 0xf7]), null);
  assert.equal(decodeMidiMessage([0xf8]), null);
  assert.equal(decodeMidiMessage([0x90, 60]), null);
  // High bits of data bytes are masked rather than trusted.
  assert.deepEqual(decodeMidiMessage([0x90, 60 | 0x80, 100]), { type: 'noteOn', channel: 1, note: 60, velocity: 100 });
});

test('pitch bend maps 0..16383 to -1..1 with 8192 at rest', () => {
  assert.equal(bendToUnit(8192), 0);
  assert.equal(bendToUnit(0), -1);
  assert.ok(Math.abs(bendToUnit(16383) - (8191 / 8192)) < 1e-12);
  assert.equal(bendToUnit(20000), 1);
});

test('controller numbers get names where the engine has a use for them', () => {
  assert.equal(controlIdFor(1), 'mod');
  assert.equal(controlIdFor(7), 'volume');
  assert.equal(controlIdFor(11), 'expression');
  assert.equal(controlIdFor(64), 'sustain');
  assert.equal(controlIdFor(74), 74);
});

test('midiMessageToEvents normalises to 0..1 and keeps the channel', () => {
  const ev = midiMessageToEvents({ type: 'noteOn', channel: 2, note: 64, velocity: 127 }, 1.5, 'midi:x');
  assert.deepEqual(ev, [{ kind: 'noteOn', time: 1.5, device: 'midi:x', channel: 2, note: 64, velocity: 1 }]);
  const cc = midiMessageToEvents({ type: 'controlChange', channel: 1, controller: 1, value: 64 }, 0, 'd');
  assert.equal(cc[0].kind, 'control');
  assert.ok(Math.abs((cc[0] as { value: number }).value - 64 / 127) < 1e-12);
  assert.deepEqual(midiMessageToEvents({ type: 'programChange', channel: 1, program: 3 }, 0, 'd'), []);
  assert.deepEqual(midiMessageToEvents({ type: 'polyAftertouch', channel: 1, note: 1, pressure: 3 }, 0, 'd'), []);
  const at = midiMessageToEvents({ type: 'channelAftertouch', channel: 1, pressure: 127 }, 0, 'd');
  assert.deepEqual(at, [{ kind: 'control', time: 0, device: 'd', channel: 1, control: 'aftertouch', value: 1 }]);
});

test('MidiParser: several messages per packet, running status, realtime bytes interleaved', () => {
  const p = new MidiParser('midi:a');
  // Two note-ons in one packet, the second via running status, with a MIDI clock byte in between.
  const events = p.parse([0x90, 60, 100, 0xf8, 62, 90], 2);
  assert.deepEqual(
    events.map((e) => [e.kind, (e as { note: number }).note]),
    [['noteOn', 60], ['noteOn', 62]]
  );
  // Running status persists across packets.
  const next = p.parse([64, 0], 2.1);
  assert.deepEqual(next, [{ kind: 'noteOff', time: 2.1, device: 'midi:a', channel: 1, note: 64, velocity: 0 }]);
  // A stray data byte with no running status is dropped.
  const fresh = new MidiParser('midi:b');
  assert.deepEqual(fresh.parse([60, 100], 0), []);
});

test('MidiParser skips sysex (even split across packets) and system common messages', () => {
  const p = new MidiParser('midi:a');
  assert.deepEqual(p.parse([0xf0, 0x7e, 0x7f, 0x09], 0), []);
  assert.deepEqual(p.parse([0x01, 0xf7, 0x90, 60, 100], 0.5).map((e) => e.kind), ['noteOn']);
  // Song position pointer (2 data bytes) is skipped entirely and cancels running status.
  assert.deepEqual(p.parse([0xf2, 0x10, 0x20, 62, 100], 1), []);
  // Truncated packet: the complete message is kept, the remainder dropped.
  assert.deepEqual(p.parse([0x90, 60, 100, 0x90, 62], 2).length, 1);
});

test('MidiParser channel filter: only the chosen channel passes; omni passes everything', () => {
  const p = new MidiParser('midi:a', { channel: 10 });
  assert.deepEqual(p.parse([0x90, 36, 100], 0), []);
  assert.equal(p.parse([0x99, 36, 100], 0).length, 1);
  p.setChannel(undefined);
  assert.equal(p.parse([0x90, 36, 100], 0).length, 1);
  assert.equal(p.getChannel(), undefined);
});

test('encodeMidiEvent round-trips through the parser', () => {
  const events: InputEvent[] = [
    { kind: 'noteOn', time: 0, device: 'midi:a', channel: 3, note: 60, velocity: 100 / 127 },
    { kind: 'noteOff', time: 0, device: 'midi:a', channel: 3, note: 60, velocity: 0 },
    { kind: 'control', time: 0, device: 'midi:a', channel: 3, control: 'mod', value: 64 / 127 },
    { kind: 'control', time: 0, device: 'midi:a', channel: 3, control: 74, value: 1 },
    { kind: 'control', time: 0, device: 'midi:a', channel: 3, control: 'aftertouch', value: 0.5 },
    { kind: 'control', time: 0, device: 'midi:a', channel: 3, control: 'bend', value: 0 },
    { kind: 'control', time: 0, device: 'midi:a', channel: 3, control: 'bend', value: -1 },
  ];
  const p = new MidiParser('midi:a');
  for (const e of events) {
    const bytes = encodeMidiEvent(e)!;
    assert.ok(bytes, `encodable: ${JSON.stringify(e)}`);
    const back = p.parse(bytes, 0);
    assert.equal(back.length, 1);
    const b = back[0];
    assert.equal(b.kind, e.kind);
    assert.equal(b.channel, 3);
    if (e.kind === 'control' && b.kind === 'control') {
      assert.equal(b.control, e.control);
      assert.ok(Math.abs(b.value - e.value) < 1 / 127, `${String(e.control)}: ${b.value} vs ${e.value}`);
    }
    if (e.kind === 'noteOn' && b.kind === 'noteOn') assert.ok(Math.abs(b.velocity - e.velocity) < 1e-12);
  }
  // A note-on with velocity 0 would decode as a note-off, so the encoder floors velocity at 1.
  assert.deepEqual(encodeMidiEvent({ kind: 'noteOn', time: 0, device: 'x', note: 1, velocity: 0 }), [0x90, 1, 1]);
  assert.equal(encodeMidiEvent({ kind: 'pitch', time: 0, device: 'x', hz: 440, clarity: 1 }), null);
});

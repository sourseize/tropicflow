import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyboardDevice } from '../../src/core/input/keyboard/KeyboardDevice.ts';
import { WebMidiDevice, describeMidiError, type MidiAccessLike, type MidiInputLike } from '../../src/core/input/midi/WebMidiDevice.ts';
import type { InputEvent } from '../../src/core/input/InputEvents.ts';

/** A keyboard event as the device sees it (Node has Event/EventTarget but no KeyboardEvent). */
function keyEvent(type: 'keydown' | 'keyup', code: string, extra: Record<string, unknown> = {}): Event {
  const e = new Event(type, { cancelable: true });
  return Object.assign(e, { code, key: '', shiftKey: false, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });
}

test('KeyboardDevice: listens only while enabled, stamps events, preventDefault on handled keys, panic on blur', () => {
  const target = new EventTarget();
  const published: InputEvent[] = [];
  const dev = new KeyboardDevice({ stamp: (ms) => ms / 1000 + 100, publish: (ev) => published.push(...ev), target });

  target.dispatchEvent(keyEvent('keydown', 'KeyA'));
  assert.equal(published.length, 0, 'disabled: ignored');

  dev.enable();
  const down = keyEvent('keydown', 'KeyA');
  target.dispatchEvent(down);
  assert.equal(published.length, 1);
  assert.equal(published[0].kind, 'noteOn');
  assert.ok(published[0].time >= 100, 'time comes from stamp()');
  assert.equal(down.defaultPrevented, true);

  const other = keyEvent('keydown', 'Digit1');
  target.dispatchEvent(other);
  assert.equal(other.defaultPrevented, false, 'unrelated keys are left to the browser');

  const ctrl = keyEvent('keydown', 'KeyS', { ctrlKey: true });
  target.dispatchEvent(ctrl);
  assert.equal(published.length, 1, 'Ctrl/Meta/Alt shortcuts are not notes');

  const repeat = keyEvent('keydown', 'KeyA', { repeat: true });
  target.dispatchEvent(repeat);
  assert.equal(published.length, 1);
  assert.equal(repeat.defaultPrevented, true, 'auto-repeat of a note key is swallowed');

  target.dispatchEvent(new Event('blur'));
  assert.equal(published.length, 2);
  assert.equal(published[1].kind, 'noteOff');
  assert.deepEqual(dev.getState().held, {});

  // Programmatic press/release (on-screen keys) share the state, and disable() releases everything.
  dev.press('KeyK', 5000);
  assert.equal((published[2] as { note: number }).note, 60);
  assert.ok(Math.abs(published[2].time - 105) < 1e-9);
  dev.disable();
  assert.equal(published[3].kind, 'noteOff');
  target.dispatchEvent(keyEvent('keydown', 'KeyA'));
  assert.equal(published.length, 4, 'disabled again');
  assert.equal(dev.isEnabled(), false);
});

class FakeInput implements MidiInputLike {
  public onmidimessage: MidiInputLike['onmidimessage'] = null;
  public id: string;
  public name: string;
  public state: string;
  constructor(id: string, name: string, state: string = 'connected') {
    this.id = id;
    this.name = name;
    this.state = state;
  }
  send(bytes: number[], timeStamp = 1000) {
    this.onmidimessage?.({ data: new Uint8Array(bytes), timeStamp });
  }
}

function fakeAccess(inputs: FakeInput[]): MidiAccessLike & { list: FakeInput[] } {
  const access = {
    list: inputs,
    inputs: { forEach: (cb: (i: MidiInputLike) => void) => access.list.forEach(cb), get size() { return access.list.length; } },
    onstatechange: null as ((ev: unknown) => void) | null,
  };
  return access;
}

test('WebMidiDevice: enable lists inputs, routes messages through the parser with stamped times, hot-plug, select, channel', async () => {
  const a = new FakeInput('in-a', 'Fake Keys A');
  const b = new FakeInput('in-b', 'Fake Keys B');
  const access = fakeAccess([a]);
  const published: InputEvent[] = [];
  const statuses: string[] = [];
  const dev = new WebMidiDevice({ stamp: (ms) => ms / 1000, publish: (ev) => published.push(...ev), requestAccess: async () => access, isSecureContext: () => true });
  dev.subscribe((s) => statuses.push(s.state));
  assert.equal(dev.getStatus().state, 'idle');

  const status = await dev.enable();
  assert.equal(status.state, 'ready');
  assert.deepEqual(status.inputs.map((i) => i.name), ['Fake Keys A']);
  assert.match(status.message, /listening to Fake Keys A/);
  assert.deepEqual(statuses, ['requesting', 'ready']);

  a.send([0x90, 60, 100], 2500);
  assert.deepEqual(published, [{ kind: 'noteOn', time: 2.5, device: 'midi:in-a', channel: 1, note: 60, velocity: 100 / 127 }]);

  // Hot-plug: a second device appears, statechange re-lists and attaches it.
  access.list = [a, b];
  access.onstatechange?.({});
  assert.deepEqual(dev.getStatus().inputs.map((i) => i.id), ['in-a', 'in-b']);
  b.send([0x90, 62, 1]);
  assert.equal(published.length, 2);
  assert.equal(published[1].device, 'midi:in-b');

  // Selecting one input detaches the other.
  dev.selectInput('in-b');
  a.send([0x90, 64, 1]);
  assert.equal(published.length, 2, 'deselected input is silent');
  b.send([0x90, 64, 1]);
  assert.equal(published.length, 3);
  assert.match(dev.getStatus().message, /Fake Keys B/);

  // Channel filter applies to the live parsers.
  dev.setChannel(10);
  b.send([0x90, 36, 1]);
  assert.equal(published.length, 3);
  b.send([0x99, 36, 1]);
  assert.equal(published.length, 4);
  assert.equal(published[3].channel, 10);

  // Unplugging the selected device is reported.
  access.list = [a];
  access.onstatechange?.({});
  assert.match(dev.getStatus().message, /not connected/);

  dev.disable();
  assert.equal(dev.getStatus().state, 'idle');
  assert.equal(a.onmidimessage, null);
  a.send([0x90, 60, 1]);
  assert.equal(published.length, 4);
  assert.equal(await dev.enable().then((s) => s.state), 'ready', 're-enable works');
  assert.equal(dev.getStatus().channel, 10, 'settings survive disable/enable');
});

test('WebMidiDevice: unsupported / insecure / denied / platform errors become distinct, readable statuses', async () => {
  const noop = { stamp: (ms: number) => ms, publish: () => {} };
  const unsupported = new WebMidiDevice({ ...noop, isSecureContext: () => true });
  assert.equal(unsupported.getStatus().state, 'unsupported');
  assert.equal((await unsupported.enable()).state, 'unsupported', 'enable() is a no-op without the API');

  const insecure = new WebMidiDevice({ ...noop, requestAccess: async () => fakeAccess([]), isSecureContext: () => false });
  assert.equal(insecure.getStatus().state, 'insecure');
  assert.match(insecure.getStatus().message, /localhost|https/);

  const denied = new WebMidiDevice({ ...noop, requestAccess: async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); }, isSecureContext: () => true });
  assert.equal((await denied.enable()).state, 'denied');
  assert.equal(denied.isEnabled(), false);

  const platform = new WebMidiDevice({
    ...noop,
    requestAccess: async () => { throw Object.assign(new Error('Platform dependent initialization failed.'), { name: 'InvalidStateError' }); },
    isSecureContext: () => true,
  });
  assert.equal((await platform.enable()).state, 'error');
  assert.match(platform.getStatus().message, /no MIDI service/);

  assert.equal(describeMidiError(new Error('weird')).message, 'MIDI error: weird');
  assert.equal(describeMidiError({ name: 'SecurityError' }).state, 'denied');

  const empty = new WebMidiDevice({ ...noop, requestAccess: async () => fakeAccess([]), isSecureContext: () => true });
  assert.match((await empty.enable()).message, /no input devices found/);
});

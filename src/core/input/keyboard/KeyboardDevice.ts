/**
 * The computer keyboard as an input device: window keydown/keyup -> KeyMap
 * reducer -> InputEvents. Also drives the on-screen keys (press/release by
 * key code), so mouse and keys share one state (octave, velocity, held).
 *
 * Ignores keystrokes aimed at form fields and shortcuts with Ctrl/Meta/Alt;
 * releases everything when the window loses focus or the device is disabled.
 */
import type { InputEvent } from '../InputEvents.ts';
import { INITIAL_KEYBOARD_STATE, type KeyInput, type KeyboardState, keyAction, reduceKey, releaseAll } from './KeyMap.ts';

export interface KeyboardDeviceDeps {
  /** Audio-context time to stamp an event that happened at `performanceMs` (DOM timeStamp). */
  stamp: (performanceMs: number) => number;
  publish: (events: InputEvent[]) => void;
  /** Defaults to `window`; tests pass a stub EventTarget. */
  target?: EventTarget;
  /** How listeners are attached (a module passes its resource ledger so they are counted and released). */
  listen?: (target: EventTarget, type: string, fn: EventListener) => () => void;
}

export type KeyboardStateListener = (state: KeyboardState) => void;

function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export class KeyboardDevice {
  private readonly deps: KeyboardDeviceDeps;
  private readonly target: EventTarget;
  private state: KeyboardState = INITIAL_KEYBOARD_STATE;
  private enabled: boolean = false;
  private readonly listeners: Set<KeyboardStateListener> = new Set();

  private readonly onKeyDown = (e: Event) => this.onKey(e as KeyboardEvent, 'down');
  private readonly onKeyUp = (e: Event) => this.onKey(e as KeyboardEvent, 'up');
  private readonly onBlur = () => this.panic(performance.now());
  private unlisten: Array<() => void> = [];

  constructor(deps: KeyboardDeviceDeps) {
    this.deps = deps;
    this.target = deps.target ?? window;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    const listen =
      this.deps.listen ??
      ((target: EventTarget, type: string, fn: EventListener) => {
        target.addEventListener(type, fn);
        return () => target.removeEventListener(type, fn);
      });
    this.unlisten = [listen(this.target, 'keydown', this.onKeyDown), listen(this.target, 'keyup', this.onKeyUp), listen(this.target, 'blur', this.onBlur)];
    this.notify();
  }

  public disable(): void {
    if (!this.enabled) return;
    this.panic(performance.now());
    this.enabled = false;
    for (const off of this.unlisten) off();
    this.unlisten = [];
    this.notify();
  }

  public getState(): KeyboardState {
    return this.state;
  }

  public subscribe(listener: KeyboardStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Programmatic press/release by key code (on-screen keys, tests). Works even when disabled. */
  public press(code: string, performanceMs: number = performance.now(), shiftKey: boolean = false): void {
    this.apply({ type: 'down', code, shiftKey }, performanceMs);
  }

  public release(code: string, performanceMs: number = performance.now()): void {
    this.apply({ type: 'up', code }, performanceMs);
  }

  /** Release every held key and reset the bend. */
  public panic(performanceMs: number = performance.now()): void {
    const r = releaseAll(this.state, this.deps.stamp(performanceMs));
    if (r.state === this.state) return;
    this.state = r.state;
    this.deps.publish(r.events);
    this.notify();
  }

  private onKey(e: KeyboardEvent, type: 'down' | 'up'): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    const input: KeyInput = { type, code: e.code, key: e.key, shiftKey: e.shiftKey, repeat: e.repeat };
    if (this.apply(input, e.timeStamp) || (e.repeat && keyAction(e.code) !== null)) e.preventDefault();
  }

  /** Returns true when the key was one of ours (state or events changed). */
  private apply(input: KeyInput, performanceMs: number): boolean {
    const r = reduceKey(this.state, input, this.deps.stamp(performanceMs));
    if (r.state === this.state && r.events.length === 0) return false;
    this.state = r.state;
    if (r.events.length) this.deps.publish(r.events);
    this.notify();
    return true;
  }

  private notify(): void {
    for (const l of Array.from(this.listeners)) l(this.state);
  }
}

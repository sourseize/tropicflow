/**
 * Fan-out of InputEvents from device adapters to consumers (the engine's
 * note/CV bindings, the UI, the InputLog). Synchronous and ordered; a
 * throwing listener does not stop the others.
 */
import type { InputEvent, InputEventKind } from './InputEvents.ts';

export type InputListener = (event: InputEvent) => void;

export class InputBus {
  private readonly listeners: Set<InputListener> = new Set();
  private readonly byKind: Map<InputEventKind, Set<InputListener>> = new Map();

  public subscribe(listener: InputListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public subscribeKind(kind: InputEventKind, listener: InputListener): () => void {
    let set = this.byKind.get(kind);
    if (!set) {
      set = new Set();
      this.byKind.set(kind, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  public publish(event: InputEvent): void {
    this.dispatch(this.listeners, event);
    const kindListeners = this.byKind.get(event.kind);
    if (kindListeners) this.dispatch(kindListeners, event);
  }

  public publishAll(events: Iterable<InputEvent>): void {
    for (const e of events) this.publish(e);
  }

  public listenerCount(): number {
    let n = this.listeners.size;
    for (const s of this.byKind.values()) n += s.size;
    return n;
  }

  private dispatch(set: Set<InputListener>, event: InputEvent): void {
    for (const l of Array.from(set)) {
      try {
        l(event);
      } catch (err) {
        console.error(`[InputBus] listener failed on ${event.kind}:`, err);
      }
    }
  }
}

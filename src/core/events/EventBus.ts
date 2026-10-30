import type { DomainEvent, DomainEventType } from './DomainEvents.ts';

type EventHandler<T extends DomainEvent = DomainEvent> = (event: T) => void;

export class EventBus {
  private static instance: EventBus;
  private listeners: Map<DomainEventType, Set<EventHandler<any>>> = new Map();

  private constructor() {}

  public static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  public subscribe<T extends DomainEvent>(
    eventType: DomainEventType,
    handler: EventHandler<T>
  ): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    const handlers = this.listeners.get(eventType)!;
    handlers.add(handler);

    return () => {
      handlers.delete(handler);
    };
  }

  public publish(event: DomainEvent): void {
    const handlers = this.listeners.get(event.type);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(event);
        } catch (err) {
          console.error(`[EventBus] Error handling event ${event.type}:`, err);
        }
      });
    }
  }

  public clear(): void {
    this.listeners.clear();
  }
}

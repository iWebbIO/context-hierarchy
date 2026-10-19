// qtil: minimal event emitter with once() support.

type Handler = (payload: unknown) => void;

/** Registration and dispatch for string-keyed events. */
export class Emitter {
  private handlers = new Map<string, Set<Handler>>();

  /** Subscribes `handler` to `event`; returns an unsubscribe function. */
  on(event: string, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  /** Like on(), but removed automatically after the first dispatch. */
  once(event: string, handler: Handler): () => void {
    const wrap: Handler = (payload) => {
      this.off(event, wrap);
      handler(payload);
    };
    return this.on(event, wrap);
  }

  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler);
  }

  /** Dispatches `payload` to every subscriber; returns how many ran. */
  emit(event: string, payload: unknown): number {
    const set = this.handlers.get(event);
    if (!set) {
      return 0;
    }
    let invoked = 0;
    for (const handler of [...set]) {
      handler(payload);
      invoked += 1;
    }
    return invoked;
  }
}

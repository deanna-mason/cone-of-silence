// lib/webrtc/emitter.ts
// Minimal typed event emitter (React-free, dep-free) shared by the signaling
// client and the call session. Events are described as a map of tuple types:
//   type Map = { thing: [payload: string] }

type Handler<A extends unknown[]> = (...args: A) => void;

export class Emitter<E extends Record<string, unknown[]>> {
  private listeners = new Map<keyof E, Set<Handler<never[]>>>();

  /** Subscribes; returns the unsubscribe function. */
  on<K extends keyof E>(event: K, handler: Handler<E[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as unknown as Handler<never[]>);
    return () => set.delete(handler as unknown as Handler<never[]>);
  }

  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    for (const handler of this.listeners.get(event) ?? []) {
      (handler as unknown as Handler<E[K]>)(...args);
    }
  }
}

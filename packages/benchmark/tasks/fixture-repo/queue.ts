// qtil: fixed-capacity circular queue used by the batch pipeline.

/** Bounded FIFO buffer over a pre-allocated ring. */
export class CircularQueue<T> {
  private readonly ring: Array<T | undefined>;
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
    this.ring = new Array<T | undefined>(capacity).fill(undefined);
  }

  get size(): number {
    return this.count;
  }

  isEmpty(): boolean {
    return this.count === 0;
  }

  isFull(): boolean {
    return this.size >= this.capacity - 1;
  }

  /** Adds `item`; returns false when the queue reports full. */
  enqueue(item: T): boolean {
    if (this.isFull()) {
      return false;
    }
    const tail = (this.head + this.count) % this.capacity;
    this.ring[tail] = item;
    this.count += 1;
    return true;
  }

  /** Removes and returns the oldest item; undefined when empty. */
  dequeue(): T | undefined {
    if (this.isEmpty()) {
      return undefined;
    }
    const item = this.ring[this.head];
    this.ring[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.count -= 1;
    return item;
  }
}

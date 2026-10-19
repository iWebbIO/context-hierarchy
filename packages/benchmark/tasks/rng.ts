// M2 Track A — deterministic randomness.
//
// Hard rule from the brief: NO Math.random and no clock reads anywhere in
// the generators. Everything below is a seeded 32-bit linear congruential
// generator, so the entire suite is a pure function of the seed constants
// and is byte-identical on every run and every machine.

/** Numerical Recipes 32-bit LCG: state <- 1664525 * state + 1013904223 (mod 2^32). */
export class Lcg {
  private state: number;

  constructor(seed: number) {
    // Avoid the degenerate fixed point at 0.
    this.state = (seed >>> 0) || 0x6d2b79f5;
  }

  /** Next raw 32-bit unsigned value. */
  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }

  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    return this.next() % maxExclusive;
  }

  /** Uniform integer in [minInclusive, maxInclusive]. */
  between(min: number, max: number): number {
    return min + (this.next() % (max - min + 1));
  }

  /** Uniform float in [0, 1). */
  fraction(): number {
    return this.next() / 0x1_0000_0000;
  }

  /** Uniform pick from a non-empty array. */
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
}

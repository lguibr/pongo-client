// Injectable randomness: `rand` for the app, `seeded` for reproducible tests and effects.

export type Rand = () => number;

export const rand: Rand = () => Math.random();

/** mulberry32: a fast 32-bit PRNG returning values in [0, 1). */
export function seeded(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

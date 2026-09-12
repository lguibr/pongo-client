// Injectable time source. Modules take `now?: Now` so tests can drive time (src/test/fakes/FakeClock.ts).

export type Now = () => number;

/** performance.now, read through the global on every call so a replaced clock is seen. */
export const now: Now = () => performance.now();

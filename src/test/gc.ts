/** Runs a full collection when the test process has --expose-gc (vitest.config.ts); otherwise a no-op.
 *  Used by the zero-allocation checks. Tests use no Node globals, so this goes through globalThis. */
export function forceGc(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

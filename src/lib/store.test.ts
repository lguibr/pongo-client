import { describe, expect, it } from 'vitest';
import { createStore } from './store';
import { shallowEqual } from './useStore';

describe('createStore', () => {
  it('patch notifies only when some value identity changed', () => {
    const inner = { n: 1 };
    const store = createStore({ a: inner, b: 2 });
    let calls = 0;
    const off = store.subscribe(() => calls++);
    const before = store.get();
    store.patch({ a: inner, b: 2 });
    expect(calls).toBe(0);
    expect(store.get()).toBe(before);
    store.patch({ b: 3 });
    expect(calls).toBe(1);
    expect(store.get().a).toBe(inner);
    off();
    store.patch({ b: 4 });
    expect(calls).toBe(1);
  });

  it('set ignores the same object', () => {
    const store = createStore({ a: 1 });
    let calls = 0;
    store.subscribe(() => calls++);
    store.set(store.get());
    expect(calls).toBe(0);
    store.set({ a: 1 });
    expect(calls).toBe(1);
  });
});

describe('shallowEqual', () => {
  it('compares one level of keys by identity', () => {
    const x = {};
    expect(shallowEqual({ a: 1, b: x }, { a: 1, b: x })).toBe(true);
    expect(shallowEqual({ a: 1, b: {} }, { a: 1, b: {} })).toBe(false);
    expect(shallowEqual([1, 2], [1, 2])).toBe(true);
    expect(shallowEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(shallowEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(shallowEqual(NaN, NaN)).toBe(true);
    expect(shallowEqual(null, {})).toBe(false);
  });
});

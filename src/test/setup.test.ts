/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

describe('test setup in jsdom', () => {
  it('provides dialog showModal and close, and close dispatches a close event', () => {
    const dialog = document.createElement('dialog');
    document.body.append(dialog);
    const onClose = vi.fn();
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    expect(dialog.hasAttribute('open')).toBe(true);
    dialog.close();
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    dialog.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    dialog.remove();
  });

  it('provides ResizeObserver and IntersectionObserver', () => {
    const ro = new ResizeObserver(() => {});
    ro.observe(document.body);
    ro.unobserve(document.body);
    ro.disconnect();
    const io = new IntersectionObserver(() => {});
    io.observe(document.body);
    expect(io.takeRecords()).toEqual([]);
    io.disconnect();
  });

  it('provides pointer capture', () => {
    const el = document.createElement('div');
    expect(el.hasPointerCapture(3)).toBe(false);
    el.setPointerCapture(3);
    expect(el.hasPointerCapture(3)).toBe(true);
    expect(document.createElement('div').hasPointerCapture(3)).toBe(false);
    el.releasePointerCapture(3);
    expect(el.hasPointerCapture(3)).toBe(false);
  });

  it('provides navigator.vibrate', () => {
    expect(typeof navigator.vibrate).toBe('function');
    expect(navigator.vibrate(10)).toBe(true);
  });

  it('provides matchMedia and performance.now', () => {
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);
    expect(typeof performance.now()).toBe('number');
  });
});

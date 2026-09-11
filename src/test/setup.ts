// Vitest setup (vitest.config.ts setupFiles). Checks for performance.now and, in jsdom only, stubs what
// jsdom 26.1 lacks. Every stub is installed only when the real API is missing.

if (typeof globalThis.performance === 'undefined' || typeof globalThis.performance.now !== 'function') {
  const origin = Date.now();
  Object.defineProperty(globalThis, 'performance', { value: { now: () => Date.now() - origin }, configurable: true, writable: true });
}

if (typeof window !== 'undefined') installDomStubs();

function installDomStubs(): void {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
  }

  // <dialog>: showModal and close toggle the `open` attribute; close dispatches a `close` event.
  const dialog = typeof HTMLDialogElement === 'function' ? HTMLDialogElement.prototype : null;
  if (dialog !== null) {
    if (typeof dialog.showModal !== 'function') {
      dialog.showModal = function showModal(this: HTMLDialogElement): void {
        this.setAttribute('open', '');
      };
    }
    if (typeof dialog.show !== 'function') {
      dialog.show = function show(this: HTMLDialogElement): void {
        this.setAttribute('open', '');
      };
    }
    if (typeof dialog.close !== 'function') {
      dialog.close = function close(this: HTMLDialogElement, returnValue?: string): void {
        if (!this.hasAttribute('open')) return;
        if (returnValue !== undefined) this.returnValue = returnValue;
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
      };
    }
  }

  // embla-carousel 8.6 constructs both observers (embla-carousel/esm/embla-carousel.esm.js:509,1111).
  if (typeof window.ResizeObserver !== 'function') {
    window.ResizeObserver = class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
  if (typeof window.IntersectionObserver !== 'function') {
    window.IntersectionObserver = class IntersectionObserverStub {
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds: readonly number[] = [];
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
  }

  // Pointer capture, tracked per element so hasPointerCapture answers truthfully.
  const captured = new WeakMap<Element, Set<number>>();
  const el = Element.prototype;
  if (typeof el.setPointerCapture !== 'function') {
    el.setPointerCapture = function setPointerCapture(this: Element, pointerId: number): void {
      let ids = captured.get(this);
      if (ids === undefined) {
        ids = new Set();
        captured.set(this, ids);
      }
      ids.add(pointerId);
    };
  }
  if (typeof el.releasePointerCapture !== 'function') {
    el.releasePointerCapture = function releasePointerCapture(this: Element, pointerId: number): void {
      captured.get(this)?.delete(pointerId);
    };
  }
  if (typeof el.hasPointerCapture !== 'function') {
    el.hasPointerCapture = function hasPointerCapture(this: Element, pointerId: number): boolean {
      return captured.get(this)?.has(pointerId) ?? false;
    };
  }

  if (typeof navigator.vibrate !== 'function') {
    Object.defineProperty(navigator, 'vibrate', { value: (): boolean => true, configurable: true, writable: true });
  }
}

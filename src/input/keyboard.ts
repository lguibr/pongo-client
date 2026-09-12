// Physical key tracking (8.1). Keys are matched by `e.code`, so the keyboard layout and any modifier
// pressed mid-hold do not matter (C95). Held codes are kept in press order and the last pressed key that
// is still held wins; releasing it falls back to the key held before it (C89).
//
// Filtering applies to keydown only. A keyup always releases, because releasing a key that is not held
// is a no-op, while ignoring a keyup that carries a modifier or lands on a form control would leave the
// key stuck (hold A, press Option, release A).

import type { Visual } from './types';

export interface KeyEventLike {
  code: string; key: string; repeat: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean;
  target: EventTarget | null; preventDefault(): void;
}

/** Targets whose keys belong to the control: text entry, selects, sliders and buttons inside a dialog (C91). */
const FORM_SELECTOR = [
  'input', 'textarea', 'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="slider"]',
  'dialog button', '[role="dialog"] button', '[role="alertdialog"] button',
].join(', ');

/** -1 or +1 for the four game codes, 0 for anything else. */
function codeDir(code: string): Visual {
  switch (code) {
    case 'ArrowLeft':
    case 'KeyA':
      return -1;
    case 'ArrowRight':
    case 'KeyD':
      return 1;
    default:
      return 0;
  }
}

/** The Command key on macOS (Windows key elsewhere). Older Firefox reports it as OSLeft and OSRight. */
function isMetaKey(e: KeyEventLike): boolean {
  return e.key === 'Meta' || e.code === 'MetaLeft' || e.code === 'MetaRight' || e.code === 'OSLeft' || e.code === 'OSRight';
}

function isFormTarget(target: EventTarget | null): boolean {
  if (target === null) return false;
  const el = target as Partial<HTMLElement>;
  if (typeof el.closest !== 'function') return false;   // window, document, or a non-element target
  if (el.isContentEditable === true) return true;
  return el.closest(FORM_SELECTOR) !== null;
}

export class KeyboardTracker {
  /** Held game codes, oldest press first. At most four entries. */
  private readonly held: string[] = [];

  /** `playing` gates preventDefault only; keys are tracked in every phase (C18). True when the held set changed. */
  onKeyDown(e: KeyEventLike, playing: boolean): boolean {
    // macOS withholds keyups while Cmd is held, so Meta drops everything (C90). This runs before the
    // modifier filter because a Meta keydown carries metaKey itself.
    if (isMetaKey(e)) return this.clearHeld();
    if (codeDir(e.code) === 0) return false;              // Space and Enter are never game keys
    if (e.ctrlKey || e.metaKey || e.altKey) return false; // shortcuts such as Cmd+A (C90)
    if (isFormTarget(e.target)) return false;             // a focused slider or text field keeps its keys (C91)
    if (playing) e.preventDefault();                      // repeats included: an auto-repeating arrow scrolls too

    const i = this.held.indexOf(e.code);
    if (i === -1) {
      // A repeat for a key that is not held means its keydown was missed or the set was cleared (blur,
      // Meta) while it stayed down: re-add it so the held key is recovered (C18).
      this.held.push(e.code);
      return true;
    }
    if (e.repeat || i === this.held.length - 1) return false;
    // A fresh press of a key we still think is held: its keyup was lost. It is the newest press, so it wins.
    this.held.splice(i, 1);
    this.held.push(e.code);
    return true;
  }

  onKeyUp(e: KeyEventLike): boolean {
    if (isMetaKey(e)) return this.clearHeld();
    const i = this.held.indexOf(e.code);
    if (i === -1) return false;
    this.held.splice(i, 1);
    return true;
  }

  clear(): void {
    this.held.length = 0;
  }

  /** Last-pressed held key wins; 0 when nothing is held. */
  get dir(): Visual {
    const n = this.held.length;
    return n === 0 ? 0 : codeDir(this.held[n - 1]);
  }

  private clearHeld(): boolean {
    if (this.held.length === 0) return false;
    this.held.length = 0;
    return true;
  }
}

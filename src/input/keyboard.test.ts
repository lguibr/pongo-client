/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyboardTracker } from './keyboard';
import type { KeyEventLike } from './keyboard';

type Init = Partial<Omit<KeyEventLike, 'code' | 'preventDefault'>>;

function ev(code: string, init: Init = {}): KeyEventLike {
  return {
    code, key: code, repeat: false, metaKey: false, ctrlKey: false, altKey: false, target: document.body,
    ...init,
    preventDefault: vi.fn(),
  };
}

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('KeyboardTracker: held stack (C89)', () => {
  it('lets the last pressed held key win and falls back when it is released', () => {
    const k = new KeyboardTracker();
    expect(k.dir).toBe(0);
    expect(k.onKeyDown(ev('ArrowLeft'), true)).toBe(true);
    expect(k.dir).toBe(-1);
    expect(k.onKeyDown(ev('KeyD'), true)).toBe(true);
    expect(k.dir).toBe(1);
    expect(k.onKeyUp(ev('KeyD'))).toBe(true);
    expect(k.dir).toBe(-1);
    expect(k.onKeyUp(ev('ArrowLeft'))).toBe(true);
    expect(k.dir).toBe(0);
  });

  it('keeps moving left when A is released while ArrowLeft is still held', () => {
    const k = new KeyboardTracker();
    k.onKeyDown(ev('ArrowLeft'), true);
    k.onKeyDown(ev('KeyA'), true);
    k.onKeyUp(ev('KeyA'));
    expect(k.dir).toBe(-1);
  });

  it('falls back through three held keys in press order', () => {
    const k = new KeyboardTracker();
    k.onKeyDown(ev('KeyA'), true);
    k.onKeyDown(ev('ArrowRight'), true);
    k.onKeyDown(ev('ArrowLeft'), true);
    expect(k.dir).toBe(-1);
    k.onKeyUp(ev('ArrowLeft'));
    expect(k.dir).toBe(1);
    k.onKeyUp(ev('ArrowRight'));
    expect(k.dir).toBe(-1);
  });

  it('reports no change for a keyup of a key that is not held', () => {
    const k = new KeyboardTracker();
    expect(k.onKeyUp(ev('ArrowLeft'))).toBe(false);
    expect(k.onKeyUp(ev('KeyW'))).toBe(false);
  });

  it('clear drops every held key', () => {
    const k = new KeyboardTracker();
    k.onKeyDown(ev('ArrowLeft'), false);
    k.onKeyDown(ev('ArrowRight'), false);
    k.clear();
    expect(k.dir).toBe(0);
    expect(k.onKeyUp(ev('ArrowRight'))).toBe(false);
  });
});

describe('KeyboardTracker: physical codes (C95)', () => {
  it('matches e.code, so the layout does not matter', () => {
    const k = new KeyboardTracker();
    expect(k.onKeyDown(ev('KeyA', { key: 'q' }), true)).toBe(true);   // AZERTY: the A position types q
    expect(k.dir).toBe(-1);
    k.clear();
    expect(k.onKeyDown(ev('KeyQ', { key: 'a' }), true)).toBe(false);
    expect(k.dir).toBe(0);
    expect(k.onKeyDown(ev('KeyD', { key: 'в' }), true)).toBe(true);   // Cyrillic layout
    expect(k.dir).toBe(1);
  });

  it('releases A even when Option changed its key to å mid-hold', () => {
    const k = new KeyboardTracker();
    k.onKeyDown(ev('KeyA', { key: 'a' }), true);
    expect(k.onKeyUp(ev('KeyA', { key: 'å', altKey: true }))).toBe(true);
    expect(k.dir).toBe(0);
  });

  it('never treats Space or Enter as game keys', () => {
    const k = new KeyboardTracker();
    for (const code of ['Space', 'Enter', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyS']) {
      const e = ev(code);
      expect(k.onKeyDown(e, true)).toBe(false);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(k.dir).toBe(0);
  });
});

describe('KeyboardTracker: modifiers and Meta (C90)', () => {
  it.each([
    ['ctrlKey', { ctrlKey: true }],
    ['metaKey', { metaKey: true }],
    ['altKey', { altKey: true }],
  ] as const)('ignores a keydown with %s', (_name, init) => {
    const k = new KeyboardTracker();
    const e = ev('ArrowLeft', init);
    expect(k.onKeyDown(e, true)).toBe(false);
    expect(k.dir).toBe(0);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('Cmd+A never registers as movement', () => {
    const k = new KeyboardTracker();
    k.onKeyDown(ev('MetaLeft', { key: 'Meta', metaKey: true }), true);
    expect(k.onKeyDown(ev('KeyA', { key: 'a', metaKey: true }), true)).toBe(false);
    // macOS withholds the keyup of A; releasing Cmd must leave nothing held.
    k.onKeyUp(ev('MetaLeft', { key: 'Meta' }));
    expect(k.dir).toBe(0);
  });

  it('clears every held key on a Meta keydown', () => {
    const k = new KeyboardTracker();
    k.onKeyDown(ev('KeyA'), true);
    k.onKeyDown(ev('ArrowRight'), true);
    expect(k.onKeyDown(ev('MetaLeft', { key: 'Meta', metaKey: true }), true)).toBe(true);
    expect(k.dir).toBe(0);
    expect(k.onKeyDown(ev('MetaLeft', { key: 'Meta', metaKey: true, repeat: true }), true)).toBe(false);
  });

  it.each(['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight'])('clears every held key on a %s keyup', (code) => {
    const k = new KeyboardTracker();
    k.onKeyDown(ev('ArrowLeft'), true);
    expect(k.onKeyUp(ev(code, { key: code.startsWith('OS') ? 'OS' : 'Meta' }))).toBe(true);
    expect(k.dir).toBe(0);
  });

  it('releases a key whose keyup carries a modifier', () => {
    const k = new KeyboardTracker();
    k.onKeyDown(ev('ArrowLeft'), true);
    expect(k.onKeyUp(ev('ArrowLeft', { ctrlKey: true }))).toBe(true);
    expect(k.dir).toBe(0);
  });
});

describe('KeyboardTracker: repeats (C18)', () => {
  it('re-adds a key through a repeat keydown after its state was lost', () => {
    const k = new KeyboardTracker();
    k.onKeyDown(ev('ArrowRight'), true);
    k.clear();   // a blur
    expect(k.dir).toBe(0);
    expect(k.onKeyDown(ev('ArrowRight', { repeat: true }), true)).toBe(true);
    expect(k.dir).toBe(1);
    expect(k.onKeyDown(ev('ArrowRight', { repeat: true }), true)).toBe(false);
  });

  it('ignores repeats of a key that is already held, wherever it is in the stack', () => {
    const k = new KeyboardTracker();
    k.onKeyDown(ev('ArrowLeft'), true);
    k.onKeyDown(ev('ArrowRight'), true);
    expect(k.onKeyDown(ev('ArrowLeft', { repeat: true }), true)).toBe(false);
    expect(k.dir).toBe(1);
  });

  it('moves a key to the top on a fresh press when its keyup was lost', () => {
    const k = new KeyboardTracker();
    k.onKeyDown(ev('KeyA'), true);
    k.onKeyDown(ev('KeyD'), true);
    // The keyup of A never arrived; A is pressed again and must win.
    expect(k.onKeyDown(ev('KeyA'), true)).toBe(true);
    expect(k.dir).toBe(-1);
    k.onKeyUp(ev('KeyA'));
    expect(k.dir).toBe(1);
    expect(k.onKeyDown(ev('KeyD'), true)).toBe(false);   // already the newest
  });
});

describe('KeyboardTracker: targets and preventDefault (C91)', () => {
  const ignored: [string, string, string][] = [
    ['a text input', '<input type="text" id="t">', '#t'],
    ['a range input', '<input type="range" id="t">', '#t'],
    ['a textarea', '<textarea id="t"></textarea>', '#t'],
    ['a select', '<select id="t"><option>1</option></select>', '#t'],
    ['a contenteditable element', '<div contenteditable="true" id="t"></div>', '#t'],
    ['a child of a contenteditable element', '<div contenteditable=""><span id="t">x</span></div>', '#t'],
    ['a role=slider element', '<div role="slider" tabindex="0" id="t"></div>', '#t'],
    ['a button inside a dialog', '<dialog open><button id="t">OK</button></dialog>', '#t'],
    ['a button inside a role=dialog', '<div role="dialog"><button id="t">OK</button></div>', '#t'],
    ['a button inside a role=alertdialog', '<div role="alertdialog"><div><button id="t">OK</button></div></div>', '#t'],
  ];

  it.each(ignored)('ignores keys aimed at %s', (_name, html, sel) => {
    const target = mount(html).querySelector(sel);
    const k = new KeyboardTracker();
    const e = ev('ArrowLeft', { target });
    expect(k.onKeyDown(e, true)).toBe(false);
    expect(k.dir).toBe(0);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  const steered: [string, string, string][] = [
    ['a plain button', '<button id="t">Ready</button>', '#t'],
    ['a contenteditable="false" element', '<div contenteditable="false" tabindex="0" id="t"></div>', '#t'],
    ['a canvas', '<canvas id="t"></canvas>', '#t'],
  ];

  it.each(steered)('steers when the target is %s', (_name, html, sel) => {
    const target = mount(html).querySelector(sel);
    const k = new KeyboardTracker();
    const e = ev('ArrowRight', { target });
    expect(k.onKeyDown(e, true)).toBe(true);
    expect(k.dir).toBe(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('treats window, document and null targets as the page', () => {
    for (const target of [window, document, null]) {
      const k = new KeyboardTracker();
      expect(k.onKeyDown(ev('KeyD', { target }), true)).toBe(true);
      expect(k.dir).toBe(1);
    }
  });

  it('calls preventDefault on game keys only while playing, repeats included', () => {
    const k = new KeyboardTracker();
    const lobby = ev('ArrowLeft');
    expect(k.onKeyDown(lobby, false)).toBe(true);   // tracked in every phase
    expect(lobby.preventDefault).not.toHaveBeenCalled();
    k.clear();
    const play = ev('ArrowLeft');
    k.onKeyDown(play, true);
    expect(play.preventDefault).toHaveBeenCalledTimes(1);
    const repeat = ev('ArrowLeft', { repeat: true });
    expect(k.onKeyDown(repeat, true)).toBe(false);
    expect(repeat.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('releases a key whose keyup lands on a form control', () => {
    const input = mount('<input id="t">').querySelector('#t');
    const k = new KeyboardTracker();
    k.onKeyDown(ev('KeyA'), true);
    expect(k.onKeyUp(ev('KeyA', { target: input }))).toBe(true);
    expect(k.dir).toBe(0);
  });
});

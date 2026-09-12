import { describe, expect, it } from 'vitest';
import { attachLifecycle } from './lifecycle';
import { createStore } from '../lib/store';
import { initialAppState } from '../state/appStore';
import { fakeGame, fakeSession } from '../test/fakes/fakeApp';
import type { AudioPort, EnvInput, GameSink, IdentityApi, InputPort, SessionApi } from './types';

class FakeDoc extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
}
class FakeWin extends EventTarget {
  navigator = { onLine: true };
}

function envLabel(e: EnvInput): string {
  return 'persisted' in e ? `session:${e.t}:${e.persisted}` : `session:${e.t}`;
}

function setup(o: { hidden?: boolean; offline?: boolean; pageShow?: Promise<void> } = {}) {
  const log: string[] = [];
  const doc = new FakeDoc();
  const win = new FakeWin();
  if (o.hidden) doc.visibilityState = 'hidden';
  if (o.offline) win.navigator.onLine = false;
  const session: SessionApi = { ...fakeSession(), notifyEnv: (e) => log.push(envLabel(e)) };
  const game: GameSink = { ...fakeGame(), setHeadless: (h) => log.push(`game:headless:${h}`) };
  const audio: AudioPort = { setScene: () => {}, setHidden: (h) => log.push(`audio:hidden:${h}`) };
  const input: InputPort = { resync: () => log.push('input:resync'), halt: () => log.push('input:halt') };
  const identity: IdentityApi = {
    ready: Promise.resolve(), current: () => 'sid', rotate: () => {}, hasPrevious: () => false, restorePrevious: () => false,
    onPageHide: (p) => log.push(`identity:hide:${p}`),
    onPageShow: (p) => {
      log.push(`identity:show:${p}`);
      return o.pageShow ?? Promise.resolve();
    },
  };
  const store = createStore(initialAppState());
  let patches = 0;
  store.subscribe(() => patches++);
  const detach = attachLifecycle(win as unknown as Window, doc as unknown as Document, { session, game, audio, input, identity, store });
  return { log, doc, win, store, detach, patches: () => patches };
}

function pageEvent(type: 'pagehide' | 'pageshow', persisted: boolean): Event {
  const e = new Event(type);
  Object.defineProperty(e, 'persisted', { value: persisted });
  return e;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('attachLifecycle (5.7)', () => {
  it('starts with the store corrected and no port calls on a visible, online page', () => {
    const h = setup();
    expect(h.log).toEqual([]);
    expect(h.store.get().page).toEqual({ visible: true, online: true });
    expect(h.patches()).toBe(0); // nothing changed, so nothing was patched
  });

  it('visibilitychange to hidden goes headless everywhere', () => {
    const h = setup();
    h.doc.visibilityState = 'hidden';
    h.doc.dispatchEvent(new Event('visibilitychange'));
    expect(h.log).toEqual(['session:hidden', 'game:headless:true', 'audio:hidden:true', 'input:halt']);
    expect(h.store.get().page.visible).toBe(false);
  });

  it('visibilitychange to visible goes live again', () => {
    const h = setup({ hidden: true });
    h.log.length = 0;
    h.doc.visibilityState = 'visible';
    h.doc.dispatchEvent(new Event('visibilitychange'));
    expect(h.log).toEqual(['session:visible', 'game:headless:false', 'audio:hidden:false', 'input:resync']);
    expect(h.store.get().page.visible).toBe(true);
  });

  it('pagehide tells the session, hides, and hands the persisted flag to the identity', () => {
    const h = setup();
    h.win.dispatchEvent(pageEvent('pagehide', true));
    expect(h.log).toEqual(['session:pagehide:true', 'game:headless:true', 'audio:hidden:true', 'input:halt', 'identity:hide:true']);
    expect(h.store.get().page.visible).toBe(false);
    h.log.length = 0;
    h.win.dispatchEvent(pageEvent('pagehide', false));
    expect(h.log).toEqual(['session:pagehide:false', 'game:headless:true', 'audio:hidden:true', 'input:halt', 'identity:hide:false']);
  });

  it('a persisted pageshow reclaims the identity lock before the session reconnects', async () => {
    let release: () => void = () => {};
    const pageShow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = setup({ pageShow });
    h.win.dispatchEvent(pageEvent('pagehide', true));
    h.log.length = 0;
    h.win.dispatchEvent(pageEvent('pageshow', true));
    expect(h.log).toEqual(['game:headless:false', 'audio:hidden:false', 'input:resync', 'identity:show:true']);
    expect(h.store.get().page.visible).toBe(true);
    await flush();
    expect(h.log).not.toContain('session:pageshow:true'); // still waiting for the lock
    release();
    await flush();
    expect(h.log.slice(-1)[0]).toBe('session:pageshow:true');
  });

  it('the session still hears pageshow when the identity cannot reclaim its lock', async () => {
    const h = setup({ pageShow: Promise.reject(new Error('lock refused')) });
    h.win.dispatchEvent(pageEvent('pageshow', true));
    await flush();
    expect(h.log.slice(-1)[0]).toBe('session:pageshow:true');
    // The failed reclaim is over, so visibility reaches the session again.
    h.log.length = 0;
    h.doc.dispatchEvent(new Event('visibilitychange'));
    expect(h.log[0]).toBe('session:visible');
  });

  it('a visibilitychange during the lock reclaim goes live but leaves the reopen to pageshow', async () => {
    let release: () => void = () => {};
    const h = setup({ pageShow: new Promise<void>((resolve) => { release = resolve; }) });
    h.win.dispatchEvent(pageEvent('pagehide', true));
    h.log.length = 0;
    h.win.dispatchEvent(pageEvent('pageshow', true));
    h.doc.visibilityState = 'visible';
    h.doc.dispatchEvent(new Event('visibilitychange')); // arrives beside pageshow on a bfcache restore
    await flush();
    expect(h.log).toEqual([
      'game:headless:false', 'audio:hidden:false', 'input:resync', 'identity:show:true',
      'game:headless:false', 'audio:hidden:false', 'input:resync',
    ]); // no 'session:visible': T41 would reopen the socket before the lock is back
    expect(h.store.get().page.visible).toBe(true);
    release();
    await flush();
    expect(h.log.filter((l) => l.startsWith('session:'))).toEqual(['session:pageshow:true']);

    h.log.length = 0;
    h.doc.visibilityState = 'hidden';
    h.doc.dispatchEvent(new Event('visibilitychange'));
    h.doc.visibilityState = 'visible';
    h.doc.dispatchEvent(new Event('visibilitychange'));
    expect(h.log.slice(-4)).toEqual(['session:visible', 'game:headless:false', 'audio:hidden:false', 'input:resync']);
  });

  it('ignores the first load\'s non-persisted pageshow', () => {
    const h = setup();
    h.win.dispatchEvent(pageEvent('pageshow', false));
    expect(h.log).toEqual([]);
  });

  it('freeze and resume go headless and live without touching the page slice', () => {
    const h = setup();
    h.doc.dispatchEvent(new Event('freeze'));
    expect(h.log).toEqual(['session:freeze', 'game:headless:true', 'audio:hidden:true', 'input:halt']);
    h.log.length = 0;
    h.doc.dispatchEvent(new Event('resume'));
    expect(h.log).toEqual(['session:resume', 'game:headless:false', 'audio:hidden:false', 'input:resync']);
    expect(h.patches()).toBe(0);
  });

  it('online and offline reach the session and the page slice only', () => {
    const h = setup();
    h.win.dispatchEvent(new Event('offline'));
    expect(h.log).toEqual(['session:offline']);
    expect(h.store.get().page).toEqual({ visible: true, online: false });
    h.win.dispatchEvent(new Event('online'));
    expect(h.log).toEqual(['session:offline', 'session:online']);
    expect(h.store.get().page).toEqual({ visible: true, online: true });
  });

  it('a page that starts hidden and offline is reported as such at attach', () => {
    const h = setup({ hidden: true, offline: true });
    expect(h.store.get().page).toEqual({ visible: false, online: false });
    expect(h.log).toEqual(['session:offline', 'session:hidden', 'game:headless:true', 'audio:hidden:true', 'input:halt']);
  });

  it('detach removes every listener, and a late pageshow resolution is dropped', async () => {
    let release: () => void = () => {};
    const h = setup({ pageShow: new Promise<void>((resolve) => { release = resolve; }) });
    h.win.dispatchEvent(pageEvent('pageshow', true));
    h.detach();
    h.log.length = 0;
    release();
    await flush();
    h.doc.visibilityState = 'hidden';
    for (const t of ['visibilitychange', 'freeze', 'resume']) h.doc.dispatchEvent(new Event(t));
    for (const t of ['online', 'offline']) h.win.dispatchEvent(new Event(t));
    h.win.dispatchEvent(pageEvent('pagehide', true));
    h.win.dispatchEvent(pageEvent('pageshow', true));
    expect(h.log).toEqual([]);
  });
});

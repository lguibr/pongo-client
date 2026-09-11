// Page lifecycle fan-out (5.7, C72, C73, C74). One place listens to visibility, pagehide and pageshow, freeze
// and resume, and online and offline, and tells each port what it needs. blur and focus belong to the input
// controller. This module is the only writer of the `page` slice.

import type { AppStore } from '../state/appStore';
import type { AudioPort, EnvInput, GameSink, IdentityApi, InputPort, SessionApi } from './types';

export interface LifecyclePorts { session: SessionApi; game: GameSink; audio: AudioPort; input: InputPort; identity: IdentityApi; store: AppStore }

export function attachLifecycle(win: Window, doc: Document, ports: LifecyclePorts): () => void {
  const { session, game, audio, input, identity, store } = ports;
  let attached = true;
  // Persisted pageshows still waiting for identity.onPageShow. While any is pending, 'visible' is not forwarded:
  // T41 would reopen the suspended socket before the id's lock is back. The pageshow that follows applies T38
  // and T41 itself.
  let reclaiming = 0;

  const setPage = (patch: Partial<{ visible: boolean; online: boolean }>): void => {
    const cur = store.get().page;
    const visible = patch.visible ?? cur.visible;
    const online = patch.online ?? cur.online;
    if (visible !== cur.visible || online !== cur.online) store.patch({ page: { visible, online } });
  };

  const goHeadless = (env: EnvInput): void => {
    session.notifyEnv(env);
    game.setHeadless(true);
    audio.setHidden(true);
    input.halt(); // sends Stop
  };

  const goLive = (env: EnvInput): void => {
    session.notifyEnv(env);
    game.setHeadless(false); // snaps the clock
    audio.setHidden(false); // and resumes the context
    input.resync();
  };

  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') {
      goHeadless({ t: 'hidden' });
      setPage({ visible: false });
    } else if (reclaiming > 0) {
      game.setHeadless(false);
      audio.setHidden(false);
      input.resync();
      setPage({ visible: true });
    } else {
      goLive({ t: 'visible' });
      setPage({ visible: true });
    }
  };

  const onPageHide = (e: Event): void => {
    const persisted = (e as PageTransitionEvent).persisted === true;
    goHeadless({ t: 'pagehide', persisted });
    identity.onPageHide(persisted);
    setPage({ visible: false });
  };

  const onPageShow = (e: Event): void => {
    // A non-persisted pageshow is the first load: nothing was hidden, released or suspended.
    if ((e as PageTransitionEvent).persisted !== true) return;
    game.setHeadless(false);
    audio.setHidden(false);
    input.resync();
    setPage({ visible: true });
    // Reclaim the id's lock before the session reopens its socket with that id.
    reclaiming += 1;
    const reopen = (): void => {
      reclaiming -= 1;
      if (attached) session.notifyEnv({ t: 'pageshow', persisted: true });
    };
    identity.onPageShow(true).then(reopen, reopen);
  };

  const onFreeze = (): void => goHeadless({ t: 'freeze' });
  const onResume = (): void => goLive({ t: 'resume' });
  const onOnline = (): void => {
    session.notifyEnv({ t: 'online' });
    setPage({ online: true });
  };
  const onOffline = (): void => {
    session.notifyEnv({ t: 'offline' });
    setPage({ online: false });
  };

  doc.addEventListener('visibilitychange', onVisibility);
  doc.addEventListener('freeze', onFreeze);
  doc.addEventListener('resume', onResume);
  win.addEventListener('pagehide', onPageHide);
  win.addEventListener('pageshow', onPageShow);
  win.addEventListener('online', onOnline);
  win.addEventListener('offline', onOffline);

  // The appStore starts visible and online; correct it, and tell the ports when the page starts otherwise.
  const online = win.navigator?.onLine !== false;
  const visible = doc.visibilityState !== 'hidden';
  setPage({ visible, online });
  if (!online) session.notifyEnv({ t: 'offline' });
  if (!visible) goHeadless({ t: 'hidden' });

  return () => {
    if (!attached) return;
    attached = false;
    doc.removeEventListener('visibilitychange', onVisibility);
    doc.removeEventListener('freeze', onFreeze);
    doc.removeEventListener('resume', onResume);
    win.removeEventListener('pagehide', onPageHide);
    win.removeEventListener('pageshow', onPageShow);
    win.removeEventListener('online', onOnline);
    win.removeEventListener('offline', onOffline);
  };
}

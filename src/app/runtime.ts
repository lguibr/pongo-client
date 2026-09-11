// Composition root (12.3, C84). createApp builds every singleton once, wires the ports between them and returns
// the App. dispose() undoes every step in reverse, and a Vite HMR dispose runs it, so a hot update never leaves a
// second socket, AudioContext, timer or listener behind. If a step throws, the steps already taken are undone
// before the error propagates, so main.tsx shows its static failure page over a page with nothing left running.

import type { App } from './types';
import { createStore } from '../lib/store';
import { safeLocal, safeSession } from '../lib/storage';
import { createSettingsStore, watchReducedMotion } from '../lib/settings';
import { clamp } from '../lib/math';
import { log } from '../lib/log';
import { initialAppState } from '../state/appStore';
import type { AppState } from '../state/appStore';
import { createIdentity } from '../session/identity';
import { createSessionRuntime } from '../session/runtime';
import { attachLifecycle } from '../session/lifecycle';
import { roomOf } from '../session/machine';
import { createGameRuntime } from '../game/runtime';
import { createInputController } from '../input/controller';
import { createAudioEngine } from '../audio/engine';
import { Transport } from '../net/transport';
import { createPwa } from '../ui/pwa/registerSW';
import { wsUrl } from '../config/env';

/** How often the music intensity follows the share of bricks destroyed while playing (12.3). */
export const INTENSITY_INTERVAL_MS = 2000;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function createApp(opts: { win?: Window; doc?: Document } = {}): App {
  const win = opts.win ?? window;
  const doc = opts.doc ?? document;
  const undo: Array<() => void> = [];
  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (let i = undo.length - 1; i >= 0; i--) {
      try {
        undo[i]();
      } catch (err) {
        log.error('app dispose step failed', err); // one broken port must not keep the rest alive
      }
    }
    undo.length = 0;
  };

  try {
    const settings = createSettingsStore(safeLocal);
    const store = createStore(initialAppState());
    // The motion slice's only writer. The dataset mirror lets the setting override the CSS media query too (9.9).
    undo.push(watchReducedMotion(settings, (reduced) => {
      if (store.get().motion.reduced !== reduced) store.patch({ motion: { reduced } });
      doc.documentElement.dataset.motion = reduced ? 'reduced' : 'full';
    }, reducedMotionQuery(win)));

    const identity = createIdentity({ locks: win.navigator.locks ?? null, local: safeLocal, session: safeSession });
    // Releases the id's Web Lock, so an app built after this one in the same document (HMR) keeps the id and the seat.
    // `ready` settles once the boot-time lock is granted, so the second pass releases a grant that arrives after
    // dispose (the sticky id may wait up to identityWaitMs for its lock).
    undo.push(() => {
      identity.onPageHide(true);
      void identity.ready.then(() => identity.onPageHide(true));
    });

    const game = createGameRuntime({ store });
    const input = createInputController();
    const audio = createAudioEngine({ store });
    undo.push(() => {
      audio.dispose().catch((err: unknown) => log.warn('audio dispose failed', err));
    });
    audio.setMix(settings.get());
    // The engine starts at 'off' and only session effects set a scene after this (T52, the admit rows), so a fresh
    // load of / would stay silent after the unlock. From admission on, the session's audio.scene effects take over;
    // a direct /room/CODE load hears the landing pad while it connects.
    audio.setScene('landing');
    undo.push(settings.subscribe(() => audio.setMix(settings.get())));

    const transport = new Transport();
    const session = createSessionRuntime({ transport, game, input, audio, identity, store, wsUrl });
    undo.push(() => session.dispose());

    input.setSink((d) => session.sendDirection(d));
    undo.push(() => input.setSink(null));
    undo.push(session.subscribe(() => {
      const m = session.getModel();
      input.onSession({ s: m.state.s, gen: m.lastGen, epoch: m.epoch, me: roomOf(m)?.myIndex ?? null });
    }));
    game.setIntentSource(() => input.desired);
    undo.push(() => game.setIntentSource(null));
    undo.push(game.onIngestEvents(audio.onEvents));

    // The net slice keeps its identity until `unstable` changes (4.13), so this forwards changes only.
    let net: AppState['net'] = store.get().net;
    undo.push(store.subscribe(() => {
      const next = store.get().net;
      if (next === net) return;
      net = next;
      game.setUnstable(next.unstable);
    }));

    const intensityTimer = setInterval(() => {
      const w = game.summary();
      if (store.get().session.s === 'playing' && w.bricksAtStart) {
        audio.setIntensity(clamp(1 - (w.bricksAlive ?? 0) / w.bricksAtStart, 0, 1));
      }
    }, INTENSITY_INTERVAL_MS);
    undo.push(() => clearInterval(intensityTimer));

    undo.push(input.attach(win));
    undo.push(audio.init(win));
    undo.push(attachLifecycle(win, doc, { session, game, audio, input, identity, store }));

    const pwa = createPwa({ store, session });
    undo.push(() => pwa.dispose());
    pwa.start();

    const app: App = { store, settings, session, game, input, audio, pwa, dispose };
    import.meta.hot?.dispose(() => app.dispose()); // C84
    return app;
  } catch (err) {
    dispose();
    throw err;
  }
}

/** The system reduced-motion query of `win`; undefined lets watchReducedMotion use its own default. */
function reducedMotionQuery(win: Window): MediaQueryList | undefined {
  return typeof win.matchMedia === 'function' ? win.matchMedia(REDUCED_MOTION_QUERY) : undefined;
}

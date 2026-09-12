// WebGL context loss (5.8, D26, C28). A loss waits up to 4 s for a restore, then asks for a remount (a new
// stageKey). Two remounts within 60 s that end in another loss or a creation error give 'failed'. The remount
// history is kept for the page, not per canvas, because every remount is a new canvas and a new attach.
//
// Events reach only the canvas that is current: the detach returned by attachContextLoss runs in the Canvas
// unmount cleanup, before fiber's forced context loss 500 ms later, and after it nothing is reported.

import type * as THREE from 'three';
import type { GfxHealth } from '../state/appStore';
import type { TimerHost } from '../lib/timers';
import type { Now } from '../lib/clock';

export const RESTORE_WAIT_MS = 4000;
export const ESCALATION_WINDOW_MS = 60_000;
export const FAILED_AFTER_REMOUNTS = 2;

const history = { remounts: [] as number[], created: false };

function recentRemounts(now: number): number {
  let n = 0;
  for (const t of history.remounts) if (now - t < ESCALATION_WINDOW_MS) n++;
  return n;
}

function noteRemount(now: number): void {
  history.remounts.push(now);
  if (history.remounts.length > 8) history.remounts.shift();
}

/** A renderer was created: later creation errors are failed remounts, not a missing WebGL. */
export function noteStageCreated(): void {
  history.created = true;
}

export type CreationOutcome = 'unsupported' | 'remount' | 'failed';

/** A renderer could not be created. Before any success on this page WebGL is unsupported; after one it counts as a
 *  failed remount, and the caller remounts until the escalation budget is spent. */
export function noteCreationError(now: number): CreationOutcome {
  if (!history.created) return 'unsupported';
  if (recentRemounts(now) >= FAILED_AFTER_REMOUNTS) return 'failed';
  noteRemount(now);
  return 'remount';
}

/** Forgets the page's graphics history (tests, HMR). */
export function resetGraphicsHistory(): void {
  history.remounts.length = 0;
  history.created = false;
}

function isLost(gl: THREE.WebGLRenderer): boolean {
  try {
    return gl.getContext().isContextLost();
  } catch {
    return true;
  }
}

/** Reports health through onHealth; GameStage is the only writer of the gfx slice. The returned detach runs in
 *  the Canvas unmount cleanup, before fiber's forced context loss 500 ms later. */
export function attachContextLoss(
  canvas: HTMLCanvasElement,
  gl: THREE.WebGLRenderer,
  deps: { onHealth: (h: GfxHealth) => void; timers: TimerHost; now: Now; remount: () => void; restored: () => void },
): () => void {
  let attached = true;
  let lost = false;
  let remounting = false;
  let timer = -1;

  const enterLost = (): void => {
    if (lost || remounting) return;
    lost = true;
    if (recentRemounts(deps.now()) >= FAILED_AFTER_REMOUNTS) {
      deps.onHealth('failed');
      return;
    }
    deps.onHealth('lost');
    timer = deps.timers.setTimeout(() => {
      timer = -1;
      if (!attached || !lost) return;
      remounting = true;
      lost = false;
      noteRemount(deps.now());
      deps.remount();
    }, RESTORE_WAIT_MS);
  };

  const onLost = (e: Event): void => {
    if (!attached) return;
    e.preventDefault();   // required for the browser to offer a restore
    enterLost();
  };

  const onRestored = (): void => {
    if (!attached || remounting || !lost) return;
    if (timer !== -1) {
      deps.timers.clearTimeout(timer);
      timer = -1;
    }
    lost = false;
    deps.onHealth('restoring');
    deps.restored();
  };

  const doc = canvas.ownerDocument as Document | null;
  const onVisibility = (): void => {
    if (!attached || doc === null || doc.visibilityState !== 'visible') return;
    if (isLost(gl)) enterLost();
  };

  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);
  doc?.addEventListener('visibilitychange', onVisibility);

  return () => {
    if (!attached) return;
    attached = false;
    canvas.removeEventListener('webglcontextlost', onLost, false);
    canvas.removeEventListener('webglcontextrestored', onRestored, false);
    doc?.removeEventListener('visibilitychange', onVisibility);
    if (timer !== -1) deps.timers.clearTimeout(timer);
    timer = -1;
  };
}

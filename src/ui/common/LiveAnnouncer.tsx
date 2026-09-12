// Live regions (C107): a polite one for session transitions and notices, an assertive one for the
// countdown. The messages come from `announcements` (roomView.ts, 9.6), computed on store changes; the
// regions are written directly, so announcing never re-renders React. `announce()` lets a view say
// something itself ("Copied").
//
// A modal dialog makes the rest of the page inert, and a live region in inert content is not spoken. So an
// open Dialog pushes a pair of regions of its own (`pushModalRegions`), and while any is open every
// announcement, store-driven or through `announce()`, goes to the top-most pair instead of the shell's.

import { useEffect, useRef } from 'react';
import styled from 'styled-components';
import { useApp } from '../../app/AppContext';
import type { AppState } from '../../state/appStore';
import { announcements, INITIAL_ANNOUNCE_MEMORY } from '../room/roomView';
import type { AnnounceMemory, AnnounceSnapshot } from '../room/roomView';

export type Politeness = 'polite' | 'assertive';
export interface ModalRegions { polite: HTMLElement; assertive: HTMLElement }
type Listener = (text: string, mode: Politeness) => void;

const listeners = new Set<Listener>();
const modalStack: ModalRegions[] = [];
const topModal = (): ModalRegions | undefined => modalStack[modalStack.length - 1];

/** Makes `r` the target of every announcement until the returned function removes it (Dialog, while open). */
// eslint-disable-next-line react-refresh/only-export-components
export function pushModalRegions(r: ModalRegions): () => void {
  modalStack.push(r);
  return () => {
    const i = modalStack.lastIndexOf(r);
    if (i !== -1) modalStack.splice(i, 1);
  };
}

/** True while an open modal dialog holds the announcement regions. */
// eslint-disable-next-line react-refresh/only-export-components
export function modalRegionsOpen(): boolean {
  return modalStack.length > 0;
}

/** Speaks `text` in the top-most open dialog, else through the mounted LiveAnnouncer (a no-op when none is
 *  mounted). */
// eslint-disable-next-line react-refresh/only-export-components
export function announce(text: string, mode: Politeness = 'polite'): void {
  const top = topModal();
  if (top !== undefined) {
    say(top[mode], text);
    return;
  }
  for (const fn of Array.from(listeners)) fn(text, mode);
}

/** Visually hidden but read by assistive technology. Dialog renders its own pair with it. */
export const LiveRegion = styled.div`
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`;

/** Identical text is not re-announced by screen readers, so a repeat gets an invisible difference. */
function say(el: HTMLElement | null, text: string): void {
  if (el === null || text === '') return;
  el.textContent = el.textContent === text ? text + ' ' : text;
}

const snapshot = (s: AppState): AnnounceSnapshot => ({ session: s.session, results: s.results, notices: s.notices });

/** Memory as if the current state had already been announced, so mounting says nothing. */
function primed(s: AnnounceSnapshot): AnnounceMemory {
  const admitted = s.session.s === 'lobby' || s.session.s === 'countdown' || s.session.s === 'playing';
  let last = INITIAL_ANNOUNCE_MEMORY.lastNoticeId;
  for (const n of s.notices) last = Math.max(last, n.id);
  return { admittedCode: admitted ? s.session.code : null, lastNoticeId: last };
}

export function LiveAnnouncer(): JSX.Element {
  const { store } = useApp();
  const politeRef = useRef<HTMLDivElement>(null);
  const assertiveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const shell = (mode: Politeness): HTMLElement | null => (mode === 'assertive' ? assertiveRef.current : politeRef.current);
    const region = (mode: Politeness): HTMLElement | null => topModal()?.[mode] ?? shell(mode);
    let prev = snapshot(store.get());
    let memory = primed(prev);
    const unsubscribe = store.subscribe(() => {
      const next = snapshot(store.get());
      if (next.session === prev.session && next.results === prev.results && next.notices === prev.notices) return;
      const out = announcements(prev, next, memory);
      prev = next;
      memory = out.memory;
      if (out.assertive.length > 0) say(region('assertive'), out.assertive.join(' '));
      if (out.polite.length > 0) say(region('polite'), out.polite.join(' '));
    });
    // announce() reaches this listener only while no dialog is open.
    const listener: Listener = (text, mode) => say(shell(mode), text);
    listeners.add(listener);
    return () => {
      unsubscribe();
      listeners.delete(listener);
    };
  }, [store]);

  return (
    <>
      <LiveRegion ref={politeRef} role="status" aria-live="polite" aria-atomic="true" data-testid="live-polite" />
      <LiveRegion ref={assertiveRef} aria-live="assertive" aria-atomic="true" data-testid="live-assertive" />
    </>
  );
}

// Native <dialog> opened with showModal (C107): the browser traps focus and makes the background inert.
// Focus goes to `initialFocus` (or the dialog), and returns to the element that had it when the dialog
// opened. Escape fires `cancel`, which is always prevented here: `onCancel` decides, and a dialog without
// it (a terminal state) simply stays open.
//
// The browser can still close a dialog on its own: Chromium's close watcher turns a second Escape without
// user activation into a cancel that cannot be prevented. A terminal dialog therefore carries
// closedby="none" and re-opens if it is closed anyway; any other dialog reports that close as a cancel, so
// its owner's `open` state follows the element.
//
// While open, the dialog holds a polite and an assertive live region of its own and pushes them to
// LiveAnnouncer: the shell's regions sit in the inert background, where they would not be spoken.

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import styled from 'styled-components';
import { theme } from '../theme';
import { LiveRegion, pushModalRegions } from './LiveAnnouncer';

export interface DialogProps {
  open: boolean;
  labelledBy: string;
  describedBy?: string;
  onCancel?: () => void;
  initialFocus?: RefObject<HTMLElement>;
  children: ReactNode;
}

const Native = styled.dialog`
  margin: auto;
  width: min(440px, calc(100% - 32px));
  max-height: calc(100% - 32px);
  overflow: auto;
  padding: 24px;
  border: 1px solid ${theme.color.border};
  border-radius: ${theme.size.radius};
  background: ${theme.color.card};
  color: ${theme.color.fg};
  font-family: ${theme.font};
  z-index: ${theme.z.dialog};
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
  /* A dialog rendered inside a pass-through layer (RoomLayout's foreground) would inherit pointer-events: none,
     and so would its ::backdrop. Opt back in, as every other foreground view does. */
  pointer-events: auto;

  &:focus {
    outline: none;
  }
`;

const isOpen = (d: HTMLDialogElement): boolean => d.hasAttribute('open');

function restore(opener: Element | null): void {
  if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
}

function showModal(d: HTMLDialogElement): void {
  try {
    d.showModal();
  } catch {
    d.setAttribute('open', ''); // already open non-modally, or detached
  }
}

export function Dialog({ open, labelledBy, describedBy, onCancel, initialFocus, children }: DialogProps): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const politeRef = useRef<HTMLDivElement>(null);
  const assertiveRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const openRef = useRef(open);
  openRef.current = open;
  const focusRef = useRef(initialFocus);
  focusRef.current = initialFocus;
  const terminal = onCancel === undefined;

  // @types/react 18 has no `closedby` prop, so the attribute is set on the element.
  useLayoutEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (terminal) d.setAttribute('closedby', 'none');
    else d.removeAttribute('closedby');
  }, [terminal]);

  useLayoutEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open) {
      if (!isOpen(d)) {
        opener.current = document.activeElement;
        showModal(d);
      }
      (initialFocus?.current ?? d).focus();
    } else if (isOpen(d)) {
      d.close();
      restore(opener.current);
      opener.current = null;
    }
  }, [open, initialFocus]);

  // Announcements go to this dialog's regions while it is open; the cleanup hands them back on close or unmount.
  useLayoutEffect(() => {
    const polite = politeRef.current;
    const assertive = assertiveRef.current;
    if (!open || polite === null || assertive === null) return;
    return pushModalRegions({ polite, assertive });
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    const onCancelEvent = (e: Event): void => {
      e.preventDefault();
      cancelRef.current?.();
    };
    // Only a close the browser made matters: when this component closes the dialog, `open` is already false.
    const onClose = (): void => {
      if (!openRef.current || isOpen(d)) return;
      const cancel = cancelRef.current;
      if (cancel === undefined) {
        showModal(d);
        (focusRef.current?.current ?? d).focus();
        return;
      }
      restore(opener.current);
      opener.current = null;
      cancel();
    };
    d.addEventListener('cancel', onCancelEvent);
    d.addEventListener('close', onClose);
    return () => {
      d.removeEventListener('cancel', onCancelEvent);
      d.removeEventListener('close', onClose);
      if (isOpen(d)) {
        d.close();
        restore(opener.current);
      }
    };
  }, []);

  return (
    <Native ref={ref} aria-labelledby={labelledBy} aria-describedby={describedBy} tabIndex={-1}>
      {open ? (
        <>
          {children}
          <LiveRegion ref={politeRef} role="status" aria-live="polite" aria-atomic="true" data-testid="dialog-live-polite" />
          <LiveRegion ref={assertiveRef} aria-live="assertive" aria-atomic="true" data-testid="dialog-live-assertive" />
        </>
      ) : null}
    </Native>
  );
}

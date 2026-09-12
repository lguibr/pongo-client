// The touch joystick's view (8.2; C29, C94, C97). It mounts once per room and never re-renders: pointer
// events go straight to the input controller's joystick model, and a rAF loop, running only while a touch is
// active, paints the base and knob from `joystick.knob` in the player's colour. The zone covers the bottom
// 55 % of the game area on devices with any coarse pointer, above the bottom safe area; it is aria-hidden because the
// keyboard is the accessible alternative.

import { useEffect, useRef } from 'react';
import styled from 'styled-components';
import { useApp } from '../../app/AppContext';
import { SEATS } from '../../game/orientation';
import { COLORS } from '../../config/palette';
import { T } from '../../config/tuning';
import { theme } from '../theme';

const KNOB_R = 22;

const Zone = styled.div`
  position: absolute;
  left: 0;
  right: 0;
  bottom: ${theme.safe.b};
  height: 55%;
  z-index: 1;
  display: none;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  pointer-events: auto;

  /* Any coarse pointer, not only the primary one: a touch laptop or a tablet with a trackpad reports a fine
     primary pointer. The joystick model accepts touch and pen only (input/joystick.ts), so mouse drags still
     go to the page (C93). */
  @media (any-pointer: coarse) {
    display: block;
  }
`;

const Base = styled.div`
  position: absolute;
  left: 0;
  top: 0;
  border-radius: 50%;
  border: 2px solid var(--joy, ${COLORS.unownedBall});
  background: rgba(255, 255, 255, 0.06);
  opacity: 0;
  pointer-events: none;
  will-change: transform, opacity;
`;

const Knob = styled.div`
  position: absolute;
  left: 0;
  top: 0;
  width: ${KNOB_R * 2}px;
  height: ${KNOB_R * 2}px;
  border-radius: 50%;
  background: var(--joy, ${COLORS.unownedBall});
  opacity: 0;
  pointer-events: none;
  will-change: transform, opacity;
`;

export function JoystickZone(): JSX.Element {
  const { input, store } = useApp();
  const zoneRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const zone = zoneRef.current;
    const base = baseRef.current;
    const knob = knobRef.current;
    if (zone === null || base === null || knob === null) return;
    const joystick = input.joystick;
    const radius = T.input.joystickRadiusPx;
    base.style.width = `${radius * 2}px`;
    base.style.height = `${radius * 2}px`;

    let color = '';
    const paintColor = (): void => {
      const me = store.get().session.myIndex;
      const next = me === null ? COLORS.unownedBall : SEATS[me].color;
      if (next === color) return;
      color = next;
      zone.style.setProperty('--joy', next);
    };
    paintColor();
    const unsubscribe = store.subscribe(paintColor);

    let raf = 0;
    const paint = (): void => {
      const k = joystick.knob;
      if (k[0] === 1) {
        base.style.opacity = '1';
        knob.style.opacity = '1';
        base.style.transform = `translate3d(${k[1] - radius}px, ${k[2] - radius}px, 0)`;
        knob.style.transform = `translate3d(${k[1] + k[3] - KNOB_R}px, ${k[2] - KNOB_R}px, 0)`;
        raf = requestAnimationFrame(paint);
      } else {
        base.style.opacity = '0';
        knob.style.opacity = '0';
        raf = 0;
      }
    };
    const startPainting = (): void => {
      if (raf === 0) raf = requestAnimationFrame(paint);
    };

    const onDown = (e: PointerEvent): void => {
      // The rect is read at pointer down and never re-read, so a resize cannot re-base the origin (C29).
      if (!joystick.down(e.pointerId, e.clientX, e.clientY, e.pointerType, zone.getBoundingClientRect())) return;
      try {
        zone.setPointerCapture(e.pointerId);
      } catch {
        // The pointer is already gone; its end event will release the joystick.
      }
      e.preventDefault();
      startPainting();
    };
    const onMove = (e: PointerEvent): void => joystick.move(e.pointerId, e.clientX, e.clientY);
    const onEnd = (e: PointerEvent): void => joystick.up(e.pointerId);

    zone.addEventListener('pointerdown', onDown);
    zone.addEventListener('pointermove', onMove);
    zone.addEventListener('pointerup', onEnd);
    zone.addEventListener('pointercancel', onEnd);
    zone.addEventListener('lostpointercapture', onEnd);
    return () => {
      zone.removeEventListener('pointerdown', onDown);
      zone.removeEventListener('pointermove', onMove);
      zone.removeEventListener('pointerup', onEnd);
      zone.removeEventListener('pointercancel', onEnd);
      zone.removeEventListener('lostpointercapture', onEnd);
      unsubscribe();
      if (raf !== 0) cancelAnimationFrame(raf);
      joystick.cancelAll();
    };
  }, [input, store]);

  return (
    <Zone ref={zoneRef} aria-hidden="true" data-testid="joystick-zone">
      <Base ref={baseRef} />
      <Knob ref={knobRef} />
    </Zone>
  );
}

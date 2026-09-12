// Pointer joystick model (8.2). The DOM view (ui/room/JoystickZone.tsx) forwards pointer events here and
// paints from `knob`; this module holds no DOM references.
//
// - Only touch and pen pointers are accepted, so a mouse on a touchscreen laptop cannot fight the
//   keyboard (C93).
// - The origin is the pointer-down point in client coordinates. The base is drawn at the zone-local point
//   computed from the rect read at pointer down, and nothing re-bases it later (C29).
// - A second down from the captured pointer id (a pen stroke whose end event was lost) starts a new gesture
//   from its own point; a down from any other pointer is ignored while one is captured.
// - The axis has hysteresis: from none a direction starts at |x| > enter and returns to none at |x| < exit.
//   A sign change always passes through none (C92).

import type { JoystickModel, Visual } from './types';
import { T } from '../config/tuning';
import { clamp } from '../lib/math';

export interface JoystickOptions { radiusPx: number; enter: number; exit: number; pointerTypes: readonly string[] }

const DEFAULT_POINTER_TYPES: readonly string[] = ['touch', 'pen'];

/** One hysteresis step. Leaving a direction is tested first, so a jump across the centre goes
 *  direction -> none -> opposite direction within the same move. */
function step(state: Visual, x: number, enter: number, exit: number): Visual {
  let s = state;
  if (s === 1 && x < exit) s = 0;
  else if (s === -1 && x > -exit) s = 0;
  if (s === 0) {
    if (x > enter) s = 1;
    else if (x < -enter) s = -1;
  }
  return s;
}

export function createJoystick(opts?: Partial<JoystickOptions>): JoystickModel {
  const radius = opts?.radiusPx ?? T.input.joystickRadiusPx;
  const enter = opts?.enter ?? T.input.enter;
  const exit = opts?.exit ?? T.input.exit;
  const pointerTypes = opts?.pointerTypes ?? DEFAULT_POINTER_TYPES;
  if (!(radius > 0) || !Number.isFinite(radius)) throw new RangeError(`joystick: radiusPx must be positive, got ${radius}`);
  if (!(exit >= 0 && exit < enter && enter <= 1)) {
    throw new RangeError(`joystick: need 0 <= exit < enter <= 1, got exit ${exit}, enter ${enter}`);
  }

  let active = false;
  let pointer = 0;
  let originX = 0;
  let state: Visual = 0;
  let axis: Visual | null = null;
  // [active 0|1, baseX, baseY, dx], zone-local CSS px.
  const knob = new Float32Array(4);

  function end(): void {
    active = false;
    state = 0;
    axis = null;
    knob[0] = 0;
    knob[3] = 0;
  }

  return {
    down(pointerId, clientX, clientY, pointerType, zone) {
      // The first captured pointer wins. A down from that same pointer re-bases instead: a pen reuses its
      // pointerId, and when the previous stroke's end event was lost its moves would otherwise be measured
      // against the stale origin.
      if (active && pointerId !== pointer) return false;
      if (!pointerTypes.includes(pointerType)) return false;
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
      active = true;
      pointer = pointerId;
      originX = clientX;
      state = 0;
      axis = 0;
      knob[0] = 1;
      knob[1] = clientX - zone.left;
      knob[2] = clientY - zone.top;
      knob[3] = 0;
      return true;
    },
    move(pointerId, clientX) {
      if (!active || pointerId !== pointer || !Number.isFinite(clientX)) return;
      const x = clamp((clientX - originX) / radius, -1, 1);
      knob[3] = x * radius;
      state = step(state, x, enter, exit);
      axis = state;
    },
    up(pointerId) {
      if (active && pointerId === pointer) end();
    },
    cancelAll() {
      if (active) end();
    },
    get axis() {
      return axis;
    },
    get knob() {
      return knob;
    },
  };
}

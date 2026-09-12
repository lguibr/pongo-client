import { describe, expect, it } from 'vitest';
import { createJoystick } from './joystick';
import { TUNING } from '../config/tuning';

function rect(left: number, top: number): DOMRectReadOnly {
  return { left, top, right: left + 400, bottom: top + 300, width: 400, height: 300, x: left, y: top, toJSON: () => ({}) };
}

describe('createJoystick: pointer types (C93)', () => {
  it('accepts touch and pen and rejects mouse and unknown types', () => {
    for (const type of ['mouse', '', 'stylus']) {
      const j = createJoystick();
      expect(j.down(1, 100, 100, type, rect(0, 0))).toBe(false);
      expect(j.axis).toBeNull();
      expect(j.knob[0]).toBe(0);
    }
    for (const type of ['touch', 'pen']) {
      const j = createJoystick();
      expect(j.down(1, 100, 100, type, rect(0, 0))).toBe(true);
      expect(j.axis).toBe(0);
    }
  });

  it('ignores moves from a rejected mouse pointer', () => {
    const j = createJoystick();
    j.down(7, 100, 100, 'mouse', rect(0, 0));
    j.move(7, 400, 100);
    expect(j.axis).toBeNull();
  });

  it('honours a custom pointer type list', () => {
    const j = createJoystick({ pointerTypes: ['mouse'] });
    expect(j.down(1, 0, 0, 'touch', rect(0, 0))).toBe(false);
    expect(j.down(1, 0, 0, 'mouse', rect(0, 0))).toBe(true);
  });
});

describe('createJoystick: origin and knob (C29)', () => {
  it('draws the base at the zone-local pointer-down point', () => {
    const j = createJoystick();
    expect(j.axis).toBeNull();
    j.down(1, 300, 700, 'touch', rect(10, 460));
    expect(Array.from(j.knob)).toEqual([1, 290, 240, 0]);
  });

  it('never re-bases the origin: a moved zone only applies at the next pointer down', () => {
    const j = createJoystick();
    j.down(1, 300, 700, 'touch', rect(10, 460));
    // The page resizes and the zone moves; the pointer has not moved, so the axis stays at rest.
    j.move(1, 300, 700);
    expect(j.axis).toBe(0);
    expect(j.knob[1]).toBe(290);
    expect(j.knob[2]).toBe(240);
    j.up(1);
    j.down(2, 300, 700, 'touch', rect(60, 500));
    expect(j.knob[1]).toBe(240);
    expect(j.knob[2]).toBe(200);
  });

  it('clamps the axis to the radius and reports the knob offset in CSS px', () => {
    const j = createJoystick();
    const r = TUNING.input.joystickRadiusPx;
    j.down(1, 500, 500, 'touch', rect(0, 0));
    j.move(1, 500 + r / 2, 500);
    expect(j.knob[3]).toBeCloseTo(r / 2, 5);
    j.move(1, 500 + 4 * r, 500);
    expect(j.knob[3]).toBeCloseTo(r, 5);
    expect(j.axis).toBe(1);
    j.move(1, 500 - 4 * r, 500);
    expect(j.knob[3]).toBeCloseTo(-r, 5);
    expect(j.axis).toBe(-1);
  });

  it('ignores the vertical axis', () => {
    const j = createJoystick();
    j.down(1, 500, 500, 'touch', rect(0, 0));
    j.move(1, 500, 100);
    expect(j.axis).toBe(0);
    expect(j.knob[3]).toBe(0);
  });

  it('ignores non-finite coordinates', () => {
    const j = createJoystick();
    expect(j.down(1, Number.NaN, 0, 'touch', rect(0, 0))).toBe(false);
    j.down(1, 100, 100, 'touch', rect(0, 0));
    j.move(1, Number.POSITIVE_INFINITY, 100);
    expect(j.axis).toBe(0);
    expect(j.knob[3]).toBe(0);
  });
});

describe('createJoystick: hysteresis (C92)', () => {
  // Default radius 56: dx 16 -> 0.286, 17 -> 0.304, 9 -> 0.161, 8 -> 0.143.
  const axisAfter = (dxs: number[]): (number | null)[] => {
    const j = createJoystick();
    j.down(1, 500, 500, 'touch', rect(0, 0));
    return dxs.map((dx) => {
      j.move(1, 500 + dx, 500);
      return j.axis;
    });
  };

  it('uses the tuned radius and thresholds by default', () => {
    expect(TUNING.input).toMatchObject({ joystickRadiusPx: 56, enter: 0.3, exit: 0.15 });
  });

  it('starts a direction only above 0.30 and returns to none only below 0.15', () => {
    expect(axisAfter([16, 17, 9, 12, 8, 16])).toEqual([0, 1, 1, 1, 0, 0]);
    expect(axisAfter([-16, -17, -9, -12, -8, -16])).toEqual([0, -1, -1, -1, 0, 0]);
  });

  it('holds a direction through jitter around the entry threshold', () => {
    const seen = axisAfter([18, 12, 18, 12, 18, 10, 17, 10]);
    expect(seen).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('passes through none on a sign change', () => {
    // From right, a move to -0.18 leaves right but is not yet enough to start left.
    expect(axisAfter([30, -10, -17])).toEqual([1, 0, -1]);
  });

  it('reverses within one move when the jump crosses both thresholds', () => {
    expect(axisAfter([30, -40])).toEqual([1, -1]);
    expect(axisAfter([-30, 40])).toEqual([-1, 1]);
  });

  it('applies custom thresholds and radius', () => {
    const j = createJoystick({ radiusPx: 100, enter: 0.5, exit: 0.2 });
    j.down(1, 0, 0, 'pen', rect(0, 0));
    j.move(1, 45, 0);
    expect(j.axis).toBe(0);
    j.move(1, 51, 0);
    expect(j.axis).toBe(1);
    j.move(1, 21, 0);
    expect(j.axis).toBe(1);
    j.move(1, 19, 0);
    expect(j.axis).toBe(0);
  });

  it('rejects options that cannot form a hysteresis band', () => {
    expect(() => createJoystick({ radiusPx: 0 })).toThrow(RangeError);
    expect(() => createJoystick({ radiusPx: Number.NaN })).toThrow(RangeError);
    expect(() => createJoystick({ enter: 0.2, exit: 0.2 })).toThrow(RangeError);
    expect(() => createJoystick({ enter: 1.5, exit: 0.2 })).toThrow(RangeError);
    expect(() => createJoystick({ enter: 0.3, exit: -0.1 })).toThrow(RangeError);
  });
});

describe('createJoystick: pointer ownership and end', () => {
  it('lets the first captured pointer win and ignores later pointers', () => {
    const j = createJoystick();
    expect(j.down(1, 500, 500, 'touch', rect(0, 0))).toBe(true);
    expect(j.down(2, 100, 100, 'touch', rect(0, 0))).toBe(false);
    j.move(2, 900, 100);
    expect(j.axis).toBe(0);
    j.up(2);
    expect(j.axis).toBe(0);
    j.move(1, 440, 500);
    expect(j.axis).toBe(-1);
    expect(j.knob[1]).toBe(500);
  });

  it('re-bases on a second down from the captured pointer id, whose end event was lost', () => {
    const j = createJoystick();
    expect(j.down(2, 100, 100, 'pen', rect(0, 0))).toBe(true);
    j.move(2, 40, 100);
    expect(j.axis).toBe(-1);
    // No up, cancel or lostpointercapture arrived; the pen starts a new stroke with the same id.
    expect(j.down(2, 300, 100, 'pen', rect(0, 0))).toBe(true);
    expect(j.knob[0]).toBe(1);
    expect(j.knob[1]).toBe(300);
    expect(j.knob[3]).toBe(0);
    expect(j.axis).toBe(0);
    j.move(2, 300, 100);   // resting at the new origin
    expect(j.axis).toBe(0);
    expect(j.knob[3]).toBe(0);
    j.move(2, 310, 100);   // 0.18 from the new origin: from rest this is not a direction
    expect(j.axis).toBe(0);
    j.move(2, 240, 100);
    expect(j.axis).toBe(-1);
    // Another pointer is still refused while the pen holds the stick.
    expect(j.down(5, 100, 100, 'touch', rect(0, 0))).toBe(false);
    expect(j.knob[1]).toBe(300);
  });

  it('ends on up of the captured pointer', () => {
    const j = createJoystick();
    j.down(3, 500, 500, 'touch', rect(0, 0));
    j.move(3, 560, 500);
    expect(j.axis).toBe(1);
    j.up(3);
    expect(j.axis).toBeNull();
    expect(j.knob[0]).toBe(0);
    expect(j.knob[3]).toBe(0);
    j.move(3, 400, 500);
    expect(j.axis).toBeNull();
  });

  it('ends on cancelAll and accepts a new pointer afterwards, starting from rest', () => {
    const j = createJoystick();
    j.down(1, 500, 500, 'touch', rect(0, 0));
    j.move(1, 400, 500);
    expect(j.axis).toBe(-1);
    j.cancelAll();
    expect(j.axis).toBeNull();
    expect(j.knob[0]).toBe(0);
    expect(j.down(2, 200, 200, 'touch', rect(0, 0))).toBe(true);
    expect(j.axis).toBe(0);
    j.move(2, 210, 200);   // 0.18: from rest this is not a direction
    expect(j.axis).toBe(0);
  });
});

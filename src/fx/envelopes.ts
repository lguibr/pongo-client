// Envelopes (6): an effect's intensity as a closed-form function of elapsed presentation time in seconds. Callers
// pass `FrameCtx.fxTimeS - t0`, so an effect looks the same at 30, 60 and 144 Hz (C21, C60, C61) and stands still
// during hit-stop. Nothing here allocates.

import { easeOutBack as easeOutBackUnit, valueNoise1 } from '../lib/math';

/** 0 before t = 0; a linear attack to 1 at `attack`, then a quadratic decay to 0 at `attack + decay`. */
export function attackDecay(t: number, attack: number, decay: number): number {
  if (!(t >= 0)) return 0;
  if (t < attack) return t / attack;
  if (!(decay > 0)) return 0;
  const d = (t - attack) / decay;
  if (d >= 1) return 0;
  const u = 1 - d;
  return u * u;
}

/** The unit step response of a damped spring with angular frequency `omega` (rad/s) and damping ratio `zeta`:
 *  0 at t = 0, settling at 1. Below critical damping it overshoots. 0 before t = 0. */
export function springStep(t: number, omega: number, zeta: number): number {
  if (!(t > 0)) return 0;
  if (!(omega > 0)) return 1;
  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const a = zeta * omega;
    return 1 - Math.exp(-a * t) * (Math.cos(wd * t) + (a / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) return 1 - (1 + omega * t) * Math.exp(-omega * t);
  const s = Math.sqrt(zeta * zeta - 1);
  const r1 = -omega * (zeta - s);
  const r2 = -omega * (zeta + s);
  // x(0) = -1 and x'(0) = 0 relative to the target
  const c2 = r1 / (r2 - r1);
  const c1 = -1 - c2;
  return 1 + c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t);
}

/** Ease-out-back from 0 to 1 over `dur` seconds (overshoot 1.70158 by default); 0 before t = 0, 1 after. */
export function easeOutBack(t: number, dur: number, overshoot = 1.70158): number {
  if (!(t > 0)) return 0;
  if (t >= dur) return 1;
  return easeOutBackUnit(t / dur, overshoot);
}

/** 1 until `dur - tail`, then linear to 0 at `dur`; 0 outside [0, dur]. */
export function fadeOut(t: number, dur: number, tail: number): number {
  if (!(t >= 0) || t >= dur) return 0;
  const from = dur - tail;
  return t <= from ? 1 : (dur - t) / tail;
}

/** A deterministic flicker in 0.3..1 at about `hz` changes per second: value noise, so the same t always gives the
 *  same value, whatever the frame rate. */
export function flicker(t: number, hz: number, seed: number): number {
  return 0.65 + 0.35 * valueNoise1(t * hz, seed);
}

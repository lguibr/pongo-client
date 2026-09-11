import { describe, expect, it } from 'vitest';
import { POLICY, backoff, classifyReason } from './policy';
import { TUNING } from '../config/tuning';
import { seeded } from '../lib/random';
import type { ReasonClass } from './types';

describe('classifyReason', () => {
  const table: Array<[string, ReasonClass]> = [
    ['Room not found', 'room-gone'],
    ['Room is closing', 'room-gone'],
    ['Room closed during admission', 'room-gone'],
    ['Room is full', 'room-full'],
    ['Server is full', 'server-full'],
    ['Session admission is pending', 'pending'],
    ['Session already connected', 'busy'],
    ['Server is stopping', 'transient'],
    ['Room is unavailable', 'transient'],
    ['Invalid connection', 'transient'],
    ['Connection closed', 'transient'],
    ['Admission failed', 'transient'],
  ];

  it.each(table)('classifies %j as %s', (reason, cls) => {
    expect(classifyReason(reason)).toBe(cls);
  });

  it('gives unknown for anything else', () => {
    expect(classifyReason('')).toBe('unknown');
    expect(classifyReason('Something new')).toBe('unknown');
    expect(classifyReason('room not found')).toBe('unknown'); // the server's strings are exact
  });

  it('ignores surrounding whitespace', () => {
    expect(classifyReason(' Room is full\n')).toBe('room-full');
  });
});

describe('backoff', () => {
  const fixed = (v: number) => () => v;

  it('stays within [step/2, step] for attempts 0 to 10', () => {
    const rand = seeded(42);
    for (const [base, cap] of [[500, 4000], [400, 5000]] as const) {
      for (let attempt = 0; attempt <= 10; attempt++) {
        const step = Math.min(cap, base * 2 ** attempt);
        for (let i = 0; i < 200; i++) {
          const d = backoff(attempt, base, cap, rand);
          expect(d).toBeGreaterThanOrEqual(Math.floor(step / 2));
          expect(d).toBeLessThanOrEqual(step);
        }
      }
    }
  });

  it('uses equal jitter: half the step is fixed, half is random', () => {
    expect(backoff(0, 500, 4000, fixed(0))).toBe(250);
    expect(backoff(0, 500, 4000, fixed(0.5))).toBe(375);
    expect(backoff(2, 500, 4000, fixed(0))).toBe(1000);
    expect(backoff(2, 500, 4000, fixed(0.999999))).toBe(2000);
  });

  it('caps the step', () => {
    expect(backoff(3, 500, 4000, fixed(0))).toBe(2000);
    expect(backoff(4, 500, 4000, fixed(0))).toBe(2000);
    expect(backoff(60, 400, 5000, fixed(0.5))).toBe(3750);
    expect(backoff(2000, 400, 5000, fixed(0))).toBe(2500); // 2^2000 overflows to Infinity; the cap still holds
  });

  it('treats a negative attempt as the first', () => {
    expect(backoff(-3, 500, 4000, fixed(0))).toBe(250);
  });
});

describe('POLICY', () => {
  it('mirrors T.session', () => {
    const s = TUNING.session;
    expect(POLICY).toEqual({
      connectTimeoutMs: s.connectTimeoutMs,
      admissionTimeoutMs: s.admissionTimeoutMs,
      preAdmit: s.preAdmit,
      inRoom: s.inRoom,
      busyDelaysMs: s.busyDelaysMs,
      pendingDelaysMs: s.pendingDelaysMs,
      serverFullDelaysMs: s.serverFullDelaysMs,
      transientMaxInRow: s.transientMaxInRow,
      liveness: s.liveness,
      badFrames: s.badFrames,
      firstRetryMaxMs: s.firstRetryMaxMs,
      onlineRetryMaxMs: s.onlineRetryMaxMs,
    });
    expect(POLICY.inRoom.onlineBudgetMs).toBe(90000);
    expect(POLICY.busyDelaysMs).toEqual([1500, 3000, 6000]);
  });
});

// Every tunable number lives here; no other file may hard-code these values.
// In DEV, `?tune=path:value,path:value` overrides values, for example
// `?tune=hitStop.enabled:0,playout.minDelayMs:40`. Booleans take 0/1/true/false; number arrays take
// values joined by `|` (`session.busyDelaysMs:1000|2000`). Production ignores overrides.

import type { Tier } from '../render/contracts';
import { log } from '../lib/log';

export interface Tuning {
  playout: {
    baseDelayMs: number; jitterGain: number; minDelayMs: number; maxDelayMs: number; jitterAlpha: number;
    delaySlewPerMs: number; slewMax: number; slewGainPerMs: number; snapMs: number; idleMs: number;
    maxExtrapMs: number; dtClampMs: number; staleMs: number;
  };
  hitStop: { enabled: boolean; goalConcededMs: number; lastBrickMs: number; maxPerEventMs: number; maxPerSecondMs: number; repayRate: number };
  ownLead: { enabled: boolean; maxPx: number; speedPxPerS: number; bleedTauS: number };
  session: {
    connectTimeoutMs: number; admissionTimeoutMs: number;
    preAdmit: { baseMs: number; capMs: number; maxAttempts: number };
    inRoom: { baseMs: number; capMs: number; onlineBudgetMs: number };
    busyDelaysMs: readonly number[]; pendingDelaysMs: readonly number[]; serverFullDelaysMs: readonly number[];
    transientMaxInRow: number;
    liveness: { lobbyMs: number; playHardMs: number; playSoftMs: number; offlineMs: number; resumeGraceMs: number };
    badFrames: { count: number; windowMs: number };
    firstRetryMaxMs: number; onlineRetryMaxMs: number; identityWaitMs: number; identityReadyMaxMs: number;
    rejoinWindowMs: number; noticeTtlMs: number;
  };
  input: { joystickRadiusPx: number; enter: number; exit: number; tokensPerSecond: number; burst: number };
  audio: {
    voicesTotal: number; retriggerMs: number; maxLeadS: number; staleS: number; sfxGainScale: number;
    limiterThresholdDb: number; limiterRatio: number; goalDuckDb: number; goalDuckS: number; hiddenFadeS: number;
  };
  fx: {
    confidenceMin: number; goalMergeTicks: number; chainWindowTicks: number;
    pools: Record<Tier, { sparks: number; shards: number; rings: number; decals: number; trailPoints: number }>;
    spawnScale: Record<Tier, number>;
  };
  quality: { dpr: Record<Tier, number>; windowMs: number; downFactor: number; downWindows: number; upFactor: number; upWindows: number };
  camera: { fovDeg: number; tilt: number; margin: number; headroom: number; introScale: number; introTilt: number; gameOverScale: number; lobbyOrbitDeg: number; rotationEaseMs: number };
  render: { lobbyFps: number; endEffectsMs: number };
  derive: { missingPaddleTicks: number; phaseRetriggerSlackMs: number; goalOverlapSlackPx: number };
}

export const TUNING: Tuning = {
  playout: {
    baseDelayMs: 30, jitterGain: 2.5, minDelayMs: 35, maxDelayMs: 120, jitterAlpha: 0.1,
    delaySlewPerMs: 0.02, slewMax: 0.08, slewGainPerMs: 0.002, snapMs: 200, idleMs: 100,
    maxExtrapMs: 50, dtClampMs: 50, staleMs: 250,
  },
  hitStop: { enabled: true, goalConcededMs: 70, lastBrickMs: 90, maxPerEventMs: 90, maxPerSecondMs: 150, repayRate: 0.25 },
  ownLead: { enabled: false, maxPx: 24, speedPxPerS: 480, bleedTauS: 0.06 },
  session: {
    connectTimeoutMs: 8000, admissionTimeoutMs: 8000,
    preAdmit: { baseMs: 500, capMs: 4000, maxAttempts: 5 },
    inRoom: { baseMs: 400, capMs: 5000, onlineBudgetMs: 90000 },
    busyDelaysMs: [1500, 3000, 6000],
    pendingDelaysMs: [400, 800, 1200, 1600, 2000],
    serverFullDelaysMs: [5000, 10000, 20000],
    transientMaxInRow: 3,
    liveness: { lobbyMs: 20000, playHardMs: 5000, playSoftMs: 1200, offlineMs: 3000, resumeGraceMs: 2500 },
    badFrames: { count: 20, windowMs: 5000 },
    firstRetryMaxMs: 250, onlineRetryMaxMs: 500, identityWaitMs: 500, identityReadyMaxMs: 1000,
    rejoinWindowMs: 30000, noticeTtlMs: 6000,
  },
  input: { joystickRadiusPx: 56, enter: 0.3, exit: 0.15, tokensPerSecond: 30, burst: 8 },
  audio: {
    voicesTotal: 16, retriggerMs: 35, maxLeadS: 0.15, staleS: 0.25, sfxGainScale: 0.35,
    limiterThresholdDb: -10, limiterRatio: 8, goalDuckDb: -6, goalDuckS: 0.3, hiddenFadeS: 0.05,
  },
  fx: {
    confidenceMin: 0.7, goalMergeTicks: 10, chainWindowTicks: 12,
    pools: {
      high: { sparks: 2048, shards: 512, rings: 64, decals: 64, trailPoints: 32 },
      medium: { sparks: 1024, shards: 256, rings: 48, decals: 48, trailPoints: 24 },
      low: { sparks: 384, shards: 128, rings: 32, decals: 32, trailPoints: 12 },
    },
    spawnScale: { high: 1.0, medium: 0.6, low: 0.3 },
  },
  quality: { dpr: { high: 2, medium: 1.5, low: 1 }, windowMs: 2000, downFactor: 1.35, downWindows: 3, upFactor: 0.8, upWindows: 10 },
  camera: {
    fovDeg: 16, tilt: -0.55, margin: 1.06, headroom: 220, introScale: 1.35, introTilt: -0.75,
    gameOverScale: 1.12, lobbyOrbitDeg: 2, rotationEaseMs: 500,
  },
  render: { lobbyFps: 20, endEffectsMs: 3000 },
  // Split matching uses the server constant SPAWN_JITTER_PX (constants.ts), not a tunable.
  derive: { missingPaddleTicks: 3, phaseRetriggerSlackMs: 200, goalOverlapSlackPx: 1 },
};

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

function deepCopy<V>(v: V): V {
  if (Array.isArray(v)) return v.map((x: unknown) => deepCopy(x)) as V;
  if (isRecord(v)) {
    const out: Rec = {};
    for (const k of Object.keys(v)) out[k] = deepCopy(v[k]);
    return out as V;
  }
  return v;
}

/** Parses `raw` into the type of `current`; undefined when it does not fit. */
function parseLike(current: unknown, raw: string): unknown {
  if (typeof current === 'boolean') {
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return undefined;
  }
  if (typeof current === 'number') {
    const n = raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (Array.isArray(current) && current.every((x) => typeof x === 'number')) {
    const parts = raw.split('|').map((p) => (p.trim() === '' ? NaN : Number(p)));
    return parts.length > 0 && parts.every(Number.isFinite) ? parts : undefined;
  }
  return undefined;
}

function setPath(root: Rec, keys: readonly string[], raw: string): boolean {
  let node: unknown = root;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isRecord(node) || !Object.prototype.hasOwnProperty.call(node, keys[i])) return false;
    node = node[keys[i]];
  }
  const leaf = keys[keys.length - 1];
  if (!isRecord(node) || !Object.prototype.hasOwnProperty.call(node, leaf)) return false;
  const next = parseLike(node[leaf], raw);
  if (next === undefined) return false;
  node[leaf] = next;
  return true;
}

/** Returns a deep copy of `base` with the `tune` query parameter applied. Unknown paths and values that
 *  do not match the existing type are ignored with a warning. */
export function applyDevOverrides(search: string, base: Tuning): Tuning {
  const copy = deepCopy(base);
  const spec = new URLSearchParams(search).get('tune');
  if (!spec) return copy;
  for (const pair of spec.split(',')) {
    const sep = pair.lastIndexOf(':');
    const path = sep > 0 ? pair.slice(0, sep).trim() : '';
    if (path === '' || !setPath(copy as unknown as Rec, path.split('.'), pair.slice(sep + 1).trim())) {
      log.warn(`tune: ignored "${pair}"`);
    }
  }
  return copy;
}

export const T: Tuning = import.meta.env.DEV && typeof location !== 'undefined' ? applyDevOverrides(location.search, TUNING) : TUNING;

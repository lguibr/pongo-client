// Math helpers. Everything here is allocation-free, so it is safe on the per-frame path.

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach: after `halfLifeS` seconds, half of the gap remains. */
export function damp(current: number, target: number, halfLifeS: number, dtS: number): number {
  if (halfLifeS <= 0) return target;
  return target + (current - target) * Math.pow(2, -dtS / halfLifeS);
}

export function easeOutCubic(t: number): number {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
}

export function easeOutBack(t: number, overshoot = 1.70158): number {
  const u = clamp(t, 0, 1) - 1;
  return 1 + (overshoot + 1) * u * u * u + overshoot * u * u;
}

function lattice(i: number, seed: number): number {
  let h = Math.imul(i ^ Math.imul(seed | 0, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/** Smooth 1-D value noise in -1..1, with lattice points at integer t. */
export function valueNoise1(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const s = f * f * (3 - 2 * f);
  return lerp(lattice(i, seed), lattice(i + 1, seed), s);
}

function channel(hex: string, i: number, short: boolean): number {
  const v = short ? parseInt(hex[i] + hex[i], 16) : parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Euclidean distance between two sRGB hex colours ('#rgb' or '#rrggbb') in OKLab. NaN for bad input. */
export function oklabDistance(hexA: string, hexB: string): number {
  const a = hexA.replace(/^#/, '');
  const b = hexB.replace(/^#/, '');
  const valid = (h: string): boolean => /^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(h);
  if (!valid(a) || !valid(b)) return NaN;
  const sa = a.length === 3;
  const sb = b.length === 3;
  const la0 = oklabL(channel(a, 0, sa), channel(a, 1, sa), channel(a, 2, sa));
  const la1 = oklabA;
  const la2 = oklabB;
  const lb0 = oklabL(channel(b, 0, sb), channel(b, 1, sb), channel(b, 2, sb));
  const dl = la0 - lb0;
  const da = la1 - oklabA;
  const db = la2 - oklabB;
  return Math.sqrt(dl * dl + da * da + db * db);
}

// oklabL writes the a and b components here, so the conversion allocates nothing.
let oklabA = 0;
let oklabB = 0;

function oklabL(r: number, g: number, b: number): number {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  oklabA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  oklabB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

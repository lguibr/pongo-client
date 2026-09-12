// Score pops (D14): a pooled DOM layer of 16 spans over the canvas, projected every frame in lateUpdate (after the
// camera) and changed through transform and opacity only. A new pop takes the next span in ring order, so the oldest
// is stolen first. Styles are written only when a value changed. VT323 with a glow in the pop's colour; the layer and
// every span are aria-hidden (the scoreboard carries the information). Under reduced motion pops keep their text,
// colour and fade, but neither rise nor scale (6.3).

import * as THREE from 'three';
import type { FrameCtx, FxHost } from '../render/contracts';
import { easeOutBack, fadeOut } from './envelopes';

const DEFAULT_SIZE = 16;
const BASE_PX = 26;
const RISE_PX = 40;
const POP_IN_S = 0.16;
const FADE_TAIL = 0.4;     // share of a pop's life spent fading out
const SCALE_Q = 250;       // the written scale moves in steps of 1/250 = 0.004
const HIDDEN = 'translate3d(-9999px,-9999px,0)';
const SPAN_CSS = 'position:absolute;left:0;top:0;margin:0;padding:0;pointer-events:none;user-select:none;white-space:nowrap;'
  + 'line-height:1;font-family:"VT323",ui-monospace,monospace;font-size:26px;opacity:0;will-change:transform,opacity;'
  + `transform:${HIDDEN}`;

export class PopLayer {
  private readonly host: FxHost;
  private readonly size: number;
  private readonly spans: HTMLElement[] = [];
  private readonly born: Float64Array;
  private readonly dur: Float64Array;
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;
  private readonly lastX: Float64Array;
  private readonly lastY: Float64Array;
  private readonly lastS: Float64Array;
  private readonly lastO: Float64Array;
  private readonly keys: Int32Array;
  private readonly live: Uint8Array;
  private readonly v = new THREE.Vector3();
  private readonly proj = { sx: 0.5, sy: 0.5, visible: false };
  private next = 0;
  private time = 0.5;

  constructor(host: FxHost, size = DEFAULT_SIZE) {
    this.host = host;
    this.size = size > 0 ? Math.floor(size) : DEFAULT_SIZE;
    const n = this.size;
    this.born = new Float64Array(n);
    this.dur = new Float64Array(n).fill(1);
    this.px = new Float64Array(n);
    this.py = new Float64Array(n);
    this.pz = new Float64Array(n);
    this.lastX = new Float64Array(n);
    this.lastY = new Float64Array(n);
    this.lastS = new Float64Array(n);
    this.lastO = new Float64Array(n);
    this.keys = new Int32Array(n).fill(-1);
    this.live = new Uint8Array(n);
    const doc = host.popLayer.ownerDocument;
    for (let i = 0; i < n; i++) {
      const el = doc.createElement('span');
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = SPAN_CSS;
      host.popLayer.appendChild(el);
      this.spans.push(el);
    }
  }

  /** Pops alive at the last lateUpdate or show. */
  get liveCount(): number {
    let n = 0;
    for (let i = 0; i < this.size; i++) n += this.live[i];
    return n;
  }

  /** The text of the live pop with `key`, or null (tests and tools). */
  textOf(key: number): string | null {
    for (let i = 0; i < this.size; i++) if (this.live[i] === 1 && this.keys[i] === key) return this.spans[i].textContent;
    return null;
  }

  /** Presentation time for the next show (the director sets it from FrameCtx.fxTimeS before showing). */
  setTime(t: number): void {
    this.time = t;
  }

  /** Shows `text` at canvas px (x, y) and board height z, in CSS colour `color`, at `scale` x 26 px, for `seconds`.
   *  A non-negative `key` names the pop for update(); a live pop with the same key is replaced. */
  show(text: string, x: number, y: number, z: number, color: string, scale: number, seconds: number, key = -1): void {
    if (key >= 0) {
      for (let j = 0; j < this.size; j++) if (this.live[j] === 1 && this.keys[j] === key) this.hide(j);
    }
    const i = this.next;
    this.next = i + 1 === this.size ? 0 : i + 1;
    const el = this.spans[i];
    el.textContent = text;
    el.style.color = color;
    el.style.textShadow = `0 0 6px ${color},0 0 16px ${color}`;
    el.style.fontSize = `${Math.round(BASE_PX * (scale > 0.2 ? scale : 0.2))}px`;
    this.host.toBoard(x, y, z, this.v);
    this.px[i] = this.v.x;
    this.py[i] = this.v.y;
    this.pz[i] = this.v.z;
    this.born[i] = this.time;
    this.dur[i] = seconds > 0.05 ? seconds : 0.05;
    this.keys[i] = key;
    this.live[i] = 1;
    this.lastO[i] = -1;
    this.lastS[i] = -1;
  }

  /** Changes the text of the live pop with `key` and restarts its life (C47 goal repeats: "-2", "-3"); false when
   *  no such pop is alive. Nothing new spawns. */
  update(key: number, text: string): boolean {
    for (let i = 0; i < this.size; i++) {
      if (this.live[i] !== 1 || this.keys[i] !== key) continue;
      this.spans[i].textContent = text;
      this.born[i] = this.time - POP_IN_S;
      return true;
    }
    return false;
  }

  /** Projects every live pop with the final camera of the frame. */
  lateUpdate(ctx: FrameCtx): void {
    const t = ctx.fxTimeS;
    this.time = t;
    const reduced = ctx.reducedMotion;
    for (let i = 0; i < this.size; i++) {
      if (this.live[i] !== 1) continue;
      const e = t - this.born[i];
      const d = this.dur[i];
      if (e >= d) {
        this.hide(i);
        continue;
      }
      this.v.set(this.px[i], this.py[i], this.pz[i]);
      this.host.project(this.v, this.proj);
      const el = this.spans[i];
      const o = this.proj.visible ? fadeOut(e < 0 ? 0 : e, d, d * FADE_TAIL) : 0;
      if (o !== this.lastO[i]) {
        el.style.opacity = o.toFixed(3);
        this.lastO[i] = o;
      }
      if (o === 0) continue;
      const k = e / d;
      const rise = reduced ? 0 : RISE_PX * (1 - (1 - k) * (1 - k));
      // Quantised (0.5 px, scale steps of 0.004) and compared exactly, so the written style is a function of
      // presentation time alone and matches at every frame rate, while unchanged values still skip the write.
      const s = reduced ? 1 : Math.round((0.4 + 0.6 * easeOutBack(e, POP_IN_S)) * SCALE_Q) / SCALE_Q;
      const sx = Math.round(this.proj.sx * 2) / 2;
      const sy = Math.round((this.proj.sy - rise) * 2) / 2;
      if (sx !== this.lastX[i] || sy !== this.lastY[i] || s !== this.lastS[i]) {
        el.style.transform = `translate3d(${sx}px,${sy}px,0) translate(-50%,-50%) scale(${s.toFixed(3)})`;
        this.lastX[i] = sx;
        this.lastY[i] = sy;
        this.lastS[i] = s;
      }
    }
  }

  clear(): void {
    for (let i = 0; i < this.size; i++) if (this.live[i] === 1) this.hide(i);
    this.next = 0;
  }

  dispose(): void {
    for (const el of this.spans) el.parentNode?.removeChild(el);
    this.spans.length = 0;
    this.live.fill(0);
  }

  private hide(i: number): void {
    this.live[i] = 0;
    this.keys[i] = -1;
    const el = this.spans[i];
    el.style.opacity = '0';
    el.style.transform = HIDDEN;
    this.lastO[i] = 0;
  }
}

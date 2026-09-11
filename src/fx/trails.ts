// Ball trails (E36, D13, C61): time-sampled ribbons, one draw for all balls. Once per sample interval of presentation
// time the CPU commits one point per ball, interpolated between the ball's positions on the two frames around that
// instant, so the committed samples are the same at 30, 60 and 144 Hz. The interval is max(8 ms, 320 ms / (P - 2))
// for the tier's P points (about 10.7 ms at 32, 14.5 ms at 24, 32 ms at 12), so every tier holds 320 ms of history:
// the phasing trail (E36) and the 40-120 ms echoes (E34) survive the low tier. Point 0 is the live head at the ball;
// points 1..P-1 are the committed samples, newest first (older points shift down, so the strip never wraps). Each
// point keeps the colour it was sampled with, so an ownership change sweeps along the ribbon. Length is 120-220 ms by
// speed, 320 ms while phasing, halved under reduced motion. A tier change keeps every live trail and its samples.
//
// Every frame changes the head of every live trail, so the attributes upload whole (about 130 KB at the high tier):
// three r176's range upload allocates a sort closure per upload (see render/materials/patch.ts markRange).

import * as THREE from 'three';
import type { FrameCtx } from '../render/contracts';
import type { RenderState } from '../game/types';
import { BALL_STRIDE, BO, BallVis } from '../game/types';
import { MAX_BALLS } from '../config/constants';
import { COLORS, HDR, PLAYER_COLORS } from '../config/palette';
import type { FxUniforms } from './pools/gpuPool';
import { DEAD_T0, markWhole } from './pools/gpuPool';
import { TRAIL_FRAGMENT, TRAIL_VERTEX } from './shaders/trail';

/** The shortest interval (s of presentation time) between committed samples; fewer points lengthen it. */
export const TRAIL_SAMPLE_S = 0.008;
/** Colour indices in the trail palette. */
export const TrailColor = { Unowned: 4, Phase: 5 } as const;

const LEN_MIN_S = 0.12;
const LEN_MAX_S = 0.22;
const LEN_PHASE_S = 0.32;
const SPEED_LO = 5;           // board units per tick (the server's minimum ball speed)
const SPEED_HI = 10;
const WIDTH = 0.9;            // ribbon width / ball radius
const JUMP2 = 80 * 80;        // a head move longer than this (board units) is a teleport: the trail restarts

export interface TrailPoint { x: number; y: number; z: number }

export class TrailSystem {
  readonly object: THREE.Mesh;
  readonly maxPoints: number;
  private readonly render: Readonly<RenderState>;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly pos: Float32Array;   // 3 per vertex: point centre
  private readonly q: Float32Array;     // 4 per vertex: normal x, y, half width, colour index
  private readonly t: Float32Array;     // 1 per vertex: sample time
  private readonly posAttr: THREE.BufferAttribute;
  private readonly qAttr: THREE.BufferAttribute;
  private readonly tAttr: THREE.BufferAttribute;
  /** Trail length per slot (s); the uLen uniform. */
  readonly len = new Float32Array(MAX_BALLS);
  private readonly ids = new Int32Array(MAX_BALLS).fill(-1);
  private readonly on = new Uint8Array(MAX_BALLS);
  private readonly nextSample = new Float64Array(MAX_BALLS);
  private readonly lastX = new Float64Array(MAX_BALLS);
  private readonly lastY = new Float64Array(MAX_BALLS);
  private readonly lastT = new Float64Array(MAX_BALLS);
  private readonly headT = new Float64Array(MAX_BALLS);
  private points = 2;
  /** Seconds between committed samples for the tier's point count. */
  private sampleS = TRAIL_SAMPLE_S;
  private highActive = 0;
  private activeN = 0;
  private now = 0.5;
  private uploadNext = true;

  constructor(render: Readonly<RenderState>, u: FxUniforms, maxPoints: number, points: number) {
    this.render = render;
    this.maxPoints = maxPoints < 3 ? 3 : Math.floor(maxPoints);
    const verts = MAX_BALLS * this.maxPoints * 2;
    this.pos = new Float32Array(verts * 3);
    this.q = new Float32Array(verts * 4);
    this.t = new Float32Array(verts).fill(DEAD_T0);
    const side = new Float32Array(verts * 2);
    for (let v = 0; v < verts; v++) {
      side[v * 2] = (v & 1) === 0 ? -1 : 1;
      side[v * 2 + 1] = Math.floor(v / (this.maxPoints * 2));
    }
    const segs = this.maxPoints - 1;
    const index = new Uint16Array(MAX_BALLS * segs * 6);
    let k = 0;
    for (let slot = 0; slot < MAX_BALLS; slot++) {
      for (let i = 0; i < segs; i++) {
        const a = (slot * this.maxPoints + i) * 2;
        const b = a + 2;
        index[k++] = a;
        index[k++] = b;
        index[k++] = a + 1;
        index[k++] = a + 1;
        index[k++] = b;
        index[k++] = b + 1;
      }
    }
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.qAttr = new THREE.BufferAttribute(this.q, 4).setUsage(THREE.DynamicDrawUsage);
    this.tAttr = new THREE.BufferAttribute(this.t, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('aQ', this.qAttr);
    g.setAttribute('aT', this.tAttr);
    g.setAttribute('aS', new THREE.BufferAttribute(side, 2));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1200);
    this.geometry = g;

    const colors = new Float32Array(18);
    const c = new THREE.Color();
    for (let i = 0; i < 4; i++) {
      c.set(PLAYER_COLORS[i]).multiplyScalar(HDR.trail);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    c.set(COLORS.unownedBall).multiplyScalar(HDR.ballCoreUnowned);   // an unowned ball does not bloom (E06)
    colors[12] = c.r;
    colors[13] = c.g;
    colors[14] = c.b;
    c.set(COLORS.phase).multiplyScalar(HDR.trail);
    colors[15] = c.r;
    colors[16] = c.g;
    colors[17] = c.b;
    this.material = new THREE.ShaderMaterial({
      name: 'fxTrails',
      uniforms: { uFxTime: u.uFxTime, uHdr: u.uHdr, uLen: { value: this.len }, uColors: { value: colors } },
      vertexShader: TRAIL_VERTEX,
      fragmentShader: TRAIL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.Mesh(g, this.material);
    this.object.name = 'fxTrails';
    this.object.frustumCulled = false;
    this.object.matrixAutoUpdate = false;
    this.object.renderOrder = 3;
    this.setPoints(points);
  }

  /** Trails drawn this frame. */
  get active(): number {
    return this.activeN;
  }

  /** Points per trail for the tier (3..maxPoints), and the sample interval that makes them hold 320 ms. Every trail
   *  keeps running with its committed samples (their times stay, so sampleAt stays valid): a shrink kills the points
   *  it drops, a growth starts the points it adds dead, and both collapse onto the last kept point, so no segment
   *  reaches a stale position. */
  setPoints(n: number): void {
    const p = Math.floor(n);
    const next = p >= 3 ? (p > this.maxPoints ? this.maxPoints : p) : 3;
    const prev = this.points;
    this.points = next;
    this.sampleS = Math.max(TRAIL_SAMPLE_S, LEN_PHASE_S / (next - 2));
    if (next === prev) return;
    const from = next < prev ? next : prev;
    const to = next < prev ? prev : next;
    for (let slot = 0; slot < MAX_BALLS; slot++) this.collapseTail(slot, from, to);
    markWhole(this.posAttr);
    markWhole(this.qAttr);
    markWhole(this.tAttr);
  }

  update(ctx: FrameCtx): void {
    const now = ctx.fxTimeS;
    this.now = now;
    const r = this.render;
    const b = r.ball;
    const P = this.points;
    const S = this.sampleS;
    const maxLen = (P - 2) * S;
    const end = r.ballHigh > this.highActive ? r.ballHigh : this.highActive;
    let high = 0;
    let active = 0;
    for (let slot = 0; slot < end; slot++) {
      const id = slot < r.ballHigh ? r.ballId[slot] : -1;
      const o = slot * BALL_STRIDE;
      const vis = id < 0 ? BallVis.Hidden : b[o + BO.VIS];
      if (vis === BallVis.Hidden) {
        if (this.on[slot] === 1) {
          if (now - this.headT[slot] > this.len[slot] + S) {
            this.on[slot] = 0;
            this.ids[slot] = -1;
            this.len[slot] = 0;
          } else {
            active++;
            high = slot + 1;
          }
        }
        continue;
      }
      const x = b[o + BO.X];
      const y = b[o + BO.Y];
      const rad = b[o + BO.R];
      if (id !== this.ids[slot] || this.on[slot] === 0) {
        this.start(slot, id, x, y, rad, now);
      } else {
        const dx = x - this.lastX[slot];
        const dy = y - this.lastY[slot];
        if (dx * dx + dy * dy > JUMP2) this.start(slot, id, x, y, rad, now);
      }
      const phasing = b[o + BO.PHASING] > 0.5;
      const owner = b[o + BO.OWNER] | 0;
      const ci = phasing ? TrailColor.Phase : owner >= 0 && owner <= 3 ? owner : TrailColor.Unowned;
      const vx = b[o + BO.VX];
      const vy = b[o + BO.VY];
      const speed = Math.sqrt(vx * vx + vy * vy);
      let len = phasing ? LEN_PHASE_S : LEN_MIN_S + (LEN_MAX_S - LEN_MIN_S) * clamp01((speed - SPEED_LO) / (SPEED_HI - SPEED_LO));
      if (ctx.reducedMotion) len *= 0.5;
      this.len[slot] = len < maxLen ? len : maxLen;
      const hw = 0.5 * WIDTH * rad;

      const lx = this.lastX[slot];
      const ly = this.lastY[slot];
      const lt = this.lastT[slot];
      const span = now - lt;
      let ns = this.nextSample[slot];
      let n = 0;
      while (ns <= now && n < P) {
        const f = span > 1e-9 ? (ns - lt) / span : 1;
        this.shift(slot, P);
        this.writePoint(slot, 1, lx + (x - lx) * f, ly + (y - ly) * f, rad, ns, ci, hw, 2);
        ns += S;
        n++;
      }
      if (ns <= now) ns = now + S;   // more than P samples in one frame: resume from now
      this.nextSample[slot] = ns;
      this.writePoint(slot, 0, x, y, rad, now, ci, hw, 1);
      this.lastX[slot] = x;
      this.lastY[slot] = y;
      this.lastT[slot] = now;
      this.headT[slot] = now;
      active++;
      high = slot + 1;
    }
    this.highActive = high;
    this.activeN = active;
    if (active > 0 || this.uploadNext) {
      markWhole(this.posAttr);
      markWhole(this.qAttr);
      markWhole(this.tAttr);
      this.uploadNext = active > 0;
    }
  }

  /** The trail position `lagS` seconds before the last update, interpolated between samples; false when the trail's
   *  history does not reach that far (phasing echoes, E34). */
  sampleAt(slot: number, lagS: number, out: TrailPoint): boolean {
    if (slot < 0 || slot >= MAX_BALLS || this.on[slot] !== 1) return false;
    const target = this.now - lagS;
    const base = slot * this.maxPoints * 2;
    const t = this.t;
    for (let i = 1; i < this.points; i++) {
      const ti = t[base + i * 2];
      if (ti <= DEAD_T0 + 1) return false;
      if (ti <= target) {
        const tn = t[base + (i - 1) * 2];
        const f = tn > ti ? (target - ti) / (tn - ti) : 0;
        const a = (base + i * 2) * 3;
        const c = (base + (i - 1) * 2) * 3;
        out.x = this.pos[a] + (this.pos[c] - this.pos[a]) * f;
        out.y = this.pos[a + 1] + (this.pos[c + 1] - this.pos[a + 1]) * f;
        out.z = this.pos[a + 2] + (this.pos[c + 2] - this.pos[a + 2]) * f;
        return true;
      }
    }
    return false;
  }

  /** Committed sample times of `slot`, newest first, into `out`; returns how many (tests and tools). */
  sampleTimes(slot: number, out: Float64Array): number {
    const base = slot * this.maxPoints * 2;
    let n = 0;
    for (let i = 1; i < this.points && n < out.length; i++) {
      const ti = this.t[base + i * 2];
      if (ti <= DEAD_T0 + 1) break;
      out[n++] = ti;
    }
    return n;
  }

  /** Centre and colour index of point `i` of `slot` (0 = head), into out[0..4) (tests and tools). */
  pointOf(slot: number, i: number, out: Float64Array): void {
    const v = (slot * this.maxPoints + i) * 2;
    out[0] = this.pos[v * 3];
    out[1] = this.pos[v * 3 + 1];
    out[2] = this.pos[v * 3 + 2];
    out[3] = this.q[v * 4 + 3];
  }

  reset(): void {
    this.t.fill(DEAD_T0);
    this.ids.fill(-1);
    this.on.fill(0);
    this.len.fill(0);
    this.highActive = 0;
    this.activeN = 0;
    this.uploadNext = true;
    markWhole(this.posAttr);
    markWhole(this.qAttr);
    markWhole(this.tAttr);
  }

  markNeedsUpdate(): void {
    this.uploadNext = true;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }

  /** A new trail: every point collapsed at the ball (zero width, dead), so no segment reaches anywhere else. */
  private start(slot: number, id: number, x: number, y: number, z: number, now: number): void {
    this.ids[slot] = id;
    this.on[slot] = 1;
    const first = slot * this.maxPoints * 2;
    const last = first + this.maxPoints * 2;
    for (let v = first; v < last; v++) {
      this.pos[v * 3] = x;
      this.pos[v * 3 + 1] = y;
      this.pos[v * 3 + 2] = z;
      this.q[v * 4] = 0;
      this.q[v * 4 + 1] = 1;
      this.q[v * 4 + 2] = 0;
      this.q[v * 4 + 3] = TrailColor.Unowned;
      this.t[v] = DEAD_T0;
    }
    this.lastX[slot] = x;
    this.lastY[slot] = y;
    this.lastT[slot] = now;
    this.headT[slot] = now;
    this.nextSample[slot] = now + this.sampleS;
  }

  /** Points [from, to) of `slot` die onto point from - 1: its centre, normal and colour, zero width, sample time
   *  DEAD_T0 (as start() writes them). */
  private collapseTail(slot: number, from: number, to: number): void {
    const base = slot * this.maxPoints;
    const k = (base + from - 1) * 2;
    const x = this.pos[k * 3];
    const y = this.pos[k * 3 + 1];
    const z = this.pos[k * 3 + 2];
    const nx = this.q[k * 4];
    const ny = this.q[k * 4 + 1];
    const ci = this.q[k * 4 + 3];
    const last = (base + to) * 2;
    for (let v = (base + from) * 2; v < last; v++) {
      this.pos[v * 3] = x;
      this.pos[v * 3 + 1] = y;
      this.pos[v * 3 + 2] = z;
      this.q[v * 4] = nx;
      this.q[v * 4 + 1] = ny;
      this.q[v * 4 + 2] = 0;
      this.q[v * 4 + 3] = ci;
      this.t[v] = DEAD_T0;
    }
  }

  /** Moves points 1..P-2 of `slot` to 2..P-1, dropping the oldest. */
  private shift(slot: number, P: number): void {
    const src = slot * this.maxPoints * 2 + 2;
    const dst = src + 2;
    const cnt = (P - 2) * 2;
    this.pos.copyWithin(dst * 3, src * 3, (src + cnt) * 3);
    this.q.copyWithin(dst * 4, src * 4, (src + cnt) * 4);
    this.t.copyWithin(dst, src, src + cnt);
  }

  /** Writes point `i` of `slot` (both vertices). The ribbon normal is perpendicular to the step from point `from`;
   *  a zero-length step keeps that point's normal. */
  private writePoint(slot: number, i: number, x: number, y: number, z: number, t0: number, ci: number, hw: number, from: number): void {
    const v = (slot * this.maxPoints + i) * 2;
    const f = (slot * this.maxPoints + from) * 2;
    const dx = x - this.pos[f * 3];
    const dy = y - this.pos[f * 3 + 1];
    const l = Math.sqrt(dx * dx + dy * dy);
    let nx: number;
    let ny: number;
    if (l > 1e-6) {
      nx = -dy / l;
      ny = dx / l;
    } else {
      nx = this.q[f * 4];
      ny = this.q[f * 4 + 1];
    }
    for (let s = 0; s < 2; s++) {
      const w = v + s;
      this.pos[w * 3] = x;
      this.pos[w * 3 + 1] = y;
      this.pos[w * 3 + 2] = z;
      this.q[w * 4] = nx;
      this.q[w * 4 + 1] = ny;
      this.q[w * 4 + 2] = hw;
      this.q[w * 4 + 3] = ci;
      this.t[w] = t0;
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

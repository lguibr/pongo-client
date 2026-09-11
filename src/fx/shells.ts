// Phasing shells and echoes (E34, C62, C68): InstancedMesh-style draw of up to 256 icospheres (64 balls x (shell +
// 3 echoes), plus the timer ring while there is room). Positions are written per frame for phasing balls only. A
// phasing ball gets an HDR violet fresnel shell (popping in over 0.15 s), 3 echoes at 40, 80 and 120 ms of trail
// history (1 under reduced motion) for the whole phase, and a depleting 3 s timer ring that flickers in its last 0.5 s
// (steady under reduced motion). The remaining time comes from continuous state (World phaseStartTick against the
// display tick), so a late joiner sees the right ring. When phaseEnd is released the shell collapses over 0.25 s; if
// the display still shows the ball phasing then, the collapse waits for the first frame that shows it not phasing.
// The ball's own dimmed, dithered core is the balls system's (P5); there is no transmission (C68).

import * as THREE from 'three';
import type { FrameCtx } from '../render/contracts';
import type { RenderState, World } from '../game/types';
import { BALL_STRIDE, BO, BallVis } from '../game/types';
import { MAX_BALLS, PHASE_MS, TICK_MS } from '../config/constants';
import { COLORS, HDR } from '../config/palette';
import type { FxUniforms } from './pools/gpuPool';
import { markWhole } from './pools/gpuPool';
import type { TrailPoint, TrailSystem } from './trails';
import { easeOutBack, flicker } from './envelopes';
import { SHELL_FRAGMENT, SHELL_VERTEX } from './shaders/shell';

export const SHELL_CAPACITY = 256;
export const ShellKind = { Shell: 0, Echo: 1, Timer: 2, Collapse: 3 } as const;

const STRIDE = 8;               // aCenter 4, aParams 4
const SHELL_SCALE = 1.4;        // shell radius / ball radius
const ECHO_SCALE = 1.05;
const TIMER_SCALE = 2.3;
const TIMER_Z = 0.8;
const POP_IN_S = 0.15;
const COLLAPSE_S = 0.25;
const ECHO_LAG_S = 0.04;
const FLICKER_S = 0.5;
const NONE = -1e9;
/** collapsePending states: collapse() was called; then the display showed the ball phasing after that call. */
const REQUESTED = 1;
const DEFERRED = 2;

export class ShellSystem {
  readonly object: THREE.Mesh;
  private readonly render: Readonly<RenderState>;
  private readonly world: Readonly<World>;
  private readonly trails: TrailSystem;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly base: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  private readonly array: Float32Array;
  private readonly collapseT0 = new Float64Array(MAX_BALLS).fill(NONE);
  /** 0, REQUESTED or DEFERRED. A DEFERRED collapse starts on the first frame the display shows the ball not phasing
   *  (the display passing the phaseEnd tick), since phaseEnd can be released before that. */
  private readonly collapsePending = new Uint8Array(MAX_BALLS);
  /** The ball a collapse belongs to, or -1: another ball in the slot drops it. */
  private readonly collapseId = new Int32Array(MAX_BALLS).fill(-1);
  private readonly pt: TrailPoint = { x: 0.5, y: 0.5, z: 0.5 };
  private n = 0;
  private prevN = 0;

  constructor(render: Readonly<RenderState>, world: Readonly<World>, u: FxUniforms, trails: TrailSystem) {
    this.render = render;
    this.world = world;
    this.trails = trails;
    this.array = new Float32Array(SHELL_CAPACITY * STRIDE);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.array, STRIDE, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    this.base = new THREE.IcosahedronGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(this.base.getIndex());
    for (const name of Object.keys(this.base.attributes)) g.setAttribute(name, this.base.getAttribute(name));
    g.setAttribute('aCenter', new THREE.InterleavedBufferAttribute(this.buffer, 4, 0));
    g.setAttribute('aParams', new THREE.InterleavedBufferAttribute(this.buffer, 4, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1200);
    g.instanceCount = 0;
    this.geometry = g;
    const phase = new THREE.Color(COLORS.phase).multiplyScalar(HDR.shell);
    this.material = new THREE.ShaderMaterial({
      name: 'fxShells',
      uniforms: { uPhase: { value: phase }, uHdr: u.uHdr },
      vertexShader: SHELL_VERTEX,
      fragmentShader: SHELL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.Mesh(g, this.material);
    this.object.name = 'fxShells';
    this.object.frustumCulled = false;
    this.object.matrixAutoUpdate = false;
    this.object.renderOrder = 4;
  }

  /** Instances drawn this frame. */
  get count(): number {
    return this.n;
  }

  /** Instance `i` written this frame into out[0..8): centre x, y, z, radius, alpha, fill, kind, 0 (tests, tools). */
  readInstance(i: number, out: Float32Array): void {
    for (let k = 0; k < STRIDE; k++) out[k] = this.array[i * STRIDE + k];
  }

  /** Runs after the trails' update, whose history feeds the echoes. */
  update(ctx: FrameCtx): void {
    const now = ctx.fxTimeS;
    const r = this.render;
    const b = r.ball;
    const echoes = ctx.reducedMotion ? 1 : 3;
    const phaseS = PHASE_MS / 1000;
    let n = 0;
    for (let slot = 0; slot < r.ballHigh; slot++) {
      if (n > SHELL_CAPACITY - 5) break;
      const id = r.ballId[slot];
      if (id < 0) {
        this.dropCollapse(slot);
        continue;
      }
      if (this.collapseId[slot] !== id && this.collapseId[slot] !== -1) this.dropCollapse(slot);
      const o = slot * BALL_STRIDE;
      const x = b[o + BO.X];
      const y = b[o + BO.Y];
      const rad = b[o + BO.R];
      const pending = this.collapsePending[slot];
      if (b[o + BO.PHASING] > 0.5 && b[o + BO.VIS] === BallVis.Live) {
        if (pending === 0) this.collapseT0[slot] = NONE;
        else this.collapsePending[slot] = DEFERRED;   // released before the display passed the phaseEnd tick
        const ws = this.world.balls[slot];
        let elapsed = 0;
        if (ws !== undefined && ws.id === id && ws.phaseStartTick >= 0) {
          elapsed = ((r.displayTick - ws.phaseStartTick) * TICK_MS) / 1000;
          if (elapsed < 0) elapsed = 0;
        }
        const remaining = elapsed < phaseS ? phaseS - elapsed : 0;
        n = this.put(n, x, y, rad, rad * SHELL_SCALE * easeOutBack(elapsed, POP_IN_S), 1, 0, ShellKind.Shell);
        for (let k = 1; k <= echoes; k++) {
          if (!this.trails.sampleAt(slot, ECHO_LAG_S * k, this.pt)) break;
          n = this.put(n, this.pt.x, this.pt.y, this.pt.z, rad * ECHO_SCALE, 0.55 / k, 0, ShellKind.Echo);
        }
        const alpha = remaining < FLICKER_S && !ctx.reducedMotion ? flicker(now, 14, slot) : 1;
        n = this.put(n, x, y, TIMER_Z, rad * TIMER_SCALE, alpha, remaining / phaseS, ShellKind.Timer);
        continue;
      }
      if (pending !== 0) {
        // The display shows the ball not phasing: a deferred collapse starts on this frame, a requested one at the
        // time it was released.
        if (pending === DEFERRED && this.collapseT0[slot] < now) this.collapseT0[slot] = now;
        this.collapsePending[slot] = 0;
      }
      if (this.collapseT0[slot] > NONE) {
        const t = now - this.collapseT0[slot];
        if (t < 0 || t >= COLLAPSE_S) {
          if (t >= COLLAPSE_S) this.collapseT0[slot] = NONE;
          continue;
        }
        const k = t / COLLAPSE_S;
        n = this.put(n, x, y, rad, rad * SHELL_SCALE * (1 - k * k), 1 - k, 0, ShellKind.Collapse);
      }
    }
    this.n = n;
    this.geometry.instanceCount = n;
    if (n > 0 || this.prevN > 0) markWhole(this.buffer);
    this.prevN = n;
  }

  /** phaseEnd released: the ball's shell collapses over 0.25 s from presentation time `t`, or from the first frame
   *  after it that shows the ball not phasing. */
  collapse(ballId: number, t: number): void {
    const slot = this.world.slotById.get(ballId);
    if (slot === undefined || slot < 0 || slot >= MAX_BALLS) return;
    this.collapseT0[slot] = t;
    this.collapsePending[slot] = REQUESTED;
    this.collapseId[slot] = ballId;
  }

  /** A stale phaseEnd: no collapse. */
  cancel(ballId: number): void {
    const slot = this.world.slotById.get(ballId);
    if (slot !== undefined && slot >= 0 && slot < MAX_BALLS) this.dropCollapse(slot);
  }

  reset(): void {
    this.collapseT0.fill(NONE);
    this.collapsePending.fill(0);
    this.collapseId.fill(-1);
    this.n = 0;
    this.geometry.instanceCount = 0;
    this.prevN = 1;
  }

  markNeedsUpdate(): void {
    markWhole(this.buffer);
  }

  dispose(): void {
    this.object.removeFromParent();
    this.geometry.dispose();
    this.base.dispose();
    this.material.dispose();
  }

  private dropCollapse(slot: number): void {
    this.collapseT0[slot] = NONE;
    this.collapsePending[slot] = 0;
    this.collapseId[slot] = -1;
  }

  private put(n: number, x: number, y: number, z: number, radius: number, alpha: number, fill: number, kind: number): number {
    const o = n * STRIDE;
    const a = this.array;
    a[o] = x;
    a[o + 1] = y;
    a[o + 2] = z;
    a[o + 3] = radius;
    a[o + 4] = alpha;
    a[o + 5] = fill;
    a[o + 6] = kind;
    a[o + 7] = 0;
    return n + 1;
  }
}

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraRig, fitDistance } from './camera';
import type { FrameCtx } from './contracts';
import { TUNING } from '../config/tuning';
import { CANVAS, WALL_T } from '../config/constants';
import { fakeWorld } from '../test/fakes/fakeApp';
import { rotationRad } from '../game/orientation';

const CAM = TUNING.camera;
const E = CANVAS / 2 + WALL_T;
const DT = 1 / 60;

function corners(): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let c = 0; c < 8; c++) out.push(new THREE.Vector3(c & 1 ? E : -E, c & 2 ? E : -E, c & 4 ? CAM.headroom : 0));
  return out;
}

function ctx(over: Partial<FrameCtx> = {}): FrameCtx {
  return {
    nowMs: 0, dtMs: DT * 1000, dtS: DT, fxTimeS: 0, fxDtS: DT, displayMs: 0, reducedMotion: false, tier: 'high',
    myIndex: null, hitStopActive: false, session: 'playing', mode: 'live', ...over,
  };
}

/** A camera posed independently, with three's own lookAt, where fitDistance says it goes. */
function posed(aspect: number, fit: { d: number; near: number; far: number }): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(CAM.fovDeg, aspect, fit.near, fit.far);
  cam.position.set(0, CAM.tilt, Math.sqrt(1 - CAM.tilt * CAM.tilt)).multiplyScalar(fit.d);
  cam.up.set(0, 1, 0);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/** Largest |ndc.x| or |ndc.y| over the corners, and whether every corner lies inside the frustum. */
function coverage(cam: THREE.PerspectiveCamera): { extent: number; inside: boolean } {
  let extent = 0;
  let inside = true;
  for (const p of corners()) {
    const ndc = p.clone().project(cam);
    extent = Math.max(extent, Math.abs(ndc.x), Math.abs(ndc.y));
    if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || ndc.z <= -1 || ndc.z >= 1) inside = false;
  }
  return { extent, inside };
}

describe('fitDistance (5.10)', () => {
  it.each([0.45, 1, 2.4])('aspect %s: every corner of the board box is visible, near and far bound the depths', (aspect) => {
    const fit = fitDistance(aspect, CAM);
    const cam = posed(aspect, fit);
    const { extent, inside } = coverage(cam);
    expect(inside).toBe(true);
    expect(extent).toBeGreaterThan(0.85);   // tight: the margin is 6 %, not a loose overshoot
    const depths = corners().map((p) => -p.clone().applyMatrix4(cam.matrixWorldInverse).z);
    const lo = Math.min(...depths);
    const hi = Math.max(...depths);
    expect(fit.near).toBeLessThan(lo);
    expect(fit.far).toBeGreaterThan(hi);
    expect(fit.near).toBeGreaterThan(0.85 * lo);
    expect(fit.far).toBeLessThan(1.2 * hi);
  });

  it('keeps depth precision (C24): near is in the thousands and far / near stays small', () => {
    const fit = fitDistance(1, CAM);
    expect(fit.near).toBeGreaterThan(2500);
    expect(fit.far / fit.near).toBeLessThan(1.6);
  });

  it('backs off for a narrow screen and comes closer for a wide one', () => {
    const narrow = fitDistance(0.45, CAM).d;
    const square = fitDistance(1, CAM).d;
    const wide = fitDistance(2.4, CAM).d;
    expect(narrow).toBeGreaterThan(square);
    expect(square).toBeGreaterThan(wide);
  });
});

describe('CameraRig', () => {
  it('refits in the same frame as a size change (C75)', () => {
    const cam = new THREE.PerspectiveCamera();
    const rig = new CameraRig(cam, CAM);
    rig.update(ctx(), 1000, 1000);
    expect(coverage(cam).inside).toBe(true);
    rig.update(ctx(), 450, 1000);
    expect(cam.aspect).toBeCloseTo(0.45, 10);
    expect(coverage(cam).inside).toBe(true);
    expect(rig.distance).toBeCloseTo(fitDistance(0.45, CAM).d, 6);
    expect(cam.near).toBe(rig.near);
    expect(cam.far).toBe(rig.far);
  });

  it('matches the independently posed camera in play', () => {
    const cam = new THREE.PerspectiveCamera();
    const rig = new CameraRig(cam, CAM);
    rig.update(ctx(), 1600, 900);
    const ref = posed(1600 / 900, fitDistance(1600 / 900, CAM));
    expect(cam.position.distanceTo(ref.position)).toBeLessThan(1e-6);
    for (let i = 0; i < 16; i++) {
      expect(cam.matrixWorld.elements[i]).toBeCloseTo(ref.matrixWorld.elements[i], 6);
      expect(cam.projectionMatrix.elements[i]).toBeCloseTo(ref.projectionMatrix.elements[i], 9);
    }
  });

  it('shakes with trauma, decays at 1.6 per second, and never shakes under reduced motion', () => {
    const base = new CameraRig(new THREE.PerspectiveCamera(), CAM);
    const shaken = new CameraRig(new THREE.PerspectiveCamera(), CAM);
    const calm = new CameraRig(new THREE.PerspectiveCamera(), CAM);
    for (const r of [base, shaken, calm]) r.update(ctx(), 800, 800);
    shaken.addTrauma(1);
    calm.update(ctx({ reducedMotion: true }), 800, 800);
    calm.addTrauma(1);
    let moved = 0;
    for (let i = 0; i < 20; i++) {
      base.update(ctx(), 800, 800);
      shaken.update(ctx(), 800, 800);
      calm.update(ctx({ reducedMotion: true }), 800, 800);
      moved = Math.max(moved, shaken.camera.position.distanceTo(base.camera.position));
      expect(calm.camera.position.distanceTo(base.camera.position)).toBe(0);
    }
    expect(moved).toBeGreaterThan(0.5);
    for (let i = 0; i < 60; i++) {
      base.update(ctx(), 800, 800);
      shaken.update(ctx(), 800, 800);
    }
    expect(shaken.camera.position.distanceTo(base.camera.position)).toBe(0);
  });

  it('eases the intro from 1.35 d to d and skips it under reduced motion', () => {
    const d = fitDistance(1, CAM).d;
    const rig = new CameraRig(new THREE.PerspectiveCamera(), CAM);
    rig.setMode('intro', false);
    rig.update(ctx({ session: 'countdown' }), 1000, 1000);
    expect(rig.distance / d).toBeGreaterThan(1.3);
    expect(coverage(rig.camera).inside).toBe(true);   // near and far follow the intro pose
    // The first pose is cut: the next frames do not blend back from the constructor's play pose.
    for (let i = 0; i < 5; i++) rig.update(ctx({ session: 'countdown' }), 1000, 1000);
    expect(rig.distance / d).toBeGreaterThan(1.3);
    for (let i = 0; i < 200; i++) rig.update(ctx({ session: 'countdown' }), 1000, 1000);
    expect(rig.distance / d).toBeCloseTo(1, 9);

    const still = new CameraRig(new THREE.PerspectiveCamera(), CAM);
    still.setMode('intro', true);
    still.update(ctx({ session: 'countdown', reducedMotion: true }), 1000, 1000);
    expect(still.distance / d).toBeCloseTo(1, 9);
  });

  it('times the intro from the countdown end, so a player who joins late still reaches play at go (5.10)', () => {
    const d = fitDistance(1, CAM).d;
    const smooth = (x: number): number => x * x * (3 - 2 * x);
    const introAt = (msLeft: number): number => 1 + (CAM.introScale - 1) * (1 - smooth(1 - msLeft / 3000));
    const late = new CameraRig(new THREE.PerspectiveCamera(), CAM);
    late.setMode('intro', false);
    late.setIntroEnd(10_000);
    late.update(ctx({ session: 'countdown', nowMs: 8_500 }), 1000, 1000);   // joined with 1.5 s to go
    expect(late.distance / d).toBeCloseTo(introAt(1500), 9);
    expect(late.distance / d).toBeLessThan(CAM.introScale - 0.1);
    let t = 8_500;
    for (let i = 0; i < 30; i++) {
      t += DT * 1000;
      late.update(ctx({ session: 'countdown', nowMs: t }), 1000, 1000);
    }
    expect(late.distance / d).toBeCloseTo(introAt(10_000 - t), 9);
    late.update(ctx({ session: 'countdown', nowMs: 10_000 }), 1000, 1000);
    expect(late.distance / d).toBeCloseTo(1, 9);

    // With the full countdown ahead the intro starts at introScale.
    const early = new CameraRig(new THREE.PerspectiveCamera(), CAM);
    early.setMode('intro', false);
    early.setIntroEnd(5_000);
    early.update(ctx({ session: 'countdown', nowMs: 2_000 }), 1000, 1000);
    expect(early.distance / d).toBeCloseTo(CAM.introScale, 9);
  });

  it('keeps quaternion and rotation in step with the matrix it writes, roll included', () => {
    const cam = new THREE.PerspectiveCamera();
    const rig = new CameraRig(cam, CAM);
    rig.update(ctx(), 1600, 900);
    const ref = posed(1600 / 900, fitDistance(1600 / 900, CAM));
    expect(cam.quaternion.angleTo(ref.quaternion)).toBeLessThan(1e-6);
    const fromEuler = new THREE.Quaternion().setFromEuler(cam.rotation);
    expect(fromEuler.angleTo(cam.quaternion)).toBeLessThan(1e-6);
    rig.addTrauma(1);
    for (let i = 0; i < 3; i++) rig.update(ctx(), 1600, 900);
    const composed = new THREE.Matrix4().compose(cam.position, cam.quaternion, new THREE.Vector3(1, 1, 1));
    for (let i = 0; i < 16; i++) expect(composed.elements[i]).toBeCloseTo(cam.matrix.elements[i], 6);
    expect(cam.quaternion.angleTo(ref.quaternion)).toBeGreaterThan(0);
  });

  it('refit redraws the current pose at a new size without stepping time, shake or the board rotation', () => {
    const board = new THREE.Group();
    const cam = new THREE.PerspectiveCamera();
    const rig = new CameraRig(cam, CAM);
    rig.setBoard(board, fakeWorld());
    rig.update(ctx({ myIndex: null }), 1000, 1000);
    for (let i = 0; i < 10; i++) rig.update(ctx({ myIndex: 1 }), 1000, 1000);
    const angle = board.rotation.z;
    expect(angle).not.toBe(0);
    expect(angle).not.toBeCloseTo(rotationRad(1), 3);   // mid-ease
    rig.refit(450, 1000);
    expect(board.rotation.z).toBe(angle);
    expect(cam.aspect).toBeCloseTo(0.45, 10);
    expect(rig.distance).toBeCloseTo(fitDistance(0.45, CAM).d, 6);
    expect(coverage(cam).inside).toBe(true);
    rig.refit(0, 1000);   // a collapsed canvas keeps the last fit
    expect(cam.aspect).toBeCloseTo(0.45, 10);
  });

  it('dollies back to gameOverScale d over 1.5 s at game over', () => {
    const d = fitDistance(1, CAM).d;
    const rig = new CameraRig(new THREE.PerspectiveCamera(), CAM);
    rig.update(ctx(), 1000, 1000);
    rig.setMode('gameOver', false);
    for (let i = 0; i < 45; i++) rig.update(ctx({ mode: 'ended' }), 1000, 1000);
    expect(rig.distance / d).toBeGreaterThan(1);
    expect(rig.distance / d).toBeLessThan(CAM.gameOverScale);
    for (let i = 0; i < 60; i++) rig.update(ctx({ mode: 'ended' }), 1000, 1000);
    expect(rig.distance / d).toBeCloseTo(CAM.gameOverScale, 9);
  });

  it('kicks in by at most 5 % and eases back over 0.3 s', () => {
    const d = fitDistance(1, CAM).d;
    const rig = new CameraRig(new THREE.PerspectiveCamera(), CAM);
    rig.update(ctx(), 1000, 1000);
    rig.kick(0.5);
    rig.update(ctx(), 1000, 1000);
    expect(rig.distance / d).toBeGreaterThan(0.95);
    expect(rig.distance / d).toBeLessThan(0.96);
    for (let i = 0; i < 20; i++) rig.update(ctx(), 1000, 1000);
    expect(rig.distance / d).toBeCloseTo(1, 9);
  });

  it('pushes the image with an impulse and springs back', () => {
    const base = new CameraRig(new THREE.PerspectiveCamera(), CAM);
    const pushed = new CameraRig(new THREE.PerspectiveCamera(), CAM);
    base.update(ctx(), 1000, 1000);
    pushed.update(ctx(), 1000, 1000);
    pushed.impulse(1, 0, 0.25);
    for (let i = 0; i < 6; i++) {
      base.update(ctx(), 1000, 1000);
      pushed.update(ctx(), 1000, 1000);
    }
    // The image moves right, so the camera moves left.
    expect(pushed.camera.position.x).toBeLessThan(base.camera.position.x - 1);
    for (let i = 0; i < 180; i++) {
      base.update(ctx(), 1000, 1000);
      pushed.update(ctx(), 1000, 1000);
    }
    expect(pushed.camera.position.distanceTo(base.camera.position)).toBeLessThan(1e-3);
  });

  it('eases the board to rotationRad(myIndex) over 500 ms the short way round, and cuts under reduced motion', () => {
    const board = new THREE.Group();
    const rig = new CameraRig(new THREE.PerspectiveCamera(), CAM);
    rig.setBoard(board, fakeWorld());
    rig.update(ctx({ myIndex: null }), 1000, 1000);
    expect(board.rotation.z).toBe(0);
    const target = rotationRad(0);   // 270 degrees: the short way is -90
    for (let i = 0; i < 15; i++) rig.update(ctx({ myIndex: 0 }), 1000, 1000);
    expect(board.rotation.z).toBeLessThan(0);
    expect(board.rotation.z).toBeGreaterThan(-Math.PI / 2);
    for (let i = 0; i < 20; i++) rig.update(ctx({ myIndex: 0 }), 1000, 1000);
    expect(Math.cos(board.rotation.z)).toBeCloseTo(Math.cos(target), 9);
    expect(Math.sin(board.rotation.z)).toBeCloseTo(Math.sin(target), 9);

    rig.update(ctx({ myIndex: 2, reducedMotion: true }), 1000, 1000);
    expect(board.rotation.z).toBe(rotationRad(2));
  });
});

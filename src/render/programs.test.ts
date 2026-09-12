// Releasing program variants on a tier change across low (browser-D4). The program count itself needs WebGL; here
// the dispose dispatch that makes three release them, and the boundary rule.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { releaseMaterialPrograms, tierChangeReleasesPrograms } from './programs';
import type { Tier } from './contracts';

describe('releaseMaterialPrograms', () => {
  it('dispatches dispose exactly once per unique material, shared, array and instanced alike', () => {
    const scene = new THREE.Scene();
    const geo = new THREE.BoxGeometry();
    const shared = new THREE.MeshStandardMaterial();
    const matA = new THREE.MeshBasicMaterial();
    const matB = new THREE.MeshBasicMaterial();
    const instanced = new THREE.MeshStandardMaterial();
    scene.add(new THREE.Mesh(geo, shared), new THREE.Mesh(geo, shared));
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geo, [matA, matB]));
    scene.add(group, new THREE.InstancedMesh(geo, instanced, 4), new THREE.HemisphereLight());

    const disposed = new Map<THREE.Material, number>();
    for (const m of [shared, matA, matB, instanced]) {
      m.addEventListener('dispose', () => disposed.set(m, (disposed.get(m) ?? 0) + 1));
    }

    expect(releaseMaterialPrograms(scene)).toBe(4);
    expect(disposed.size).toBe(4);
    expect([...disposed.values()]).toEqual([1, 1, 1, 1]);
  });

  it('leaves the materials attached and usable', () => {
    const scene = new THREE.Scene();
    const mat = new THREE.MeshStandardMaterial({ color: '#ff0000' });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), mat);
    scene.add(mesh);
    releaseMaterialPrograms(scene);
    expect(mesh.material).toBe(mat);
    expect(mat.color.getHexString()).toBe('ff0000');
    expect(releaseMaterialPrograms(scene)).toBe(1);
  });
});

describe('tierChangeReleasesPrograms', () => {
  const cases: [Tier, Tier, boolean][] = [
    ['high', 'low', true], ['low', 'high', true],
    ['medium', 'low', true], ['low', 'medium', true],
    ['high', 'medium', false], ['medium', 'high', false],
    ['high', 'high', false], ['medium', 'medium', false], ['low', 'low', false],
  ];
  it.each(cases)('%s -> %s is %s', (from, to, expected) => {
    expect(tierChangeReleasesPrograms(from, to)).toBe(expected);
  });
});

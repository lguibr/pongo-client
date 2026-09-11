// Program variants across a tier change (5.13). three r176 keeps every program variant a material has used in
// materialProperties.programs, keyed by the program cache key, until the material is disposed. The composer tiers
// draw the scene into a target (linear output, no tone mapping); low draws it to the screen (sRGB output, ACES).
// So every scene and FX material gains a second variant on a change to low, and keeps both on the way back.
// Disposing a material makes the renderer release every variant it holds and forget its properties; the material
// stays usable and compiles again on its next compile or render. Scene.tsx warms the stage right after the change.

import type * as THREE from 'three';
import type { Tier } from './contracts';

/** True when a tier change changes every scene program's key: exactly one side is 'low'. */
export function tierChangeReleasesPrograms(from: Tier, to: Tier): boolean {
  return (from === 'low') !== (to === 'low');
}

/** Disposes every unique material under root (single or array), releasing all of its program variants. Returns
 *  the number of materials disposed. */
export function releaseMaterialPrograms(root: THREE.Object3D): number {
  const materials = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = (o as { material?: THREE.Material | THREE.Material[] | null }).material;
    if (m === undefined || m === null) return;
    if (Array.isArray(m)) {
      for (const x of m) materials.add(x);
    } else {
      materials.add(m);
    }
  });
  for (const m of materials) m.dispose();
  return materials.size;
}

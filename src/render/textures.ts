// Stage textures: the 18x18 occupancy map behind the floor's contact AO (D27) and the radial glow the halos sample.

import * as THREE from 'three';
import { CellType } from '../config/constants';

export interface Occupancy {
  readonly texture: THREE.DataTexture;
  readonly data: Uint8Array;   // grid * grid texels, texture row 0 = the bottom of the board
  readonly grid: number;
}

/** A linear-filtered R8 texture, one texel per cell, so sampling between cells gives a soft contact shadow. */
export function createOccupancyTexture(grid: number): Occupancy {
  const data = new Uint8Array(grid * grid);
  const texture = new THREE.DataTexture(data, grid, grid, THREE.RedFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, data, grid };
}

/** Writes 255 for every cell whose display type is Brick and 0 elsewhere. Cells are row-major from the top of the
 *  canvas, while texture row 0 is v = 0, the bottom of the board, so rows are flipped. */
export function writeOccupancy(occ: Occupancy, brickType: Uint8Array): void {
  const n = occ.grid;
  const data = occ.data;
  for (let row = 0; row < n; row++) {
    const src = row * n;
    const dst = (n - 1 - row) * n;
    for (let col = 0; col < n; col++) data[dst + col] = brickType[src + col] === CellType.Brick ? 255 : 0;
  }
  occ.texture.needsUpdate = true;
}

/** A radial falloff in the red channel: 1 at the centre, 0 at the rim, smooth at both ends. */
export function createGlowTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.min(1, Math.hypot(x - c, y - c) / c);
      const f = 1 - d;
      data[y * size + x] = Math.round(255 * f * f * (3 - 2 * f));
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

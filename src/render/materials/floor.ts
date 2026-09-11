// E01 floor: near-black with an anti-aliased cell grid, a glow strip along my wall, contact AO under bricks from
// the occupancy texture, blob shadows under balls and paddles, 8 ripple slots and the winner sweep (D27).
// Nothing here exceeds HDR.floorMax, so the floor never blooms (D10).

import * as THREE from 'three';
import { NumberUniform } from './patch';
import type { SharedUniforms } from './patch';
import { COLORS, HDR } from '../../config/palette';

export const FLOOR_BLOBS = 68;     // 64 balls, then 4 paddles
export const FLOOR_RIPPLES = 8;

export interface FloorUniforms {
  [name: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  uDim: THREE.IUniform<number>;
  uReduced: THREE.IUniform<number>;
  uHdr: THREE.IUniform<number>;
  uOcc: THREE.IUniform<THREE.Texture>;
  uGrid: THREE.IUniform<number>;
  uCanvas: THREE.IUniform<number>;
  uFloor: THREE.IUniform<THREE.Color>;
  uLine: THREE.IUniform<THREE.Color>;
  /** Balls: (x, y, radius, strength). Paddles: (cx, cy, -halfW, halfH). A zero entry draws nothing. */
  uBlobs: THREE.IUniform<Float32Array>;
  /** (x, y, t0, strength), board units and presentation seconds; strength 0 is a free slot. */
  uRipples: THREE.IUniform<Float32Array>;
  uMyWall: THREE.IUniform<number>;            // -1 when I have no seat
  uMyColor: THREE.IUniform<THREE.Color>;
  uSweep: THREE.IUniform<THREE.Vector4>;      // origin x, y, t0 (-1 = none), duration
  uSweepColor: THREE.IUniform<THREE.Color>;
}

const vertexShader = /* glsl */ `
varying vec2 vBoard;
void main() {
  vBoard = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform float uTime;
uniform float uDim;
uniform float uReduced;
uniform sampler2D uOcc;
uniform float uGrid;
uniform float uCanvas;
uniform vec3 uFloor;
uniform vec3 uLine;
uniform vec4 uBlobs[${FLOOR_BLOBS}];
uniform vec4 uRipples[${FLOOR_RIPPLES}];
uniform float uMyWall;
uniform vec3 uMyColor;
uniform vec4 uSweep;
uniform vec3 uSweepColor;
varying vec2 vBoard;

float occAt(vec2 uv) { return texture2D(uOcc, uv).r; }

void main() {
  float halfC = 0.5 * uCanvas;
  vec2 p = vBoard;
  float inside = step(abs(p.x), halfC) * step(abs(p.y), halfC);

  // Ripples: a ring 0 -> 260 units over 0.6 s that brightens the grid lines and, with full motion, bends them.
  float rip = 0.0;
  vec2 gp = p;
  for (int i = 0; i < ${FLOOR_RIPPLES}; i++) {
    vec4 r = uRipples[i];
    float t = uTime - r.z;
    if (r.w <= 0.0 || t < 0.0 || t > 0.6) continue;
    float radius = 260.0 * t / 0.6;
    vec2 d = p - r.xy;
    float dist = length(d);
    float ring = exp(-((dist - radius) * (dist - radius)) / 324.0) * (1.0 - t / 0.6) * r.w;
    rip += ring;
    gp += (1.0 - uReduced) * (d / max(dist, 1e-3)) * ring * 6.0;
  }

  vec3 col = uFloor;
  float cell = uCanvas / uGrid;
  vec2 g = (gp + halfC) / cell;
  vec2 w = max(fwidth(g), vec2(1e-4));
  vec2 lines = abs(fract(g - 0.5) - 0.5) / w;
  float line = (1.0 - min(min(lines.x, lines.y), 1.0)) * inside;
  col = mix(col, uLine * (1.0 + 3.0 * rip), line);

  // Contact AO: the linear-filtered occupancy map, blurred by four extra taps.
  vec2 uv = (p + halfC) / uCanvas;
  float o = 0.4 / uGrid;
  float ao = (2.0 * occAt(uv) + occAt(uv + vec2(o, 0.0)) + occAt(uv - vec2(o, 0.0))
    + occAt(uv + vec2(0.0, o)) + occAt(uv - vec2(0.0, o))) / 6.0;
  col *= 1.0 - 0.6 * ao * inside;

  // Blob shadows.
  float sh = 0.0;
  for (int i = 0; i < ${FLOOR_BLOBS}; i++) {
    vec4 b = uBlobs[i];
    if (b.z > 0.0 && b.w > 0.0) {
      float d = length(p - b.xy);
      sh = max(sh, b.w * (1.0 - smoothstep(b.z * 0.3, b.z * 1.9, d)));
    } else if (b.z < 0.0) {
      vec2 q = abs(p - b.xy) - vec2(-b.z, b.w);
      float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
      sh = max(sh, 0.5 * (1.0 - smoothstep(-4.0, 16.0, d)));
    }
  }
  col *= 1.0 - 0.65 * sh;

  // My wall's glow strip.
  if (uMyWall > -0.5) {
    float dist = uMyWall < 0.5 ? halfC - p.x : uMyWall < 1.5 ? halfC - p.y : uMyWall < 2.5 ? p.x + halfC : p.y + halfC;
    col += uMyColor * exp(-max(dist, 0.0) / 36.0) * 0.22 * inside;
  }

  // Winner sweep: a radial front in the winner's colour.
  if (uSweep.z >= 0.0) {
    float t = (uTime - uSweep.z) / max(uSweep.w, 1e-3);
    float front = clamp(t, 0.0, 1.0) * 1.5 * uCanvas;
    float dist = length(p - uSweep.xy);
    float filled = 1.0 - smoothstep(front - 160.0, front, dist);
    float edge = exp(-((dist - front) * (dist - front)) / 900.0) * (1.0 - clamp(t - 1.0, 0.0, 1.0));
    col = mix(col, uSweepColor * 0.3, filled * 0.5 * inside) + uSweepColor * edge * 0.25 * inside;
  }

  col = min(col * uDim, vec3(${HDR.floorMax.toFixed(3)}));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createFloorMaterial(shared: SharedUniforms, occupancy: THREE.Texture, canvas: number, grid: number): { material: THREE.ShaderMaterial; uniforms: FloorUniforms } {
  const uniforms: FloorUniforms = {
    uTime: shared.uTime,
    uDim: shared.uDim,
    uReduced: shared.uReduced,
    uHdr: shared.uHdr,
    uOcc: { value: occupancy },
    uGrid: new NumberUniform(grid),
    uCanvas: new NumberUniform(canvas),
    uFloor: { value: new THREE.Color(COLORS.floor) },
    uLine: { value: new THREE.Color(COLORS.gridLine) },
    uBlobs: { value: new Float32Array(FLOOR_BLOBS * 4) },
    uRipples: { value: new Float32Array(FLOOR_RIPPLES * 4) },
    uMyWall: new NumberUniform(-1),
    uMyColor: { value: new THREE.Color(0, 0, 0) },
    uSweep: { value: new THREE.Vector4(0, 0, -1, 0.6) },
    uSweepColor: { value: new THREE.Color(1, 1, 1) },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, depthWrite: true });
  material.name = 'pongo-floor';
  return { material, uniforms };
}

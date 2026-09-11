// E07 halos and light pools, and E05 intent chevrons: instanced additive quads in one draw. aHalo = (x, y, sx, sy)
// in board units, aHaloColor = (linear rgb, intensity), aHaloKind = (kind, angle about +z).

import * as THREE from 'three';
import type { SharedUniforms } from './patch';

export const HALO_KIND = { disc: 0, pool: 1, chevron: 2 } as const;

const vertexShader = /* glsl */ `
attribute vec4 aHalo;
attribute vec4 aHaloColor;
attribute vec2 aHaloKind;
varying vec2 vHaloUv;
varying vec4 vHaloColor;
varying float vHaloKind;
void main() {
  float c = cos(aHaloKind.y);
  float s = sin(aHaloKind.y);
  vec2 q = position.xy * aHalo.zw;
  q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  vHaloUv = position.xy;
  vHaloColor = aHaloColor;
  vHaloKind = aHaloKind.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(aHalo.xy + q, 0.6, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uGlow;
uniform float uDim;
uniform float uHdr;
varying vec2 vHaloUv;
varying vec4 vHaloColor;
varying float vHaloKind;
float pongoSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
void main() {
  float a;
  if (vHaloKind < 0.5) {
    a = texture2D(uGlow, vHaloUv + 0.5).r;
  } else if (vHaloKind < 1.5) {
    vec2 d = abs(vHaloUv) * 2.0;
    a = (1.0 - smoothstep(0.25, 1.0, d.x)) * (1.0 - smoothstep(0.25, 1.0, d.y));
  } else {
    float d = min(pongoSeg(vHaloUv, vec2(-0.22, 0.34), vec2(0.18, 0.0)), pongoSeg(vHaloUv, vec2(-0.22, -0.34), vec2(0.18, 0.0)));
    a = 1.0 - smoothstep(0.06, 0.13, d);
  }
  gl_FragColor = vec4(vHaloColor.rgb * vHaloColor.a * a * uDim * uHdr, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createHaloMaterial(shared: SharedUniforms, glow: THREE.Texture): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: { uGlow: { value: glow }, uDim: shared.uDim, uHdr: shared.uHdr },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  material.name = 'pongo-halo';
  return material;
}

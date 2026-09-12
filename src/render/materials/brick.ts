// E03 bricks (5.11, D11): a MeshStandardMaterial patch over a unit box scaled per instance. The bevel highlight,
// the life groove every LIFE_H units and the crack mask are computed from the local position times the instance
// scale, so they keep their size at every height. aFx = (hitT0, crack, fadeT0, flash strength): the rise delay is
// derived in the shader from the instance centre (a radial wave), which frees the fourth slot for the strength.
// Opaque with depth write (C67); the 200 ms fade dithers through alphaHash.

import * as THREE from 'three';
import { NumberUniform, patchStandard } from './patch';
import type { SharedUniforms } from './patch';
import { HDR } from '../../config/palette';
import { LIFE_H } from '../../config/constants';

/** uRise.z: 0 tiles, 1 rising, 2 lowering, 3 full height. */
export const RISE = { tiles: 0, rising: 1, lowering: 2, full: 3 } as const;

export interface BrickUniforms {
  uRise: THREE.IUniform<THREE.Vector4>;   // t0, per-cell duration, mode, tile height
  uRiseSpread: THREE.IUniform<number>;    // seconds of stagger between the centre and the farthest cell
  uRiseReach: THREE.IUniform<number>;     // board units from the centre to the farthest cell centre
}

export function createBrickMaterial(shared: SharedUniforms): { material: THREE.MeshStandardMaterial; uniforms: BrickUniforms } {
  const uniforms: BrickUniforms = {
    uRise: { value: new THREE.Vector4(0, 1, RISE.full, 1.5) },
    uRiseSpread: new NumberUniform(0),
    uRiseReach: new NumberUniform(600),
  };
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.05, alphaHash: true });
  material.name = 'pongo-brick';
  const lifeH = LIFE_H.toFixed(1);
  patchStandard(material, {
    name: 'brick',
    uniforms: { ...shared, ...uniforms },
    vertexPars: /* glsl */ `
attribute vec4 aFx;
uniform float uTime;
uniform float uReduced;
uniform vec4 uRise;
uniform float uRiseSpread;
uniform float uRiseReach;
varying vec3 vBrickLocal;
varying vec3 vBrickScale;
varying vec4 vBrickFx;
float pongoRise(vec2 centre) {
  if (uRise.z > 2.5) return 1.0;
  if (uRise.z < 0.5) return 0.0;
  float delay = uReduced > 0.5 ? 0.0 : uRiseSpread * clamp(length(centre) / max(uRiseReach, 1.0), 0.0, 1.0);
  float p = clamp((uTime - uRise.x - delay) / max(uRise.y, 1e-3), 0.0, 1.0);
  p = p * p * (3.0 - 2.0 * p);
  return uRise.z < 1.5 ? p : 1.0 - p;
}`,
    vertexBegin: /* glsl */ `
float pongoSz = length(instanceMatrix[2].xyz);
float pongoZf = mix(min(1.0, uRise.w / max(pongoSz, 1e-3)), 1.0, pongoRise(instanceMatrix[3].xy));
transformed.z *= pongoZf;
vBrickLocal = position;
vBrickScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), pongoSz * pongoZf);
vBrickFx = aFx;`,
    fragmentPars: /* glsl */ `
uniform float uTime;
uniform float uDim;
uniform float uReduced;
uniform float uHdr;
varying vec3 vBrickLocal;
varying vec3 vBrickScale;
varying vec4 vBrickFx;
vec2 pongoHash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
// Distance between the two nearest points of a jittered lattice: small along the borders, which read as cracks.
float pongoCrackEdge(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 r = g + pongoHash2(i + g) - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return sqrt(d2) - sqrt(d1);
}`,
    fragmentColor: /* glsl */ `
vec3 pongoL = vBrickLocal;
vec3 pongoS = vBrickScale;
bool pongoTop = pongoL.z > 0.999;
vec2 pongoEdgeXY = (0.5 - abs(pongoL.xy)) * pongoS.xy;
float pongoTopDist = (1.0 - pongoL.z) * pongoS.z;
float pongoEdge = pongoTop ? min(pongoEdgeXY.x, pongoEdgeXY.y)
  : (abs(pongoL.x) > 0.499 ? min(pongoEdgeXY.y, pongoTopDist) : min(pongoEdgeXY.x, pongoTopDist));
float pongoBevel = 1.0 - smoothstep(0.0, 2.0, pongoEdge);
float pongoZu = pongoL.z * pongoS.z;
float pongoG = abs(fract(pongoZu / ${lifeH} + 0.5) - 0.5) * ${lifeH};
float pongoGroove = pongoTop ? 0.0 : (1.0 - smoothstep(0.3, 0.8, pongoG)) * step(3.0, pongoZu) * step(pongoZu, pongoS.z - 3.0);
vec2 pongoCp = pongoTop ? pongoL.xy * pongoS.xy : vec2(abs(pongoL.x) > 0.499 ? pongoL.y * pongoS.y : pongoL.x * pongoS.x, pongoZu);
float pongoCrack = vBrickFx.y;
float pongoLines = pongoCrack > 0.01 ? 1.0 - smoothstep(0.0, 0.03 + 0.09 * pongoCrack, pongoCrackEdge(pongoCp / 11.0)) : 0.0;
diffuseColor.rgb *= (1.0 - 0.45 * pongoGroove) * (1.0 - 0.7 * pongoLines * pongoCrack);
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.3 + 0.03, pongoBevel * 0.7);
diffuseColor.rgb *= uDim;`,
    fragmentAlpha: /* glsl */ `
if (vBrickFx.z >= 0.0) diffuseColor.a *= 1.0 - clamp((uTime - vBrickFx.z) / 0.2, 0.0, 1.0);`,
    fragmentEmissive: /* glsl */ `
float pongoHt = uTime - vBrickFx.x;
float pongoFlash = 0.0;
if (vBrickFx.w > 0.0 && pongoHt >= 0.0 && pongoHt < 1.2) {
  pongoFlash = vBrickFx.w * (pongoHt < 0.03 ? pongoHt / 0.03 : exp(-(pongoHt - 0.03) / 0.22 * 3.0));
}
pongoFlash *= uReduced > 0.5 ? 0.5 : 1.0;
totalEmissiveRadiance += min(diffuseColor.rgb * 0.22, vec3(${HDR.brickMax.toFixed(3)})) + vec3(pongoFlash * ${HDR.flashPeak.toFixed(3)} * uHdr) * uDim;`,
  });
  return { material, uniforms };
}

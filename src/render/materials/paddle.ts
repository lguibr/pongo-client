// E04 paddles: seat-coloured slabs with an HDR edge (brighter for mine), a ghost for a Grace seat (45 % alphaHash
// stipple and a 1 Hz outline pulse), the contact flash, and the materialise and dissolve scanline.
// aFx = (hitT0, contactU, ghost, materialiseT0); aState = (flash strength, materialise mode, mine, seat).

import * as THREE from 'three';
import { patchStandard } from './patch';
import type { SharedUniforms } from './patch';
import { HDR } from '../../config/palette';

/** aState.y */
export const MATERIALISE = { none: 0, in: 1, out: 2, solidify: 3 } as const;

export function createPaddleMaterial(shared: SharedUniforms): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.15, alphaHash: true });
  material.name = 'pongo-paddle';
  patchStandard(material, {
    name: 'paddle',
    uniforms: { ...shared },
    vertexPars: /* glsl */ `
attribute vec4 aFx;
attribute vec4 aState;
varying vec3 vPadLocal;
varying vec3 vPadScale;
varying vec4 vPadFx;
varying vec4 vPadState;`,
    vertexBegin: /* glsl */ `
vPadLocal = position;
vPadScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
vPadFx = aFx;
vPadState = aState;`,
    fragmentPars: /* glsl */ `
uniform float uTime;
uniform float uDim;
uniform float uReduced;
uniform float uHdr;
varying vec3 vPadLocal;
varying vec3 vPadScale;
varying vec4 vPadFx;
varying vec4 vPadState;`,
    fragmentColor: /* glsl */ `
diffuseColor.rgb *= uDim;`,
    fragmentAlpha: /* glsl */ `
float pongoMode = vPadState.y;
float pongoSeat = vPadState.w;
float pongoAcross = pongoSeat < 0.5 ? 0.5 - vPadLocal.x : pongoSeat < 1.5 ? 0.5 - vPadLocal.y : pongoSeat < 2.5 ? vPadLocal.x + 0.5 : vPadLocal.y + 0.5;
float pongoMp = uReduced > 0.5 ? 1.0 : clamp((uTime - vPadFx.w) / (pongoMode > 2.5 ? 0.2 : 0.4), 0.0, 1.0);
if (pongoMode > 0.5 && pongoMode < 1.5) diffuseColor.a *= step(pongoAcross, pongoMp * 1.001);
else if (pongoMode > 1.5 && pongoMode < 2.5) diffuseColor.a *= step(pongoMp, pongoAcross);
float pongoGhost = vPadFx.z;
if (pongoMode > 2.5) pongoGhost *= 1.0 - pongoMp;
diffuseColor.a *= mix(1.0, 0.45, pongoGhost);`,
    fragmentEmissive: /* glsl */ `
bool pongoVert = vPadState.w < 0.5 || (vPadState.w > 1.5 && vPadState.w < 2.5);
float pongoU = pongoVert ? 0.5 - vPadLocal.y : vPadLocal.x + 0.5;
float pongoHt = uTime - vPadFx.x;
float pongoFl = 0.0;
if (vPadState.x > 0.0 && pongoHt >= 0.0 && pongoHt < 1.0) {
  float pongoEnv = pongoHt < 0.02 ? pongoHt / 0.02 : exp(-(pongoHt - 0.02) / 0.18 * 3.0);
  float pongoDu = pongoU - vPadFx.y;
  pongoFl = vPadState.x * pongoEnv * (0.35 + 0.65 * exp(-pongoDu * pongoDu / 0.045));
}
pongoFl *= uReduced > 0.5 ? 0.5 : 1.0;
bool pongoTopF = vPadLocal.z > 0.999;
vec2 pongoE2 = (0.5 - abs(vPadLocal.xy)) * vPadScale.xy;
float pongoTopD = (1.0 - vPadLocal.z) * vPadScale.z;
float pongoEd = pongoTopF ? min(pongoE2.x, pongoE2.y) : (abs(vPadLocal.x) > 0.499 ? min(pongoE2.y, pongoTopD) : min(pongoE2.x, pongoTopD));
float pongoRim = 1.0 - smoothstep(0.0, 3.0, pongoEd);
float pongoEdgeGain = ${HDR.paddleEdge.toFixed(3)} * (vPadState.z > 0.5 ? 1.3 : 1.0);
if (vPadFx.z > 0.5) pongoEdgeGain *= uReduced > 0.5 ? 0.7 : 0.45 + 0.35 * (0.5 + 0.5 * sin(6.2831853 * uTime));
vec3 pongoPe = vColor * (0.28 + pongoRim * pongoEdgeGain * uHdr) + vec3(pongoFl * ${HDR.flashPeak.toFixed(3)} * uHdr);
if (pongoMode > 0.5 && pongoMode < 2.5 && uReduced < 0.5) {
  float pongoSd = (pongoAcross - pongoMp) / 0.06;
  float pongoScan = exp(-pongoSd * pongoSd) * (1.0 - pongoMp);
  pongoPe += vColor * pongoScan * 2.0 * uHdr;
}
totalEmissiveRadiance += pongoPe * uDim;`,
  });
  return material;
}

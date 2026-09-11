// E06 balls and E32 expiry warning: an owner-colour HDR core with a fresnel rim, a hotter core and a dashed rim for
// a temporary ball, the rim blinking 2 -> 6 Hz from 9.5 s of age while the core dims, a 50 % dither while phasing,
// and the dissolve. alphaHash is always on (C59). aBall = (core gain, alpha, phasing, age in seconds or -1 when
// permanent); instanceColor is the owner colour, cross-faded on the CPU.

import * as THREE from 'three';
import { patchStandard } from './patch';
import type { SharedUniforms } from './patch';

export function createBallMaterial(shared: SharedUniforms): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0, alphaHash: true });
  material.name = 'pongo-ball';
  patchStandard(material, {
    name: 'ball',
    uniforms: { ...shared },
    vertexPars: /* glsl */ `
attribute vec4 aBall;
varying vec4 vBall;
varying vec3 vBallLocal;`,
    vertexBegin: /* glsl */ `
vBall = aBall;
vBallLocal = position;`,
    fragmentPars: /* glsl */ `
uniform float uTime;
uniform float uDim;
uniform float uReduced;
uniform float uHdr;
varying vec4 vBall;
varying vec3 vBallLocal;`,
    fragmentColor: /* glsl */ `
diffuseColor.rgb *= 0.18 * uDim;`,
    fragmentAlpha: /* glsl */ `
diffuseColor.a *= vBall.y * (vBall.z > 0.5 ? 0.5 : 1.0);`,
    fragmentEmissive: /* glsl */ `
vec3 pongoView = normalize(vViewPosition);
float pongoFres = pow(1.0 - clamp(abs(dot(normalize(normal), pongoView)), 0.0, 1.0), 2.5);
float pongoCore = vBall.x;
float pongoRimK = 0.9;
float pongoAge = vBall.w;
if (pongoAge >= 0.0) {
  pongoCore *= 1.2;
  float pongoDash = step(0.5, fract(atan(vBallLocal.y, vBallLocal.x) / 6.2831853 * 10.0));
  pongoRimK *= 0.35 + 0.65 * pongoDash;
  if (pongoAge >= 9.5) {
    float pongoK = smoothstep(9.5, 13.5, pongoAge);
    float pongoBlink = uReduced > 0.5 ? 0.55 : step(0.5, fract(pongoAge * mix(2.0, 6.0, pongoK)));
    pongoRimK *= pongoBlink;
    pongoCore *= 1.0 - 0.6 * pongoK;
  }
}
if (vBall.z > 0.5) pongoCore *= 0.5;
totalEmissiveRadiance += vColor * (pongoCore * (0.55 + 0.45 * (1.0 - pongoFres)) + pongoFres * pongoRimK * pongoCore * 0.6) * uHdr * uDim;`,
  });
  return material;
}

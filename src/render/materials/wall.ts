// E02 walls: slabs in the seat colour (emissive at most HDR.wallMax), a desaturated 0.5 Hz pulse for a Grace seat,
// graphite for an Empty one, a glow for a ready seat in the lobby, and the event flashes (bounce, goal, absorb,
// phase). instanceColor is the base colour; aFx = (t0, u, strength, kind); aSeat = (grace, ready, mine, wall).

import * as THREE from 'three';
import { NumberUniform, patchStandard } from './patch';
import type { SharedUniforms } from './patch';
import { COLORS, HDR } from '../../config/palette';

export const WALL_KIND = { bounce: 0, goal: 1, absorb: 2, phase: 3 } as const;

export interface WallUniforms {
  uCanvas: THREE.IUniform<number>;
  uBreathe: THREE.IUniform<THREE.Vector2>;   // t0, duration (presentation seconds)
  uWinner: THREE.IUniform<THREE.Vector4>;    // linear rgb, t0 (-1 = none)
  uWinnerDur: THREE.IUniform<number>;
  uDanger: THREE.IUniform<THREE.Color>;
}

function glslColor(hex: string): string {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
}

export function createWallMaterial(shared: SharedUniforms, canvas: number): { material: THREE.MeshStandardMaterial; uniforms: WallUniforms } {
  const uniforms: WallUniforms = {
    uCanvas: new NumberUniform(canvas),
    uBreathe: { value: new THREE.Vector2(-10, 1) },
    uWinner: { value: new THREE.Vector4(1, 1, 1, -1) },
    uWinnerDur: new NumberUniform(0.6),
    uDanger: { value: new THREE.Color(COLORS.danger) },
  };
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.1 });
  material.name = 'pongo-wall';
  patchStandard(material, {
    name: 'wall',
    uniforms: { ...shared, ...uniforms },
    vertexPars: /* glsl */ `
attribute vec4 aFx;
attribute vec4 aSeat;
uniform float uCanvas;
varying vec4 vWallFx;
varying vec4 vWallSeat;
varying float vWallU;`,
    vertexBegin: /* glsl */ `
vWallFx = aFx;
vWallSeat = aSeat;
vec4 pongoWallPos = instanceMatrix * vec4(position, 1.0);
bool pongoVertical = aSeat.w < 0.5 || (aSeat.w > 1.5 && aSeat.w < 2.5);
vWallU = pongoVertical ? (0.5 * uCanvas - pongoWallPos.y) / uCanvas : (pongoWallPos.x + 0.5 * uCanvas) / uCanvas;`,
    fragmentPars: /* glsl */ `
uniform float uTime;
uniform float uDim;
uniform float uReduced;
uniform float uHdr;
uniform float uCanvas;
uniform vec2 uBreathe;
uniform vec4 uWinner;
uniform float uWinnerDur;
uniform vec3 uDanger;
varying vec4 vWallFx;
varying vec4 vWallSeat;
varying float vWallU;`,
    fragmentColor: /* glsl */ `
float pongoWl = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
if (vWallSeat.x > 0.5) diffuseColor.rgb = mix(vec3(pongoWl), diffuseColor.rgb, 0.3);
diffuseColor.rgb *= uDim;`,
    fragmentEmissive: /* glsl */ `
float pongoGlow = 0.42;
if (vWallSeat.x > 0.5) pongoGlow *= uReduced > 0.5 ? 0.6 : 0.45 + 0.3 * sin(3.14159265 * uTime);
if (vWallSeat.y > 0.5) pongoGlow *= 1.7;
if (vWallSeat.z > 0.5) pongoGlow *= 1.25;
float pongoBr = clamp((uTime - uBreathe.x) / max(uBreathe.y, 1e-3), 0.0, 1.0);
pongoGlow *= 1.0 + 0.6 * sin(3.14159265 * pongoBr);
vec3 pongoWe = min(diffuseColor.rgb * pongoGlow, vec3(${HDR.wallMax.toFixed(3)}));
if (uWinner.w >= 0.0) {
  float pongoWp = clamp((uTime - uWinner.w) / max(uWinnerDur, 1e-3), 0.0, 1.0);
  pongoWe = mix(pongoWe, uWinner.rgb * ${HDR.wallMax.toFixed(3)} * uDim, pongoWp);
}
float pongoWt = uTime - vWallFx.x;
if (vWallFx.z > 0.0 && pongoWt >= 0.0 && pongoWt < 0.8) {
  float pongoDu = (vWallU - vWallFx.y) * uCanvas;
  float pongoF = 0.0;
  vec3 pongoFc = vec3(1.0);
  if (vWallFx.w < 0.5) {
    pongoF = exp(-pongoDu * pongoDu / 1800.0) * exp(-pongoWt / 0.14 * 3.0);
  } else if (vWallFx.w < 1.5) {
    float pongoP = pongoWt / 0.35;
    float pongoReach = min(pongoP * 3.0, 1.0) * uCanvas;
    pongoF = step(abs(pongoDu), pongoReach) * (1.0 - smoothstep(0.8, 1.6, pongoP));
    pongoFc = pongoP < 0.33 ? mix(vec3(1.0), vColor, pongoP / 0.33) : mix(vColor, uDanger, clamp((pongoP - 0.33) / 0.33, 0.0, 1.0));
  } else if (vWallFx.w < 2.5) {
    float pongoRing = abs(abs(pongoDu) - pongoWt * 500.0);
    pongoF = exp(-pongoRing * pongoRing / 400.0) * max(0.0, 1.0 - pongoWt / 0.45);
    pongoFc = vec3(0.75);
  } else {
    pongoF = exp(-pongoDu * pongoDu / 2400.0) * (0.65 + 0.35 * sin(pongoWt * 70.0)) * exp(-pongoWt / 0.2 * 3.0);
    pongoFc = ${glslColor(COLORS.phase)};
  }
  pongoWe += pongoFc * pongoF * vWallFx.z * ${HDR.flashPeak.toFixed(3)} * uHdr * (uReduced > 0.5 ? 0.5 : 1.0) * uDim;
}
totalEmissiveRadiance += pongoWe;`,
  });
  return { material, uniforms };
}

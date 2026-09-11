// Shards (6.2): a MeshStandardMaterial patched through render/materials/patch.ts patchStandard. The box tumbles by a
// Rodrigues rotation about its axis by spin * t, its centre follows the same closed-form ballistic path as a spark,
// every vertex is clamped at the floor (z = 0), and it shrinks out over the last 30 % of its life. The normal is
// rotated with it (vNormal is recomputed after begin_vertex, which three r176 places after normal_vertex).

export const SHARD_VERTEX_PARS = /* glsl */ `
uniform float uFxTime;
attribute vec4 aStart;      // x, y, z (board-local), t0 (s)
attribute vec4 aVel;        // vx, vy, vz (units/s), gravity (units/s^2)
attribute vec4 aAxisSpin;   // rotation axis, spin (rad/s)
attribute vec4 aColorLife;  // linear r, g, b, life (s)
attribute vec4 aSize;       // scale x, y, z, drag (1/s)
varying vec3 vShardColor;
vec3 fxRotate(vec3 v, vec3 k, float a) {
  float c = cos(a);
  float s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
`;

export const SHARD_VERTEX_BEGIN = /* glsl */ `
float fxT = uFxTime - aStart.w;
float fxLife = aColorLife.w;
vShardColor = aColorLife.rgb;
if (fxT < 0.0 || fxT >= fxLife) {
  transformed = vec3(0.0, 0.0, -10.0);
} else {
  float fxDrag = aSize.w;
  float fxK = fxDrag > 1e-4 ? (1.0 - exp(-fxDrag * fxT)) / fxDrag : fxT;
  vec3 fxC = aStart.xyz + aVel.xyz * fxK;
  fxC.z -= 0.5 * aVel.w * fxT * fxT;
  fxC.z = max(fxC.z, 0.0);
  float fxShrink = 1.0 - smoothstep(0.7 * fxLife, fxLife, fxT);
  vec3 fxAxis = normalize(aAxisSpin.xyz + vec3(1e-6, 0.0, 0.0));
  float fxAng = aAxisSpin.w * fxT;
  transformed = fxC + fxRotate(position * aSize.xyz * fxShrink, fxAxis, fxAng);
  transformed.z = max(transformed.z, 0.0);
  #ifndef FLAT_SHADED
  vNormal = normalize(normalMatrix * fxRotate(objectNormal, fxAxis, fxAng));
  #endif
}
`;

export const SHARD_FRAGMENT_PARS = /* glsl */ `
varying vec3 vShardColor;
`;

export const SHARD_FRAGMENT_COLOR = /* glsl */ `
diffuseColor.rgb *= vShardColor;
`;

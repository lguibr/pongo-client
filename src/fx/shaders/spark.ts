// Sparks (6.2): velocity-stretched instanced quads (D12), not gl.POINTS. Position is closed-form in the vertex shader:
// p = p0 + v (1 - e^(-drag t)) / drag + 1/2 g t^2 (gravity along -z), clamped at the floor; the quad is a billboard
// stretched along the instantaneous velocity in view space; alpha = 1 - t/life. Additive, so only the HDR colour
// (above 1.0) blooms (D10).

export const SPARK_VERTEX = /* glsl */ `
uniform float uFxTime;
attribute vec4 aStart;   // x, y, z (board-local), t0 (s)
attribute vec4 aVel;     // vx, vy, vz (units/s), life (s)
attribute vec4 aColor;   // linear r, g, b, hdr
attribute vec4 aParams;  // size, drag (1/s), gravity (units/s^2), stretch (s of motion added to the length)
varying vec4 vColor;
varying vec2 vUv;
void main() {
  float t = uFxTime - aStart.w;
  float life = aVel.w;
  vUv = position.xy * 2.0;
  if (t < 0.0 || t >= life) {
    vColor = vec4(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float drag = aParams.y;
  float ed = exp(-drag * t);
  float k = drag > 1e-4 ? (1.0 - ed) / drag : t;
  vec3 p = aStart.xyz + aVel.xyz * k;
  p.z -= 0.5 * aParams.z * t * t;
  vec3 v = aVel.xyz * ed;
  v.z -= aParams.z * t;
  if (p.z < 0.5) {
    p.z = 0.5;
    v.z = 0.0;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec2 vv = (modelViewMatrix * vec4(v, 0.0)).xy;
  float sp = length(vv);
  vec2 dir = sp > 1e-3 ? vv / sp : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float size = aParams.x;
  float len = size + sp * aParams.w;
  mv.xy += dir * (position.x * len) + perp * (position.y * size);
  gl_Position = projectionMatrix * mv;
  vColor = vec4(aColor.rgb * aColor.a, 1.0 - t / life);
}
`;

export const SPARK_FRAGMENT = /* glsl */ `
uniform float uHdr;
varying vec4 vColor;
varying vec2 vUv;
void main() {
  float m = 1.0 - smoothstep(0.3, 1.0, length(vUv));
  gl_FragColor = vec4(vColor.rgb * uHdr, vColor.a * m);
}
`;

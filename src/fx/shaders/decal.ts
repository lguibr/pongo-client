// Decals (6.2): floor quads that fade over `dur`. Blending is premultiplied (src ONE, dst ONE_MINUS_SRC_ALPHA), so a
// fragment both darkens (alpha) and adds an ember glow (rgb). Kind 0 is a scorch: a ragged square that darkens the
// floor with a hot rim. Kind 1 is a soft additive glow disc (the reduced-motion winner glow, E45).

export const DECAL_VERTEX = /* glsl */ `
uniform float uFxTime;
attribute vec4 aCenter;  // x, y, z (board-local), rotation (rad)
attribute vec4 aParams;  // half size, t0 (s), dur (s), kind
attribute vec4 aColor;   // linear ember r, g, b, strength
varying vec2 vUv;
varying float vFade;
varying float vKind;
varying vec4 vColor;
void main() {
  float t = uFxTime - aParams.y;
  if (t < 0.0 || t >= aParams.z) {
    vUv = vec2(0.0);
    vFade = 0.0;
    vKind = 0.0;
    vColor = vec4(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float c = cos(aCenter.w);
  float s = sin(aCenter.w);
  vec2 q = position.xy * 2.0 * aParams.x;
  q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  vUv = position.xy * 2.0;
  vFade = 1.0 - t / aParams.z;
  vKind = aParams.w;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(aCenter.xyz + vec3(q, 0.0), 1.0);
}
`;

export const DECAL_FRAGMENT = /* glsl */ `
uniform float uHdr;
varying vec2 vUv;
varying float vFade;
varying float vKind;
varying vec4 vColor;
float fxHash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
void main() {
  if (vKind < 0.5) {
    vec2 a = abs(vUv);
    float box = max(a.x, a.y);
    float n = fxHash(floor(vUv * 5.0 + 11.0)) * 0.2;
    float body = 1.0 - smoothstep(0.6 - n, 0.95 - n, box);
    float rim = body * smoothstep(0.3, 0.8, box);
    float dark = 0.7 * body * vFade;
    vec3 ember = vColor.rgb * vColor.a * rim * vFade * vFade * uHdr;
    gl_FragColor = vec4(ember, dark);
  } else {
    float g = 1.0 - smoothstep(0.0, 1.0, length(vUv));
    gl_FragColor = vec4(vColor.rgb * vColor.a * g * g * vFade * uHdr, 0.0);
  }
}
`;

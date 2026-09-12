// Rings (6.2): a flat quad with an additive SDF ring. radius = mix(r0, r1, easeOut(t / dur)); r1 < r0 gives an
// implosion. The quad grows with the radius, so it covers only the ring.

export const RING_VERTEX = /* glsl */ `
uniform float uFxTime;
attribute vec4 aCenter;  // x, y, z (board-local), t0 (s)
attribute vec4 aParams;  // r0, r1, dur (s), width
attribute vec4 aColor;   // linear r, g, b, hdr
varying vec2 vLocal;
varying float vR;
varying float vW;
varying vec4 vColor;
void main() {
  float t = uFxTime - aCenter.w;
  float dur = aParams.z;
  if (t < 0.0 || t >= dur) {
    vLocal = vec2(0.0);
    vR = 0.0;
    vW = 1.0;
    vColor = vec4(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float x = t / dur;
  float u = 1.0 - x;
  float r = mix(aParams.x, aParams.y, 1.0 - u * u * u);
  float w = max(aParams.w, 0.5);
  float ext = r + 2.0 * w;
  vLocal = position.xy * 2.0 * ext;
  vR = r;
  vW = w;
  vColor = vec4(aColor.rgb * aColor.a, u * sqrt(u));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(aCenter.xyz + vec3(vLocal, 0.0), 1.0);
}
`;

export const RING_FRAGMENT = /* glsl */ `
uniform float uHdr;
varying vec2 vLocal;
varying float vR;
varying float vW;
varying vec4 vColor;
void main() {
  float d = abs(length(vLocal) - vR);
  float band = 1.0 - smoothstep(0.0, vW, d);
  gl_FragColor = vec4(vColor.rgb * uHdr, vColor.a * band);
}
`;

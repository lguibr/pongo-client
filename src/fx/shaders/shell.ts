// Phasing shells (E34, C62, C68): an additive HDR violet fresnel on an icosphere, with no transmission. Kind 0 is
// the shell, 1 an echo, 3 the collapse (same look, driven by alpha and radius from the CPU). Kind 2 is the depleting
// timer ring: the icosphere is flattened onto its centre plane, where the upper hemisphere faces the camera and the
// lower one is culled, and the fragment keeps a band whose angular share is the remaining phase time.

export const SHELL_VERTEX = /* glsl */ `
attribute vec4 aCenter;  // x, y, z (board-local), radius
attribute vec4 aParams;  // alpha, fill (timer ring: remaining share), kind, unused
varying float vFres;
varying float vAlpha;
varying float vFill;
varying float vKind;
varying vec2 vLocal;
void main() {
  vAlpha = aParams.x;
  vFill = aParams.y;
  vKind = aParams.z;
  if (aParams.z > 1.5 && aParams.z < 2.5) {
    // 1.15 keeps the band inside the flattened icosphere's polygonal outline
    vLocal = position.xy * 1.15;
    vFres = 0.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(aCenter.xyz + vec3(vLocal * aCenter.w, 0.0), 1.0);
    return;
  }
  vec4 mv = modelViewMatrix * vec4(aCenter.xyz + position * aCenter.w, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vFres = pow(1.0 - abs(dot(n, normalize(-mv.xyz))), 2.5);
  vLocal = vec2(0.0);
  gl_Position = projectionMatrix * mv;
}
`;

export const SHELL_FRAGMENT = /* glsl */ `
uniform vec3 uPhase;
uniform float uHdr;
varying float vFres;
varying float vAlpha;
varying float vFill;
varying float vKind;
varying vec2 vLocal;
void main() {
  float a;
  if (vKind > 1.5 && vKind < 2.5) {
    float d = length(vLocal);
    float band = smoothstep(0.8, 0.86, d) * (1.0 - smoothstep(0.94, 1.0, d));
    float share = atan(vLocal.x, vLocal.y) / 6.2831853 + 0.5;
    if (share > vFill) discard;
    a = band * vAlpha;
  } else {
    a = (0.12 + vFres) * vAlpha;
  }
  gl_FragColor = vec4(uPhase * uHdr, a);
}
`;

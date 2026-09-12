// Ball trails (E36, D13, C61): one geometry for every ball. Each point keeps the colour index it was sampled with, so
// an ownership change sweeps along the ribbon. Width tapers with age; a point older than its ball's length has zero
// width and alpha, so the ribbon ends in a tapered tip at its true sampled position.

export const TRAIL_VERTEX = /* glsl */ `
uniform float uFxTime;
uniform float uLen[64];   // trail length per ball slot (s)
uniform vec3 uColors[6];  // seats 0..3, unowned, phasing violet (linear, trail HDR included)
uniform float uHdr;
attribute vec4 aQ;        // ribbon normal x, y, half width, colour index
attribute float aT;       // sample time (s)
attribute vec2 aS;        // side (-1 or 1), ball slot
varying vec3 vColor;
varying float vAlpha;
varying float vSide;
void main() {
  float len = uLen[int(aS.y + 0.5)];
  float age = uFxTime - aT;
  float k = len > 0.0 ? clamp(age / len, 0.0, 1.0) : 1.0;
  float w = aQ.z * (1.0 - k);
  vec3 p = position + vec3(aQ.xy * (aS.x * w), 0.0);
  vColor = uColors[int(aQ.w + 0.5)] * uHdr;
  vAlpha = (1.0 - k) * (1.0 - k);
  vSide = aS.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const TRAIL_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vSide;
void main() {
  float edge = 1.0 - 0.6 * vSide * vSide;
  gl_FragColor = vec4(vColor, vAlpha * edge);
}
`;

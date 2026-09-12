// A custom postprocessing Effect: saturation, exposure, an additive colour flash and an edge tint (the vignette
// pulse). It sits in the one merged EffectPass (D09) before tone mapping, so it works on HDR values.

import { BlendFunction, Effect } from 'postprocessing';
import * as THREE from 'three';

const fragmentShader = /* glsl */ `
uniform float uSaturation;
uniform float uExposure;
uniform vec3 uFlashColor;
uniform float uFlashAmount;
uniform vec3 uTint;
uniform float uTintAmount;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb * uExposure;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c += uFlashColor * uFlashAmount;
  float edge = smoothstep(0.35, 0.95, length(uv - 0.5) * 1.41421356);
  c = mix(c, uTint, clamp(uTintAmount * edge, 0.0, 1.0));
  outputColor = vec4(c, inputColor.a);
}
`;

interface GradeUniforms {
  saturation: THREE.Uniform<number>;
  exposure: THREE.Uniform<number>;
  flashColor: THREE.Uniform<THREE.Color>;
  flashAmount: THREE.Uniform<number>;
  tint: THREE.Uniform<THREE.Color>;
  tintAmount: THREE.Uniform<number>;
}

export class GradeEffect extends Effect {
  private readonly u: GradeUniforms;

  constructor() {
    const u: GradeUniforms = {
      saturation: new THREE.Uniform(1),
      exposure: new THREE.Uniform(1),
      flashColor: new THREE.Uniform(new THREE.Color(1, 1, 1)),
      flashAmount: new THREE.Uniform(0),
      tint: new THREE.Uniform(new THREE.Color(0, 0, 0)),
      tintAmount: new THREE.Uniform(0),
    };
    super('GradeEffect', fragmentShader, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['uSaturation', u.saturation],
        ['uExposure', u.exposure],
        ['uFlashColor', u.flashColor],
        ['uFlashAmount', u.flashAmount],
        ['uTint', u.tint],
        ['uTintAmount', u.tintAmount],
      ]),
    });
    this.u = u;
  }

  get saturation(): number {
    return this.u.saturation.value;
  }

  set saturation(v: number) {
    this.u.saturation.value = v;
  }

  get exposure(): number {
    return this.u.exposure.value;
  }

  set exposure(v: number) {
    this.u.exposure.value = v;
  }

  get flashAmount(): number {
    return this.u.flashAmount.value;
  }

  set flashAmount(v: number) {
    this.u.flashAmount.value = v;
  }

  get tintAmount(): number {
    return this.u.tintAmount.value;
  }

  set tintAmount(v: number) {
    this.u.tintAmount.value = v;
  }

  /** The flash colour (linear); written in place. */
  get flashColor(): THREE.Color {
    return this.u.flashColor.value;
  }

  /** The edge tint colour (linear); written in place. */
  get tint(): THREE.Color {
    return this.u.tint.value;
  }
}

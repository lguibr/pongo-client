// Post-processing (6.4, D09, D29). High and medium tiers: an imperative postprocessing 6.38 EffectComposer with one
// RenderPass and one merged EffectPass (ChromaticAberration, Bloom, Grade, Vignette, ACES tone mapping). The Canvas
// is `flat`, so the chain owns tone mapping. Low tier: no composer, renderer ACES and a direct render; the PostFx
// methods are no-ops there. The frame loop is the only caller of render() (D09).
//
// The scene's draw count is read right after the RenderPass (CountingRenderPass), because postprocessing calls
// renderer.render once per pass and the loop runs with gl.info.autoReset off (2.5 step 7).

import * as THREE from 'three';
import {
  BloomEffect, ChromaticAberrationEffect, EffectComposer, EffectPass, RenderPass, ToneMappingEffect, ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import type { PostFx, Tier } from '../contracts';
import { GradeEffect } from './GradeEffect';

// levels 6: 1 luminance + 6 downsamples + 5 upsamples (MipmapBlurPass keeps levels - 1 upsampling targets) + the
// EffectPass = 13 post draws per frame on high and medium, within the budget of 14 (section 10).
const BLOOM = { luminanceThreshold: 1.0, luminanceSmoothing: 0.2, intensity: 1.1, radius: 0.7, levels: 6 } as const;
const LOW_BIT_THRESHOLD = 0.85;   // 6.4: the UnsignedByte fallback

/** A BloomEffect whose luminance and mip-blur passes run at `scale` of the drawing buffer. Under mipmapBlur,
 *  resolution.scale sizes only renderTarget and the Kawase blurPass, which never run (postprocessing 6.38), so
 *  medium's half-resolution bloom is applied here. EffectComposer.setSize reaches this on every call, even at an
 *  unchanged size, so a tier change takes effect on the next fit. */
export class ScaledBloom extends BloomEffect {
  scale = 1;

  setSize(width: number, height: number): void {
    super.setSize(width, height);
    if (this.scale === 1) return;
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    this.luminancePass.setSize(w, h);
    this.mipmapBlurPass.setSize(w, h);
  }
}

export type PostEffects = readonly [ChromaticAberrationEffect, ScaledBloom, GradeEffect, VignetteEffect, ToneMappingEffect];

/** The merged EffectPass's effects, in shader order. EffectPass sorts its effects by attribute, highest first, and
 *  ChromaticAberration is the only CONVOLUTION effect, so it runs first whatever the argument order; listing it
 *  first keeps the source equal to the shader. As the first effect its inputColor is the inputBuffer it resamples
 *  red and blue from, so it drops nothing; after Bloom it would drop the bloom's red and blue. Bloom is not a
 *  convolution effect, so the five still merge (6.4 merge legality). */
export function buildEffects(lowBit: boolean): PostEffects {
  const aberration = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0, 0), radialModulation: true, modulationOffset: 0.15 });
  const bloom = new ScaledBloom({
    mipmapBlur: true,
    levels: BLOOM.levels,
    luminanceThreshold: lowBit ? LOW_BIT_THRESHOLD : BLOOM.luminanceThreshold,
    luminanceSmoothing: BLOOM.luminanceSmoothing,
    intensity: BLOOM.intensity,
    radius: BLOOM.radius,
  });
  const grade = new GradeEffect();
  const vignette = new VignetteEffect({ offset: 0.35, darkness: 0.55 });
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
  return [aberration, bloom, grade, vignette, tone];
}

class CountingRenderPass extends RenderPass {
  calls = 0;
  triangles = 0;

  render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, outputBuffer: THREE.WebGLRenderTarget, deltaTime?: number, stencilTest?: boolean): void {
    super.render(renderer, inputBuffer, outputBuffer, deltaTime, stencilTest);
    this.calls = renderer.info.render.calls;
    this.triangles = renderer.info.render.triangles;
  }
}

interface Chain {
  composer: EffectComposer;
  pass: CountingRenderPass;
  bloom: ScaledBloom;
  aberration: ChromaticAberrationEffect;
  grade: GradeEffect;
  vignette: VignetteEffect;
  tone: ToneMappingEffect;
  effectPass: EffectPass;
}

/** True when half-float colour buffers can be rendered to (6.4 HalfFloat probe). */
function halfFloatRenderable(gl: THREE.WebGLRenderer): boolean {
  return gl.extensions.has('EXT_color_buffer_half_float') || gl.extensions.has('EXT_color_buffer_float');
}

export class PostPipeline implements PostFx {
  /** Scene draws and triangles of the last render (the RenderPass only, or the direct render on low). */
  sceneCalls = 0;
  sceneTriangles = 0;
  /** True when the composer runs on 8-bit buffers: HDR constants are then scaled by HDR.lowBitScale. */
  readonly lowBit: boolean;
  private readonly gl: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private chain: Chain | null = null;
  private current: Tier;
  // Envelopes, in seconds of real time.
  private flashT = 0;
  private flashDur = 0;
  private flashAmt = 0;
  private abT = 0;
  private abDur = 0;
  private abAmt = 0;
  private satFrom = 1;
  private satTo = 1;
  private satT = 0;
  private satDur = 0;
  private satNow = 1;
  private vigT = 0;
  private vigDur = 0;
  private vigAmt = 0;
  private boostT = 0;
  private boostDur = 0;
  private boostAmt = 0;
  private readonly flashColorV = new THREE.Color(1, 1, 1);
  private readonly tintV = new THREE.Color(0, 0, 0);
  private readonly colors = new Map<string, THREE.Color>();
  private readonly sizeV = new THREE.Vector2();

  constructor(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, tier: Tier) {
    this.gl = gl;
    this.scene = scene;
    this.camera = camera;
    this.lowBit = !halfFloatRenderable(gl);
    this.current = tier;
    this.apply(tier);
  }

  get enabled(): boolean {
    return this.chain !== null;
  }

  get tier(): Tier {
    return this.current;
  }

  /** The one render of the frame: the composer, or a direct render on the low tier. */
  render(dtS: number): void {
    const chain = this.chain;
    if (chain === null) {
      this.gl.render(this.scene, this.camera);
      this.sceneCalls = this.gl.info.render.calls;
      this.sceneTriangles = this.gl.info.render.triangles;
      return;
    }
    this.advance(dtS, chain);
    chain.composer.render(dtS);
    this.sceneCalls = chain.pass.calls;
    this.sceneTriangles = chain.pass.triangles;
  }

  /** Resizes the composer's buffers to the renderer's current drawing buffer. Fiber sizes the renderer; given the
   *  renderer's own size, postprocessing never calls renderer.setSize, so it cannot fight fiber over the canvas. */
  setSize(): void {
    if (this.chain !== null) this.fit(this.chain);
  }

  setTier(t: Tier): void {
    if (t === this.current) return;
    this.current = t;
    this.apply(t);
  }

  dispose(): void {
    this.destroyChain();
  }

  flash(c: string, a: number, s: number): void {
    if (this.chain === null) return;
    this.flashColorV.copy(this.color(c));
    this.flashAmt = a;
    this.flashDur = s > 0 ? s : 0.001;
    this.flashT = 0;
  }

  aberration(a: number, s: number): void {
    if (this.chain === null) return;
    this.abAmt = a;
    this.abDur = s > 0 ? s : 0.001;
    this.abT = 0;
  }

  saturation(t: number, s: number): void {
    this.satFrom = this.satNow;
    this.satTo = t;
    this.satDur = s > 0 ? s : 0;
    this.satT = 0;
    if (this.satDur === 0) this.satNow = t;
    if (this.chain !== null) this.chain.grade.saturation = this.satNow;
  }

  vignettePulse(c: string, a: number, s: number): void {
    if (this.chain === null) return;
    this.tintV.copy(this.color(c));
    this.vigAmt = a;
    this.vigDur = s > 0 ? s : 0.001;
    this.vigT = 0;
  }

  bloomBoost(a: number, s: number): void {
    if (this.chain === null) return;
    this.boostAmt = a;
    this.boostDur = s > 0 ? s : 0.001;
    this.boostT = 0;
  }

  private color(c: string): THREE.Color {
    let v = this.colors.get(c);
    if (v === undefined) {
      v = new THREE.Color(c);
      this.colors.set(c, v);
    }
    return v;
  }

  private advance(dtS: number, chain: Chain): void {
    const dt = dtS > 0 ? dtS : 0;
    // Flash: an ease-out from its peak.
    let flash = 0;
    if (this.flashT < this.flashDur) {
      this.flashT += dt;
      const u = 1 - Math.min(1, this.flashT / this.flashDur);
      flash = this.flashAmt * u * u;
    }
    chain.grade.flashAmount = flash;
    chain.grade.flashColor.copy(this.flashColorV);
    // Aberration: a linear decay.
    let ab = 0;
    if (this.abT < this.abDur) {
      this.abT += dt;
      ab = this.abAmt * (1 - Math.min(1, this.abT / this.abDur));
    }
    chain.aberration.offset.set(ab, ab);
    // Saturation: an eased ramp that holds its target.
    if (this.satT < this.satDur) {
      this.satT += dt;
      const x = Math.min(1, this.satT / this.satDur);
      this.satNow = this.satFrom + (this.satTo - this.satFrom) * x * x * (3 - 2 * x);
    } else {
      this.satNow = this.satTo;
    }
    chain.grade.saturation = this.satNow;
    // Vignette pulse: up and back down.
    let vig = 0;
    if (this.vigT < this.vigDur) {
      this.vigT += dt;
      vig = this.vigAmt * Math.sin(Math.PI * Math.min(1, this.vigT / this.vigDur));
    }
    chain.grade.tintAmount = vig;
    chain.grade.tint.copy(this.tintV);
    // Bloom boost: a linear decay back to the base intensity.
    let boost = 0;
    if (this.boostT < this.boostDur) {
      this.boostT += dt;
      boost = this.boostAmt * (1 - Math.min(1, this.boostT / this.boostDur));
    }
    chain.bloom.intensity = BLOOM.intensity + boost;
  }

  private apply(tier: Tier): void {
    if (tier === 'low') {
      this.destroyChain();
      // EffectComposer.setRenderer turned autoClear off and dispose() does not restore it; the direct render
      // needs it to clear to the background colour. A rebuilt chain turns it off again.
      this.gl.autoClear = true;
      this.gl.toneMapping = THREE.ACESFilmicToneMapping;
      return;
    }
    this.gl.toneMapping = THREE.NoToneMapping;
    if (this.chain === null) this.chain = this.buildChain(tier);
    this.chain.composer.multisampling = tier === 'high' ? 4 : 2;
    this.chain.bloom.scale = tier === 'medium' ? 0.5 : 1;   // applied by the fit below
    this.fit(this.chain);
  }

  /** EffectComposer.setSize compares its arguments with renderer.getSize and calls renderer.setSize when they
   *  differ; passing that same size makes it size only its own buffers and passes. */
  private fit(chain: Chain): void {
    const size = this.gl.getSize(this.sizeV);
    chain.composer.setSize(size.x, size.y);
  }

  private buildChain(tier: Tier): Chain {
    const composer = new EffectComposer(this.gl, {
      frameBufferType: this.lowBit ? THREE.UnsignedByteType : THREE.HalfFloatType,
      multisampling: tier === 'high' ? 4 : 2,
    });
    const pass = new CountingRenderPass(this.scene, this.camera);
    const effects = buildEffects(this.lowBit);
    const [aberration, bloom, grade, vignette, tone] = effects;
    grade.saturation = this.satNow;
    const effectPass = new EffectPass(this.camera, ...effects);
    composer.addPass(pass);
    composer.addPass(effectPass);
    return { composer, pass, bloom, aberration, grade, vignette, tone, effectPass };
  }

  private destroyChain(): void {
    const chain = this.chain;
    if (chain === null) return;
    this.chain = null;
    chain.composer.dispose();   // disposes its passes, and the EffectPass its effects
  }
}

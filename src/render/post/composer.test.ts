// The post chain's effects in node: pass order and merge legality (render-1), medium's half-size bloom under
// mipmapBlur (render-2), and the bloom's draws against the 14-draw post budget (browser-D3).

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BloomEffect, ChromaticAberrationEffect, EffectPass, ToneMappingEffect, VignetteEffect } from 'postprocessing';
import type { Effect } from 'postprocessing';
import { GradeEffect } from './GradeEffect';
import { ScaledBloom, buildEffects } from './composer';

/** MipmapBlurPass members its typings do not declare. */
interface MipView { resolution: THREE.Vector2; downsamplingMipmaps: THREE.WebGLRenderTarget[]; upsamplingMipmaps: THREE.WebGLRenderTarget[] }
const mips = (b: BloomEffect): MipView => b.mipmapBlurPass as unknown as MipView;
const luminanceSize = (b: BloomEffect): [number, number] => {
  const t = (b.luminancePass as unknown as { renderTarget: THREE.WebGLRenderTarget }).renderTarget;
  return [t.width, t.height];
};
const effectsOf = (p: EffectPass): Effect[] => (p as unknown as { effects: Effect[] }).effects;

/** A renderer that only counts draws: enough for BloomEffect.update in node. */
function countingRenderer(): { renderer: THREE.WebGLRenderer; calls: () => number } {
  let calls = 0;
  const renderer = {
    setRenderTarget: () => {},
    render: () => {
      calls++;
    },
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, calls: () => calls };
}

describe('buildEffects', () => {
  it('returns the effects in pass order: aberration, bloom, grade, vignette, tone mapping', () => {
    const effects = buildEffects(false);
    const kinds = [ChromaticAberrationEffect, BloomEffect, GradeEffect, VignetteEffect, ToneMappingEffect];
    expect(effects).toHaveLength(kinds.length);
    effects.forEach((e, i) => expect(e).toBeInstanceOf(kinds[i]));
    expect(effects[1]).toBeInstanceOf(ScaledBloom);
  });

  it('merges into one EffectPass that keeps that order', () => {
    const effects = buildEffects(false);
    const pass = new EffectPass(new THREE.PerspectiveCamera(), ...effects);
    expect(effectsOf(pass).map((e) => e.name)).toEqual(['ChromaticAberrationEffect', 'BloomEffect', 'GradeEffect', 'VignetteEffect', 'ToneMappingEffect']);
    expect(() => pass.recompile()).not.toThrow();
    pass.dispose();
  });

  it('runs the merge check in node (control: two convolution effects are refused)', () => {
    const pass = new EffectPass(new THREE.PerspectiveCamera(), new ChromaticAberrationEffect(), new ChromaticAberrationEffect());
    expect(() => pass.recompile()).toThrow(/Convolution effects cannot be merged/);
  });

  it('uses the low-bit luminance threshold on 8-bit buffers', () => {
    expect(buildEffects(true)[1].luminanceMaterial.threshold).toBeCloseTo(0.85);
    expect(buildEffects(false)[1].luminanceMaterial.threshold).toBeCloseTo(1.0);
  });
});

describe('ScaledBloom', () => {
  it('runs the luminance and mip-blur passes at half the size at scale 0.5', () => {
    const bloom = new ScaledBloom({ mipmapBlur: true, levels: 6 });
    bloom.scale = 0.5;
    bloom.setSize(1000, 800);
    const m = mips(bloom);
    expect([m.resolution.x, m.resolution.y]).toEqual([500, 400]);
    expect([m.downsamplingMipmaps[0].width, m.downsamplingMipmaps[0].height]).toEqual([250, 200]);
    expect(luminanceSize(bloom)).toEqual([500, 400]);
  });

  it('runs them at the full size at scale 1', () => {
    const bloom = new ScaledBloom({ mipmapBlur: true, levels: 6 });
    bloom.setSize(1000, 800);
    const m = mips(bloom);
    expect([m.resolution.x, m.resolution.y]).toEqual([1000, 800]);
    expect([m.downsamplingMipmaps[0].width, m.downsamplingMipmaps[0].height]).toEqual([500, 400]);
    expect(luminanceSize(bloom)).toEqual([1000, 800]);
  });

  it('applies a scale change on the next setSize at an unchanged size (a high to medium fit)', () => {
    const bloom = new ScaledBloom({ mipmapBlur: true, levels: 6 });
    bloom.setSize(1000, 800);
    bloom.scale = 0.5;
    bloom.setSize(1000, 800);
    expect([mips(bloom).resolution.x, mips(bloom).resolution.y]).toEqual([500, 400]);
    bloom.scale = 1;
    bloom.setSize(1000, 800);
    expect([mips(bloom).resolution.x, mips(bloom).resolution.y]).toEqual([1000, 800]);
  });
});

describe('post draw budget', () => {
  it.each([1, 0.5])('the chain bloom at scale %s draws 12, and with the EffectPass 13 <= 14', (scale) => {
    const bloom = buildEffects(false)[1];
    bloom.scale = scale;
    const m = mips(bloom);
    expect(m.downsamplingMipmaps).toHaveLength(6);
    expect(m.upsamplingMipmaps).toHaveLength(5);
    expect(1 + m.downsamplingMipmaps.length + m.upsamplingMipmaps.length + 1).toBeLessThanOrEqual(14);

    const { renderer, calls } = countingRenderer();
    bloom.setSize(1000, 800);
    bloom.update(renderer, new THREE.WebGLRenderTarget(1000, 800), 1 / 60);
    expect(calls()).toBe(12);
    expect(calls() + 1).toBeLessThanOrEqual(14);
  });
});

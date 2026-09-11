import { describe, expect, it } from 'vitest';
import { FIXTURES, FIXTURE_GAPS, loadFixture } from './load';

describe('loadFixture', () => {
  it('reads one frame per non-empty line', () => {
    const raw = [
      '{"t":0,"c":"A","dir":"out","d":"{\\"messageType\\":\\"quickPlay\\",\\"sessionId\\":\\"x\\"}"}',
      '',
      '{"t":12.5,"c":"A","dir":"in","d":"{}"}',
      '   ',
    ].join('\n');
    expect(loadFixture(raw)).toEqual([
      { t: 0, c: 'A', dir: 'out', d: '{"messageType":"quickPlay","sessionId":"x"}' },
      { t: 12.5, c: 'A', dir: 'in', d: '{}' },
    ]);
  });

  it('names the line of a bad frame', () => {
    expect(() => loadFixture('{"t":0,"c":"A","dir":"in","d":"{}"}\n{"t":1')).toThrow(/line 2/);
    expect(() => loadFixture('{"t":0,"c":"D","dir":"in","d":"{}"}')).toThrow(/line 1/);
  });

  it('keys FIXTURES by file name without the extension', () => {
    for (const name of Object.keys(FIXTURES)) expect(name).toMatch(/^[\w-]+$/);
  });

  it('declares every jump over 10 s as a gap, and each declared gap matches its recording', () => {
    const LONG_MS = 10_000;
    for (const name of Object.keys(FIXTURE_GAPS)) expect(Object.keys(FIXTURES), `gap for ${name}`).toContain(name);
    for (const [name, raw] of Object.entries(FIXTURES)) {
      const ts = loadFixture(raw).map((f) => f.t);
      const declared = FIXTURE_GAPS[name] ?? [];
      for (const g of declared) {
        expect(ts, `${name}: frame at the gap start`).toContain(g.from);
        expect(ts, `${name}: frame at the gap end`).toContain(g.to);
        expect(ts.filter((t) => t > g.from && t < g.to), `${name}: frames inside the gap`).toEqual([]);
      }
      for (let i = 1; i < ts.length; i++) {
        if (ts[i] - ts[i - 1] <= LONG_MS) continue;
        expect(declared, `${name}: undeclared jump ${ts[i - 1]} -> ${ts[i]}`).toContainEqual({ from: ts[i - 1], to: ts[i] });
      }
    }
  });
});

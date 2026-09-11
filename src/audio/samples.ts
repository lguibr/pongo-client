// SampleBank (7.2): the 9 recorded files, fetched after the first `running` state with an AbortController
// and decoded once. The service worker serves them from its CacheFirst `pongo-sounds` route (vite.config.ts),
// never from the precache (C15, C81, C87). A file that fails to load stays null until the next `load()`,
// which the engine calls on every `running` state, fetches it again. While it is missing, a cue with a
// procedural layer plays only that layer, and a sample-only cue (another seat's paddle, a standalone gained
// or lost) is dropped.

import type { AudioDeps } from './types';
import { log } from '../lib/log';

export const SAMPLE_URLS: Readonly<Record<'hit0' | 'hit1' | 'hit2' | 'hit3' | 'hit4' | 'gained0' | 'gained1' | 'lost0' | 'lost1', string>> = {
  hit0: '/sounds/sfx/hit_0.wav',
  hit1: '/sounds/sfx/hit_1.wav',
  hit2: '/sounds/sfx/hit_2.wav',
  hit3: '/sounds/sfx/hit_3.wav',
  hit4: '/sounds/sfx/hit_4.wav',
  gained0: '/sounds/sfx/gained_0.wav',
  gained1: '/sounds/sfx/gained_1.wav',
  lost0: '/sounds/sfx/lost_0.wav',
  lost1: '/sounds/sfx/lost_1.wav',
};
export type SampleName = keyof typeof SAMPLE_URLS;
export const SAMPLE_NAMES = Object.keys(SAMPLE_URLS) as SampleName[];

type FetchBytes = NonNullable<AudioDeps['fetchBytes']>;

export const fetchBytesDefault: FetchBytes = async (url, signal) => {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.arrayBuffer();
};

export class SampleBank {
  private readonly ctx: AudioContext;
  private readonly fetchBytes: FetchBytes;
  private readonly buffers = new Map<SampleName, AudioBuffer>();
  private abort: AbortController | null = null;
  private loading: Promise<void> | null = null;
  private disposed = false;

  constructor(ctx: AudioContext, fetchBytes: AudioDeps['fetchBytes']) {
    this.ctx = ctx;
    this.fetchBytes = fetchBytes ?? fetchBytesDefault;
  }

  /** Fetches and decodes every file not yet held. Calls made while a load is in flight, or after one that got
   *  every file, return the same promise, which never rejects. After a load in which a file failed, the next
   *  call retries only the missing files. */
  load(): Promise<void> {
    if (this.loading !== null) return this.loading;
    if (this.disposed) return Promise.resolve();
    const missing = SAMPLE_NAMES.filter((n) => !this.buffers.has(n));
    const abort = new AbortController();
    this.abort = abort;
    let failed = 0;
    const one = async (name: SampleName): Promise<void> => {
      try {
        const bytes = await this.fetchBytes(SAMPLE_URLS[name], abort.signal);
        if (this.disposed) return;
        const buf = await this.ctx.decodeAudioData(bytes);
        if (!this.disposed) this.buffers.set(name, buf);
      } catch (err) {
        failed++;
        if (!this.disposed) log.warn(`audio: sample ${name} unavailable`, err);
      }
    };
    this.loading = Promise.all(missing.map(one)).then(() => {
      if (failed > 0 && !this.disposed) this.loading = null;
    });
    return this.loading;
  }

  get(name: SampleName): AudioBuffer | null {
    return this.buffers.get(name) ?? null;
  }

  /** Aborts any fetch in flight and drops the buffers. */
  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    this.abort = null;
    this.buffers.clear();
  }
}

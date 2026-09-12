// A minimal AudioContext for tests: state transitions (including iOS 'interrupted'), a controllable
// currentTime, and a recorder of every node, connection, parameter automation and scheduled start.
// Use `ctx.asAudioContext()` (or `FakeAudioContext.factory()`) where the app expects a real AudioContext.

export type FakeAudioState = 'suspended' | 'running' | 'closed' | 'interrupted';

export interface ParamEvent { type: 'set' | 'linear' | 'exponential' | 'target' | 'curve' | 'cancel' | 'cancelAndHold'; value: number; time: number; extra?: number }

export class FakeAudioParam {
  value: number;
  readonly defaultValue: number;
  readonly events: ParamEvent[] = [];
  constructor(value: number) {
    this.value = value;
    this.defaultValue = value;
  }
  setValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'set', value, time });
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'linear', value, time });
    this.value = value;
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'exponential', value, time });
    this.value = value;
    return this;
  }
  setTargetAtTime(value: number, time: number, timeConstant: number): this {
    this.events.push({ type: 'target', value, time, extra: timeConstant });
    this.value = value;
    return this;
  }
  setValueCurveAtTime(values: ArrayLike<number>, time: number, duration: number): this {
    const last = values.length > 0 ? values[values.length - 1] : this.value;
    this.events.push({ type: 'curve', value: last, time, extra: duration });
    this.value = last;
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.events.push({ type: 'cancel', value: this.value, time });
    return this;
  }
  cancelAndHoldAtTime(time: number): this {
    this.events.push({ type: 'cancelAndHold', value: this.value, time });
    return this;
  }
}

export type FakeDestination = FakeAudioNode | FakeAudioParam;

export class FakeAudioNode {
  readonly context: FakeAudioContext;
  readonly kind: string;
  readonly outputs: FakeDestination[] = [];
  channelCount = 2;
  constructor(context: FakeAudioContext, kind: string) {
    this.context = context;
    this.kind = kind;
    context.nodes.push(this);
  }
  connect<D extends FakeDestination>(dest: D): D {
    this.outputs.push(dest);
    this.context.edges.push({ from: this, to: dest });
    return dest;
  }
  disconnect(dest?: FakeDestination): void {
    const keep = (d: FakeDestination): boolean => dest !== undefined && d !== dest;
    const kept = this.outputs.filter(keep);
    this.outputs.length = 0;
    this.outputs.push(...kept);
    const edges = this.context.edges.filter((e) => e.from !== this || keep(e.to));
    this.context.edges.length = 0;
    this.context.edges.push(...edges);
  }
}

export class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam(1);
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'gain');
  }
}

export class FakeScheduledSource extends FakeAudioNode {
  onended: ((ev: Event) => void) | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  private readonly endedListeners: ((ev: Event) => void)[] = [];
  start(when = 0): void {
    if (this.startedAt !== null) throw new Error('InvalidStateError: start() called twice');
    this.startedAt = when;
    this.context.started.push({ node: this, when });
  }
  stop(when = 0): void {
    this.stoppedAt = when;
  }
  addEventListener(type: string, fn: (ev: Event) => void): void {
    if (type === 'ended') this.endedListeners.push(fn);
  }
  removeEventListener(type: string, fn: (ev: Event) => void): void {
    const i = type === 'ended' ? this.endedListeners.indexOf(fn) : -1;
    if (i >= 0) this.endedListeners.splice(i, 1);
  }
  /** Test helper: delivers the `ended` event. */
  fireEnded(): void {
    const ev = new Event('ended');
    this.onended?.(ev);
    for (const fn of this.endedListeners.slice()) fn(ev);
  }
}

export class FakeBufferSource extends FakeScheduledSource {
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate = new FakeAudioParam(1);
  readonly detune = new FakeAudioParam(0);
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'bufferSource');
  }
}

export class FakeOscillator extends FakeScheduledSource {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeAudioParam(440);
  readonly detune = new FakeAudioParam(0);
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'oscillator');
  }
  setPeriodicWave(): void {
    this.type = 'custom';
  }
}

export class FakeConstantSource extends FakeScheduledSource {
  readonly offset = new FakeAudioParam(1);
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'constantSource');
  }
}

export class FakeBiquadFilter extends FakeAudioNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeAudioParam(350);
  readonly Q = new FakeAudioParam(1);
  readonly gain = new FakeAudioParam(0);
  readonly detune = new FakeAudioParam(0);
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'biquad');
  }
}

export class FakeStereoPanner extends FakeAudioNode {
  readonly pan = new FakeAudioParam(0);
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'stereoPanner');
  }
}

export class FakeCompressor extends FakeAudioNode {
  readonly threshold = new FakeAudioParam(-24);
  readonly knee = new FakeAudioParam(30);
  readonly ratio = new FakeAudioParam(12);
  readonly attack = new FakeAudioParam(0.003);
  readonly release = new FakeAudioParam(0.25);
  readonly reduction = 0;
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'compressor');
  }
}

export class FakeDelay extends FakeAudioNode {
  readonly delayTime = new FakeAudioParam(0);
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'delay');
  }
}

export class FakeWaveShaper extends FakeAudioNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'waveShaper');
  }
}

export class FakeConvolver extends FakeAudioNode {
  buffer: FakeAudioBuffer | null = null;
  normalize = true;
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'convolver');
  }
}

export class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly channels: Float32Array[];
  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
  copyToChannel(source: Float32Array, channel: number, offset = 0): void {
    this.channels[channel].set(source, offset);
  }
}

export interface FakeAudioOptions {
  state?: FakeAudioState;          // initial state; default 'suspended', as a context made outside a gesture
  sampleRate?: number;
  /** What resume() does: 'resolve' (default) runs the context, 'reject' fails, 'pending' never settles. */
  resume?: 'resolve' | 'reject' | 'pending';
  /** decodeAudioData fails when true. */
  decodeFails?: boolean;
}

export class FakeAudioContext extends EventTarget {
  /** Every instance created since the last reset(), for "one context" assertions. */
  static readonly instances: FakeAudioContext[] = [];
  static reset(): void {
    FakeAudioContext.instances.length = 0;
  }
  /** A createContext dependency that makes a new fake on every call. */
  static factory(opts?: FakeAudioOptions): () => AudioContext {
    return () => new FakeAudioContext(opts).asAudioContext();
  }

  readonly nodes: FakeAudioNode[] = [];
  readonly edges: { from: FakeAudioNode; to: FakeDestination }[] = [];
  readonly started: { node: FakeScheduledSource; when: number }[] = [];
  readonly calls = { resume: 0, suspend: 0, close: 0, decode: 0 };
  readonly sampleRate: number;
  readonly destination: FakeAudioNode;
  readonly baseLatency = 0.01;
  readonly outputLatency = 0;
  currentTime = 0;
  onstatechange: ((ev: Event) => void) | null = null;
  resumeBehavior: 'resolve' | 'reject' | 'pending';
  decodeFails: boolean;
  private stateValue: FakeAudioState;

  constructor(opts: FakeAudioOptions = {}) {
    super();
    this.stateValue = opts.state ?? 'suspended';
    this.sampleRate = opts.sampleRate ?? 48000;
    this.resumeBehavior = opts.resume ?? 'resolve';
    this.decodeFails = opts.decodeFails ?? false;
    this.destination = new FakeAudioNode(this, 'destination');
    FakeAudioContext.instances.push(this);
  }

  get state(): FakeAudioState {
    return this.stateValue;
  }

  asAudioContext(): AudioContext {
    return this as unknown as AudioContext;
  }

  /** Test helper: moves to `s` and fires statechange (for example 'interrupted' from the OS). */
  setState(s: FakeAudioState): void {
    if (this.stateValue === s) return;
    this.stateValue = s;
    const ev = new Event('statechange');
    this.onstatechange?.(ev);
    this.dispatchEvent(ev);
  }

  /** Test helper: advances currentTime by `seconds`. */
  advanceTime(seconds: number): void {
    this.currentTime += seconds;
  }

  resume(): Promise<void> {
    this.calls.resume++;
    if (this.stateValue === 'closed') return Promise.reject(new Error('InvalidStateError: context is closed'));
    if (this.resumeBehavior === 'pending') return new Promise<void>(() => {});
    if (this.resumeBehavior === 'reject') return Promise.reject(new Error('NotAllowedError: resume refused'));
    this.setState('running');
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.calls.suspend++;
    if (this.stateValue === 'closed') return Promise.reject(new Error('InvalidStateError: context is closed'));
    this.setState('suspended');
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.calls.close++;
    this.setState('closed');
    return Promise.resolve();
  }

  createGain(): FakeGainNode { return new FakeGainNode(this); }
  createBufferSource(): FakeBufferSource { return new FakeBufferSource(this); }
  createOscillator(): FakeOscillator { return new FakeOscillator(this); }
  createConstantSource(): FakeConstantSource { return new FakeConstantSource(this); }
  createBiquadFilter(): FakeBiquadFilter { return new FakeBiquadFilter(this); }
  createStereoPanner(): FakeStereoPanner { return new FakeStereoPanner(this); }
  createDynamicsCompressor(): FakeCompressor { return new FakeCompressor(this); }
  createDelay(): FakeDelay { return new FakeDelay(this); }
  createWaveShaper(): FakeWaveShaper { return new FakeWaveShaper(this); }
  createConvolver(): FakeConvolver { return new FakeConvolver(this); }
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(numberOfChannels, length, sampleRate);
  }
  createPeriodicWave(): object {
    return {};
  }

  decodeAudioData(
    _bytes: ArrayBuffer,
    success?: (buffer: FakeAudioBuffer) => void,
    failure?: (err: Error) => void,
  ): Promise<FakeAudioBuffer> {
    this.calls.decode++;
    if (this.decodeFails) {
      const err = new Error('EncodingError: cannot decode');
      failure?.(err);
      return Promise.reject(err);
    }
    const buffer = new FakeAudioBuffer(1, Math.max(1, Math.round(this.sampleRate * 0.1)), this.sampleRate);
    success?.(buffer);
    return Promise.resolve(buffer);
  }

  /** True when `node` reaches `target` (default: the destination) through recorded connections. */
  reaches(node: FakeAudioNode, target: FakeDestination = this.destination): boolean {
    const seen = new Set<FakeDestination>();
    const walk = (d: FakeDestination): boolean => {
      if (d === target) return true;
      if (seen.has(d) || !(d instanceof FakeAudioNode)) return false;
      seen.add(d);
      return d.outputs.some(walk);
    };
    return walk(node);
  }

  /** Recorded nodes of one kind, in creation order. */
  nodesOf(kind: string): FakeAudioNode[] {
    return this.nodes.filter((n) => n.kind === kind);
  }
}

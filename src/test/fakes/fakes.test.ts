import { describe, expect, it } from 'vitest';
import { FakeClock } from './FakeClock';
import { FakeAudioContext } from './FakeAudioContext';
import { createFakeSocketServer } from './fakeSocket';
import { createFakeApp } from './fakeApp';
import { MAX_BALLS } from '../../config/constants';

describe('FakeClock', () => {
  it('fires timers in due order at their own times, including ones scheduled while advancing', () => {
    const clock = new FakeClock(1000);
    const log: string[] = [];
    clock.setTimeout(() => log.push(`b@${clock.now()}`), 20);
    clock.setTimeout(() => {
      log.push(`a@${clock.now()}`);
      clock.setTimeout(() => log.push(`c@${clock.now()}`), 5);
    }, 10);
    const cancelled = clock.setTimeout(() => log.push('never'), 15);
    clock.clearTimeout(cancelled);
    clock.advance(30);
    expect(log).toEqual(['a@1010', 'c@1015', 'b@1020']);
    expect(clock.now()).toBe(1030);
    expect(clock.pending).toBe(0);
  });

  it('runAll stops a timer loop', () => {
    const clock = new FakeClock();
    const loop = (): void => {
      clock.setTimeout(loop, 1);
    };
    loop();
    expect(() => clock.runAll(50)).toThrow(/more than 50/);
  });
});

describe('FakeAudioContext', () => {
  it('moves between states and records the node graph', async () => {
    FakeAudioContext.reset();
    const ctx = new FakeAudioContext();
    const states: string[] = [];
    ctx.addEventListener('statechange', () => states.push(ctx.state));
    expect(ctx.state).toBe('suspended');
    await ctx.resume();
    ctx.setState('interrupted');
    expect(states).toEqual(['running', 'interrupted']);

    const gain = ctx.createGain();
    const src = ctx.createBufferSource();
    src.connect(gain).connect(ctx.destination);
    gain.gain.setValueAtTime(0.5, 0.1);
    src.start(0.2);
    expect(ctx.reaches(src)).toBe(true);
    expect(ctx.started).toEqual([{ node: src, when: 0.2 }]);
    expect(gain.gain.events).toEqual([{ type: 'set', value: 0.5, time: 0.1 }]);
    gain.disconnect();
    expect(ctx.reaches(src)).toBe(false);
    expect(FakeAudioContext.instances).toEqual([ctx]);
  });
});

describe('fakeSocket', () => {
  it('connects a factory socket and passes text both ways', async () => {
    const fake = createFakeSocketServer('ws://fakes.test/subscribe');
    try {
      const ws = fake.factory(fake.url);
      await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));
      expect(fake.connections).toHaveLength(1);
      const got = new Promise<string>((resolve) => ws.addEventListener('message', (e) => resolve(String((e as MessageEvent).data))));
      fake.send({ messageType: 'roomCreated', code: 'ABC123', roomPID: 'p' });
      expect(JSON.parse(await got)).toMatchObject({ code: 'ABC123' });
      const heard = new Promise<string>((resolve) => fake.onMessage((text) => resolve(text)));
      ws.send('{"messageType":"quickPlay","sessionId":"s"}');
      expect(await heard).toContain('quickPlay');
      expect(fake.received).toHaveLength(1);
      const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve((e as CloseEvent).code)));
      fake.close(4002, 'bye');
      expect(await closed).toBe(4002);
    } finally {
      await fake.stop();
    }
  });
});

describe('createFakeApp', () => {
  it('has a real store and inert ports', () => {
    const app = createFakeApp({ state: { net: { unstable: true } } });
    expect(app.store.get().net.unstable).toBe(true);
    expect(app.session.setReady(true)).toBe(false);
    expect(app.session.getModel().state.s).toBe('idle');
    expect(app.game.render.ballId).toHaveLength(MAX_BALLS);
    expect(app.game.render.ballId[0]).toBe(-1);
    expect(app.game.ingest({ messageType: 'gameUpdates', updates: [] }, 0).controls).toEqual([]);
    app.settings.update({ sfxMuted: true });
    expect(app.settings.get().sfxMuted).toBe(true);
  });
});

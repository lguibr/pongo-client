/** @vitest-environment jsdom */
// useRoomBinding (9.3) against the real session runtime, with a scripted transport and a fake clock: how many
// sockets open, when the deferred leave fires (and when a remount cancels it), and where the URL ends up.

import { StrictMode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType, useParams } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../../app/AppContext';
import { createSessionRuntime } from '../../session/runtime';
import type { CloseCode, IdentityApi, SessionApi, TransportLike, TransportSink } from '../../session/types';
import { createStore } from '../../lib/store';
import { initialAppState } from '../../state/appStore';
import { FakeClock } from '../../test/fakes/FakeClock';
import { createFakeApp, fakeAudio, fakeGame, fakeInput } from '../../test/fakes/fakeApp';
import { useRoomBinding } from './useRoomBinding';

/** A TransportLike whose server side the test drives. */
class ScriptedTransport implements TransportLike {
  sink: TransportSink | null = null;
  readonly opens: number[] = [];
  readonly closes: Array<{ gen: number; code: CloseCode }> = [];
  readonly sent: string[] = [];
  currentGen = 0;
  isOpen = false;

  setSink(sink: TransportSink): void {
    this.sink = sink;
  }

  open(gen: number): void {
    this.opens.push(gen);
    this.currentGen = gen;
    this.isOpen = false;
  }

  send(gen: number, text: string): boolean {
    if (gen !== this.currentGen || !this.isOpen) return false;
    this.sent.push(text);
    return true;
  }

  close(gen: number, code: CloseCode): void {
    this.closes.push({ gen, code });
    if (gen === this.currentGen) this.isOpen = false;
  }

  accept(): void {
    this.isOpen = true;
    this.sink?.open(this.currentGen);
  }

  deliver(msg: object): void {
    this.sink?.frame(this.currentGen, JSON.stringify(msg), 0);
  }
}

const identity: IdentityApi = {
  ready: Promise.resolve(), current: () => 'sid-test', rotate: () => {}, hasPrevious: () => false,
  restorePrevious: () => false, onPageHide: () => {}, onPageShow: () => Promise.resolve(),
};

const joined = (code: string): object => ({ messageType: 'roomJoined', success: true, roomPID: 'pid', code, phase: 'lobby', reason: '' });
const assigned = (playerIndex: number): object => ({ messageType: 'playerAssignment', playerIndex, phase: 'lobby' });

interface Where { path: string; type: string; nav: NavigateFunction | null }

function Probe({ out }: { out: Where }): null {
  const location = useLocation();
  const type = useNavigationType();
  const nav = useNavigate();
  out.path = location.pathname;
  out.type = type;
  out.nav = nav;
  return null;
}

function Harness(): JSX.Element {
  const { code } = useParams();
  const { invalid } = useRoomBinding(code);
  return <p data-testid="room" data-invalid={String(invalid)}>room</p>;
}

interface Mounted {
  clock: FakeClock; transport: ScriptedTransport; session: SessionApi; where: Where; unmount: () => void;
  /** Re-renders the same route with a fresh harness instance (a new React key), as Fast Refresh does. */
  remount: () => void;
}

async function mount(path: string, opts: { strict?: boolean; before?: (s: SessionApi) => void } = {}): Promise<Mounted> {
  const clock = new FakeClock(10_000);
  const transport = new ScriptedTransport();
  const store = createStore(initialAppState());
  const session = createSessionRuntime({
    transport, game: fakeGame(), input: fakeInput(), audio: fakeAudio(), identity, store,
    wsUrl: () => 'ws://test.invalid/subscribe', timers: clock, now: clock.now, rand: () => 0.5,
  });
  // Let identity.ready settle, so every socket.open reaches the transport synchronously.
  await Promise.resolve();
  await Promise.resolve();
  opts.before?.(session);
  const where: Where = { path: '', type: '', nav: null };
  const app = createFakeApp({ store, session });
  let instance = 0;
  const tree = (): JSX.Element => {
    const t = (
      <AppProvider app={app}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/" element={<p>landing</p>} />
            <Route path="/room/:code?" element={<Harness key={instance} />} />
          </Routes>
          <Probe out={where} />
        </MemoryRouter>
      </AppProvider>
    );
    return opts.strict ? <StrictMode>{t}</StrictMode> : t;
  };
  const r = render(tree());
  const remount = (): void => {
    instance += 1;
    r.rerender(tree());
  };
  return { clock, transport, session, where, unmount: r.unmount, remount };
}

afterEach(cleanup);

describe('useRoomBinding', () => {
  it('binds a valid code once under StrictMode: one socket, and the simulated unmount never leaves', async () => {
    const w = await mount('/room/ABC123', { strict: true });
    expect(w.transport.opens).toEqual([1]);
    act(() => w.clock.advance(50));
    expect(w.session.getModel().state.s).toBe('connecting');
    expect(w.transport.closes).toEqual([]);
    expect(w.where.path).toBe('/room/ABC123');
  });

  it('a real unmount leaves one macrotask later', async () => {
    const w = await mount('/room/ABC123');
    w.unmount();
    expect(w.session.getModel().state.s).toBe('connecting');
    w.clock.advance(0);
    expect(w.session.getModel().state.s).toBe('idle');
    expect(w.transport.closes).toEqual([{ gen: 1, code: 1000 }]);
  });

  it('a remounted screen (a new instance, as under Fast Refresh) cancels the previous instance\'s deferred leave', async () => {
    const w = await mount('/room/ABC123');
    expect(w.transport.opens).toEqual([1]);
    act(() => w.remount()); // one commit: instance A unmounts and unbinds, instance B mounts and binds
    act(() => w.clock.advance(50));
    const s = w.session.getModel().state;
    expect(s.s).toBe('connecting');
    expect(s.s === 'connecting' ? s.intent : null).toEqual({ kind: 'join', code: 'ABC123' });
    expect(w.transport.opens).toEqual([1]);
    expect(w.transport.closes).toEqual([]);
    expect(w.where.path).toBe('/room/ABC123');

    w.unmount(); // the binding B holds is still live: a real unmount leaves as before
    w.clock.advance(0);
    expect(w.session.getModel().state.s).toBe('idle');
    expect(w.transport.closes).toEqual([{ gen: 1, code: 1000 }]);
  });

  it.each(['zzz', 'ABC12', 'GGGGGG', 'ABC1234'])('an invalid code (%s) is reported and opens no socket', async (code) => {
    const w = await mount('/room/' + code);
    expect(screen.getByTestId('room').dataset.invalid).toBe('true');
    act(() => w.clock.advance(50));
    expect(w.transport.opens).toEqual([]);
    expect(w.session.getModel().state.s).toBe('idle');
    expect(w.where.path).toBe('/room/' + code);
  });

  it('a reload of /room while idle goes home, replacing the history entry', async () => {
    const w = await mount('/room');
    expect(screen.getByText('landing')).toBeTruthy();
    expect(w.where.path).toBe('/');
    expect(w.where.type).toBe('REPLACE');
    expect(w.transport.opens).toEqual([]);
  });

  it('/room during a quick play keeps the intent, then takes the room code into the URL without a second socket', async () => {
    const w = await mount('/room', { before: (s) => s.start({ kind: 'quick' }) });
    expect(w.where.path).toBe('/room');
    expect(w.transport.opens).toEqual([1]);

    act(() => w.transport.accept());
    expect(w.transport.sent).toHaveLength(1);
    act(() => w.transport.deliver(joined('ABC123')));
    expect(w.where.path).toBe('/room/ABC123');
    expect(w.where.type).toBe('REPLACE');

    act(() => w.clock.advance(50)); // a leave deferred by the param change would fire here
    expect(w.session.getModel().state.s).toBe('requesting');
    act(() => w.transport.deliver(assigned(1)));
    expect(w.session.getModel().state.s).toBe('lobby');
    expect(w.transport.opens).toEqual([1]);
    expect(w.transport.closes).toEqual([]);
  });

  it('a lower-case code binds once, and the URL is replaced with the normalised code', async () => {
    const w = await mount('/room/abc123');
    expect(w.where.path).toBe('/room/ABC123');
    expect(w.where.type).toBe('REPLACE');
    act(() => w.clock.advance(50));
    expect(w.session.getModel().state.s).toBe('connecting');
    expect(w.transport.opens).toEqual([1]);
  });

  it('a restart that moves from /room/CODE to /room re-binds with the same key, so the new intent is kept', async () => {
    const w = await mount('/room/ABC123');
    act(() => {
      w.session.start({ kind: 'quick' }); // what "Quick play again" does before navigating to /room
      w.where.nav?.('/room');
    });
    act(() => w.clock.advance(50));
    const s = w.session.getModel().state;
    expect(s.s).toBe('connecting');
    expect(s.s === 'connecting' ? s.intent : null).toEqual({ kind: 'quick' });
    expect(w.where.path).toBe('/room');
    expect(w.transport.opens).toHaveLength(2);
  });
});

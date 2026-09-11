import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'mock-socket';
import { Transport } from './transport';
import type { SocketFactory } from './transport';
import type { TransportSink } from '../session/types';
import { createFakeSocketServer } from '../test/fakes/fakeSocket';
import type { FakeSocketServer } from '../test/fakes/fakeSocket';

type Heard = { kind: 'open' | 'frame' | 'closed'; gen: number; text?: string; at?: number; code?: number };

function recordingSink(): TransportSink & { heard: Heard[] } {
  const heard: Heard[] = [];
  return {
    heard,
    open: (gen) => heard.push({ kind: 'open', gen }),
    frame: (gen, text, at) => heard.push({ kind: 'frame', gen, text, at }),
    closed: (gen, ev) => heard.push({ kind: 'closed', gen, code: ev.code }),
  };
}

/** mock-socket delivers every event on a 4 ms timer. */
const settle = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('Transport with mock-socket', () => {
  let fake: FakeSocketServer;
  let serverCloses: Array<{ conn: number; code: number }>;

  beforeEach(() => {
    fake = createFakeSocketServer('ws://transport.test/subscribe');
    serverCloses = [];
    fake.onConnection((c: Client) => {
      const conn = fake.connections.indexOf(c);
      // mock-socket passes the CloseEvent to the listener, although its typings declare `() => void`.
      const on = c.on.bind(c) as (type: 'close', fn: (e: CloseEvent) => void) => void;
      on('close', (e) => serverCloses.push({ conn, code: e.code }));
    });
  });

  afterEach(async () => {
    await fake.stop();
  });

  it('opens, receives text frames stamped with now(), and sends', async () => {
    let t = 1000;
    const tr = new Transport(fake.factory, () => t);
    const sink = recordingSink();
    tr.setSink(sink);
    tr.open(1, fake.url);
    expect(tr.currentGen).toBe(1);
    expect(tr.isOpen).toBe(false);
    expect(tr.send(1, 'early')).toBe(false); // CONNECTING: never queued
    await settle();
    expect(tr.isOpen).toBe(true);
    expect(sink.heard).toEqual([{ kind: 'open', gen: 1 }]);

    t = 1234;
    fake.send('{"messageType":"gameUpdates","updates":[]}');
    await settle();
    expect(sink.heard[1]).toEqual({ kind: 'frame', gen: 1, text: '{"messageType":"gameUpdates","updates":[]}', at: 1234 });

    expect(tr.send(1, 'hello')).toBe(true);
    await settle();
    expect(fake.received).toEqual(['hello']); // 'early' never arrived
  });

  it('reports a server close to the sink', async () => {
    const tr = new Transport(fake.factory);
    const sink = recordingSink();
    tr.setSink(sink);
    tr.open(3, fake.url);
    await settle();
    fake.close(4321, 'server says bye');
    await settle();
    expect(sink.heard).toEqual([{ kind: 'open', gen: 3 }, { kind: 'closed', gen: 3, code: 4321 }]);
    expect(tr.isOpen).toBe(false);
    expect(tr.send(3, 'x')).toBe(false);
  });

  it('never reports a deliberate close', async () => {
    const tr = new Transport(fake.factory);
    const sink = recordingSink();
    tr.setSink(sink);
    tr.open(1, fake.url);
    await settle();
    tr.close(1, 4002, 'rejected');
    expect(tr.isOpen).toBe(false);
    await settle();
    expect(sink.heard).toEqual([{ kind: 'open', gen: 1 }]);
    expect(serverCloses).toEqual([{ conn: 0, code: 4002 }]);
    expect(tr.send(1, 'late')).toBe(false);
  });

  it('supersedes the current socket with 4001 and ignores everything from it', async () => {
    const tr = new Transport(fake.factory);
    const sink = recordingSink();
    tr.setSink(sink);
    tr.open(1, fake.url);
    await settle();
    const first = fake.connections[0];

    tr.open(2, fake.url);
    expect(tr.currentGen).toBe(2);
    await settle();
    expect(serverCloses).toEqual([{ conn: 0, code: 4001 }]);
    expect(fake.connections).toHaveLength(2);

    // The old connection can no longer speak to the sink.
    first.send('from the old socket');
    await settle();
    expect(sink.heard).toEqual([{ kind: 'open', gen: 1 }, { kind: 'open', gen: 2 }]);
    expect(tr.send(1, 'stale gen')).toBe(false);
    expect(tr.send(2, 'current gen')).toBe(true);
    await settle();
    expect(fake.received).toEqual(['current gen']);
  });

  it('ignores a close request for a generation that is not current', async () => {
    const tr = new Transport(fake.factory);
    const sink = recordingSink();
    tr.setSink(sink);
    tr.open(1, fake.url);
    await settle();
    tr.open(2, fake.url);
    await settle();
    tr.close(1, 1000, 'leave'); // an old effect must not close the newer socket
    expect(tr.isOpen).toBe(true);
    await settle();
    expect(serverCloses).toEqual([{ conn: 0, code: 4001 }]); // only the supersede; connection 1 stays up
    expect(tr.send(2, 'still here')).toBe(true);
  });

  it('supersedes a socket that is still connecting without it ever reaching the sink', async () => {
    const tr = new Transport(fake.factory);
    const sink = recordingSink();
    tr.setSink(sink);
    tr.open(1, fake.url);
    tr.open(2, fake.url);
    await settle();
    expect(sink.heard).toEqual([{ kind: 'open', gen: 2 }]);
    expect(fake.connections).toHaveLength(1); // the first socket was abandoned before it connected
  });

  it('can close a socket that is still connecting, silently', async () => {
    const tr = new Transport(fake.factory);
    const sink = recordingSink();
    tr.setSink(sink);
    tr.open(1, fake.url);
    tr.close(1, 1000, 'leave');
    await settle();
    expect(sink.heard).toEqual([]);
  });
});

/** A socket whose handler history is kept, so a test can fire a handler that was replaced. */
class ScriptedSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  readonly history: Record<'open' | 'message' | 'close', Array<(e: never) => void>> = { open: [], message: [], close: [] };
  private handlers: Record<string, ((e: never) => void) | null> = {};
  set onopen(fn: ((e: never) => void) | null) { this.keep('open', fn); }
  get onopen() { return this.handlers.open ?? null; }
  set onmessage(fn: ((e: never) => void) | null) { this.keep('message', fn); }
  get onmessage() { return this.handlers.message ?? null; }
  set onclose(fn: ((e: never) => void) | null) { this.keep('close', fn); }
  get onclose() { return this.handlers.close ?? null; }
  onerror: unknown = null;
  send(text: string): void { this.sent.push(text); }
  close(code?: number, reason?: string): void { this.closes.push({ code, reason }); this.readyState = 3; }
  private keep(kind: 'open' | 'message' | 'close', fn: ((e: never) => void) | null): void {
    this.handlers[kind] = fn;
    if (fn) this.history[kind].push(fn);
  }
}

describe('Transport generation guard', () => {
  function scripted(): { factory: SocketFactory; sockets: ScriptedSocket[] } {
    const sockets: ScriptedSocket[] = [];
    return {
      sockets,
      factory: () => {
        const s = new ScriptedSocket();
        sockets.push(s);
        return s as unknown as WebSocket;
      },
    };
  }

  it('drops events from a stale generation even if its original handlers still run', () => {
    const { factory, sockets } = scripted();
    const tr = new Transport(factory, () => 5);
    const sink = recordingSink();
    tr.setSink(sink);
    tr.open(1, 'ws://x/');
    const [openA] = sockets[0].history.open;
    const [messageA] = sockets[0].history.message;
    const [closeA] = sockets[0].history.close;
    tr.open(2, 'ws://x/');
    expect(sockets[0].closes).toEqual([{ code: 4001, reason: 'superseded' }]);

    // Fire the first socket's original handlers, as a platform that could not detach them would.
    openA({} as never);
    messageA({ data: 'stale' } as never);
    closeA({ code: 1006, reason: '', wasClean: false } as never);
    expect(sink.heard).toEqual([]);

    sockets[1].readyState = 1;
    sockets[1].history.open[0]({} as never);
    sockets[1].history.message[0]({ data: 'fresh' } as never);
    expect(sink.heard).toEqual([{ kind: 'open', gen: 2 }, { kind: 'frame', gen: 2, text: 'fresh', at: 5 }]);
  });

  it('ignores binary frames', () => {
    const { factory, sockets } = scripted();
    const tr = new Transport(factory);
    const sink = recordingSink();
    tr.setSink(sink);
    tr.open(1, 'ws://x/');
    sockets[0].history.message[0]({ data: new ArrayBuffer(4) } as never);
    expect(sink.heard).toEqual([]);
  });

  it('reports a socket that cannot be constructed as a failed connection', () => {
    const tr = new Transport(() => {
      throw new SyntaxError('bad url');
    });
    const sink = recordingSink();
    tr.setSink(sink);
    tr.open(7, 'nonsense');
    expect(sink.heard).toEqual([{ kind: 'closed', gen: 7, code: 1006 }]);
    expect(tr.isOpen).toBe(false);
  });

  it('returns false when a send throws', () => {
    const { factory, sockets } = scripted();
    const tr = new Transport(factory);
    tr.open(1, 'ws://x/');
    sockets[0].readyState = 1;
    sockets[0].send = () => {
      throw new Error('boom');
    };
    expect(tr.send(1, 'x')).toBe(false);
  });
});

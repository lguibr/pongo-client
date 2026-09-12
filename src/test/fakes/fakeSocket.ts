// A mock-socket Server bound to a socket factory. Pass `fake.factory` to `new Transport(factory)`; each call
// makes one mock WebSocket for the fake server. The server is created with { mock: false }, so the global
// WebSocket is never replaced. Call `stop()` in afterEach: one URL can have only one live mock server.
// mock-socket delivers open, message and close events on a short timer, so tests with fake timers must
// advance them.

import { Server, WebSocket as MockWebSocket } from 'mock-socket';
import type { Client } from 'mock-socket';

/** Structurally the same as SocketFactory in src/net/transport.ts. */
export type FakeSocketFactory = (url: string) => WebSocket;

export interface FakeSocketServer {
  readonly url: string;
  readonly server: Server;
  readonly factory: FakeSocketFactory;
  /** Client-side sockets made by `factory`, in creation order. */
  readonly sockets: readonly WebSocket[];
  /** Server-side ends, in connection order. */
  readonly connections: readonly Client[];
  /** Text sent by any client, in arrival order. */
  readonly received: readonly string[];
  /** The latest connection, or null. */
  readonly last: Client | null;
  /** Sends text to one connection (default: the latest). Objects are JSON-encoded. */
  send(data: string | object, to?: Client): void;
  /** Closes one connection from the server side (default: the latest). */
  close(code?: number, reason?: string, to?: Client): void;
  onMessage(fn: (text: string, from: Client) => void): () => void;
  onConnection(fn: (c: Client) => void): () => void;
  stop(): Promise<void>;
}

export function createFakeSocketServer(url = 'ws://pongo.test:8080/subscribe'): FakeSocketServer {
  const server = new Server(url, { mock: false });
  const sockets: WebSocket[] = [];
  const connections: Client[] = [];
  const received: string[] = [];
  const messageFns = new Set<(text: string, from: Client) => void>();
  const connectionFns = new Set<(c: Client) => void>();

  server.on('connection', (client) => {
    connections.push(client);
    client.on('message', (data) => {
      const text = typeof data === 'string' ? data : String(data);
      received.push(text);
      for (const fn of Array.from(messageFns)) fn(text, client);
    });
    for (const fn of Array.from(connectionFns)) fn(client);
  });

  const latest = (to?: Client): Client => {
    const c = to ?? connections[connections.length - 1];
    if (c === undefined) throw new Error('fakeSocket: no connection yet');
    return c;
  };

  return {
    url,
    server,
    factory: (u: string) => {
      const ws = new MockWebSocket(u) as unknown as WebSocket;
      sockets.push(ws);
      return ws;
    },
    sockets,
    connections,
    received,
    get last(): Client | null {
      return connections[connections.length - 1] ?? null;
    },
    send(data: string | object, to?: Client): void {
      latest(to).send(typeof data === 'string' ? data : JSON.stringify(data));
    },
    close(code = 1000, reason = '', to?: Client): void {
      latest(to).close({ code, reason, wasClean: true });
    },
    onMessage(fn) {
      messageFns.add(fn);
      return () => {
        messageFns.delete(fn);
      };
    },
    onConnection(fn) {
      connectionFns.add(fn);
      return () => {
        connectionFns.delete(fn);
      };
    },
    stop(): Promise<void> {
      return new Promise<void>((resolve) => server.stop(resolve));
    },
  };
}

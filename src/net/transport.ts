// One WebSocket per generation (5.5.4, C33, C41). Every handler begins with a generation check, and the
// handlers are detached before any deliberate close, so neither a superseded socket nor a close the session
// asked for ever reaches the sink. Nothing is queued: a send on a socket that is not open returns false
// (C38, C88).

import type { CloseCode, TransportLike, TransportSink } from '../session/types';
import type { Now } from '../lib/clock';
import { now as clockNow } from '../lib/clock';

export type SocketFactory = (url: string) => WebSocket;

const WS_OPEN = 1; // WebSocket.OPEN, spelled out so the module never needs the global at load time
const NOOP = (): void => {};
const NULL_SINK: TransportSink = { open: NOOP, frame: NOOP, closed: NOOP };
const browserFactory: SocketFactory = (url) => new WebSocket(url);

export class Transport implements TransportLike {
  private ws: WebSocket | null = null;
  private gen = 0;
  private sink: TransportSink = NULL_SINK;
  private readonly factory: SocketFactory;
  private readonly now: Now;

  constructor(factory: SocketFactory = browserFactory, now: Now = clockNow) {
    this.factory = factory;
    this.now = now;
  }

  get currentGen(): number {
    return this.gen;
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  setSink(sink: TransportSink): void {
    this.sink = sink;
  }

  /** Closes any current socket with 4001 'superseded' first (its handlers detached), then opens `url`. */
  open(gen: number, url: string): void {
    const old = this.ws;
    this.ws = null;
    if (old !== null) shut(old, 4001, 'superseded');
    this.gen = gen;

    let ws: WebSocket;
    try {
      ws = this.factory(url);
    } catch {
      // A malformed URL throws synchronously; report it the way a failed connection would be reported.
      this.sink.closed(gen, { code: 1006, reason: 'connect failed', wasClean: false });
      return;
    }
    ws.onopen = () => {
      if (gen !== this.gen) return;
      this.sink.open(gen);
    };
    ws.onmessage = (e: MessageEvent) => {
      if (gen !== this.gen) return;
      if (typeof e.data !== 'string') return; // binary frames are not part of the protocol
      this.sink.frame(gen, e.data, this.now());
    };
    ws.onclose = (e: CloseEvent) => {
      if (gen !== this.gen) return;
      detach(ws);
      if (this.ws === ws) this.ws = null;
      this.sink.closed(gen, { code: e.code, reason: e.reason, wasClean: e.wasClean });
    };
    ws.onerror = NOOP; // a close always follows an error
    this.ws = ws;
  }

  /** Writes only when `gen` is current and the socket is OPEN. Never queues. */
  send(gen: number, text: string): boolean {
    const ws = this.ws;
    if (gen !== this.gen || ws === null || ws.readyState !== WS_OPEN) return false;
    try {
      ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  /** Detaches the handlers first, so the sink never sees this close. A stale `gen` is ignored. */
  close(gen: number, code: CloseCode, reason: string): void {
    const ws = this.ws;
    if (gen !== this.gen || ws === null) return;
    this.ws = null;
    shut(ws, code, reason);
  }
}

function detach(ws: WebSocket): void {
  ws.onopen = NOOP;
  ws.onmessage = NOOP;
  ws.onclose = NOOP;
  ws.onerror = NOOP;
}

function shut(ws: WebSocket, code: CloseCode, reason: string): void {
  detach(ws);
  try {
    ws.close(code, reason);
  } catch {
    // Already closing or closed; nothing to do.
  }
}

// The ?debug=1 overlay (4.15, 8.4, 10, 14.4). The counters in `stats` are mutable and not reactive, so the panel
// polls them at 4 Hz while it is open, together with the session, playout, graphics and audio state: the figures
// the browser check in 14.4 reads (at most 12 scene draws, a playout delay of 35–60 ms, the tier). Its lead toggle
// calls game.setOwnLead for the own-paddle blind test (D08). Collapsed, it stops polling, so it adds no commits
// to a profiler recording. App.tsx lazy-loads it, and an error inside it is contained here.

import { Component, useEffect, useReducer, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useApp } from '../app/AppContext';
import { stats } from '../state/stats';
import { log, protocolTrail } from '../lib/log';
import { T } from '../config/tuning';
import { SEATS } from '../game/orientation';

const POLL_MS = 250;          // 4 Hz (4.15)
const SCENE_DRAW_BUDGET = 12; // G4: floor, walls, bricks, paddles, balls, halos, shells, trails and four pools
const TRAIL_SHOWN = 5;

/** The toggle's value outlives a remount of the panel; the runtime starts from the same default. */
let leadEnabled = T.ownLead.enabled;

interface Rates { at: number; frames: number; bytes: number; framesPerS: number; kbPerS: number }

const PANEL: CSSProperties = {
  position: 'fixed', zIndex: 70, pointerEvents: 'auto',
  left: 'calc(8px + env(safe-area-inset-left, 0px))', bottom: 'calc(8px + env(safe-area-inset-bottom, 0px))',
  maxWidth: 'min(360px, calc(100vw - 16px))', maxHeight: 'calc(100dvh - 76px)', overflow: 'auto',
  padding: '6px 8px', background: 'rgba(9, 9, 11, 0.88)', border: '1px solid #27272a', borderRadius: 4,
  color: '#fafafa', font: '12px/1.35 ui-monospace, Menlo, monospace',
};
const HEAD: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 };
const BUTTON: CSSProperties = {
  font: 'inherit', color: 'inherit', background: '#27272a', border: 0, borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
};
const TABLE: CSSProperties = { borderCollapse: 'collapse', marginTop: 4 };
const KEY: CSSProperties = { color: '#a1a1aa', paddingRight: 8, verticalAlign: 'top', whiteSpace: 'nowrap', fontWeight: 'normal', textAlign: 'left' };
const OVER: CSSProperties = { color: '#ef4444' };

class Contained extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(err: Error): void {
    log.warn('debug overlay failed', err);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function Row({ k, children }: { k: string; children: ReactNode }): JSX.Element {
  return (
    <tr>
      <th scope="row" style={KEY}>{k}</th>
      <td>{children}</td>
    </tr>
  );
}

const ms = (v: number): string => `${v.toFixed(1)} ms`;
const yes = (v: boolean): string => (v ? 'yes' : 'no');

function Panel(): JSX.Element {
  const { store, game, input, audio } = useApp();
  const [open, setOpen] = useState(true);
  const [lead, setLead] = useState(leadEnabled);
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  const rates = useRef<Rates>({ at: performance.now(), frames: stats.net.framesIn, bytes: stats.net.bytesIn, framesPerS: 0, kbPerS: 0 });

  useEffect(() => {
    if (!open) return undefined;
    const handle = setInterval(() => {
      const r = rates.current;
      const now = performance.now();
      const dtS = Math.max(0.001, (now - r.at) / 1000);
      r.framesPerS = (stats.net.framesIn - r.frames) / dtS;
      r.kbPerS = (stats.net.bytesIn - r.bytes) / 1024 / dtS;
      r.at = now;
      r.frames = stats.net.framesIn;
      r.bytes = stats.net.bytesIn;
      repaint();
    }, POLL_MS);
    return () => clearInterval(handle);
  }, [open]);

  const onLead = (enabled: boolean): void => {
    leadEnabled = enabled;
    setLead(enabled);
    game.setOwnLead(enabled);
  };

  const st = store.get();
  const s = st.session;
  const p = stats.playout;
  const r = stats.render;
  const q = game.playoutStats;
  const seat = s.myIndex === null ? '—' : SEATS[s.myIndex].name;
  const trail = protocolTrail().slice(-TRAIL_SHOWN);

  return (
    <section aria-label="Debug overlay" style={PANEL}>
      <div style={HEAD}>
        <strong>Debug</strong>
        <button type="button" style={BUTTON} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
            <input type="checkbox" checked={lead} onChange={(e) => onLead(e.target.checked)} />
            Own-paddle lead (D08)
          </label>
          <table style={TABLE}>
            <tbody>
              <Row k="session">{s.s} · {s.code ?? '—'} · {seat} · gen {s.gen} · epoch {s.epoch}{s.attempt > 0 ? ` · attempt ${s.attempt}` : ''}</Row>
              <Row k="board">ready {yes(s.worldReady)} · retained {yes(s.stageRetained)} · unstable {yes(st.net.unstable)}</Row>
              <Row k="net">{rates.current.framesPerS.toFixed(0)} frames/s · {rates.current.kbPerS.toFixed(1)} KB/s · bad {stats.net.badFrames} · dropped {stats.net.droppedItems}</Row>
              <Row k="playout">delay {ms(p.delayMs)} · jitter {ms(p.jitterMs)} · snaps {p.snaps}{p.extrapolating ? ' · extrapolating' : ''}{q.idle ? ' · idle' : ''}{game.hitStopActive ? ' · hit-stop' : ''}</Row>
              <Row k="ticks/batch">{Array.from(p.ticksPerBatch).join(' / ')}</Row>
              <Row k="events">pushed {stats.events.pushed} · released {stats.events.released} · stale {stats.events.stale} · queued {game.queue.size}</Row>
              <Row k="render">
                {r.fps.toFixed(0)} fps · p95 {ms(r.frameMsP95)} · <span style={r.calls > SCENE_DRAW_BUDGET ? OVER : undefined}>scene {r.calls}</span> · post {r.postCalls}
              </Row>
              <Row k="gpu">{r.triangles} tris · {r.programs} programs · tier {st.gfx.tier} · {st.gfx.health} · stage {st.gfx.stageKey}</Row>
              <Row k="fx">sparks {stats.fx.sparks} · shards {stats.fx.shards} · rings {stats.fx.rings} · decals {stats.fx.decals} · dropped {stats.fx.droppedP2}</Row>
              <Row k="audio">{audio.state} · voices {stats.audio.voices} · dropped {stats.audio.dropped}</Row>
              <Row k="input">sent {stats.input.sent} · coalesced {stats.input.coalesced} · refused {input.stats.refused} · last {input.lastSent ?? '—'}</Row>
              {trail.length > 0 && (
                <Row k="protocol">{trail.map((t) => `${t.dir === 'in' ? '←' : '→'} ${t.kind}`).join(' ')}</Row>
              )}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

export default function DebugOverlay(): JSX.Element {
  return (
    <Contained>
      <Panel />
    </Contained>
  );
}

// A canvas-scoped error boundary (C28, C39). A render error inside the stage (GraphicsFailedError, or a creation
// error thrown by the Canvas) shows `fallback` while the HUD, sound and session keep running outside it. A new
// resetKey (gfx.stageKey) clears an existing error, so a remount gets a fresh try.

import { Component } from 'react';
import type { ReactNode } from 'react';

export interface StageBoundaryProps { fallback: ReactNode; resetKey: number; onError?: (e: Error) => void; children: ReactNode }

export class StageBoundary extends Component<StageBoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error): void {
    this.props.onError?.(error);
  }

  componentDidUpdate(prev: StageBoundaryProps): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error !== null) this.setState({ error: null });
  }

  render(): ReactNode {
    return this.state.error !== null ? this.props.fallback : this.props.children;
  }
}

/** Thrown by GameStage during render when gfx.health is 'failed' or 'unsupported', so StageBoundary shows its fallback. */
export class GraphicsFailedError extends Error {
  constructor(message = 'Graphics stopped responding') {
    super(message);
    this.name = 'GraphicsFailedError';
  }
}

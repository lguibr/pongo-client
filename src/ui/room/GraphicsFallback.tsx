// The stage's backdrop when WebGL has failed (C28): StageBoundary renders it in place of the canvas, and the
// HUD, sound and session keep running over it. It is passive: the failed text and the Reload button are
// RoomLayout's graphics notice, which sits in the foreground above the joystick zone and the lobby card. A
// button here, in the stage layer, would be covered by both. Mounting reports itself to RoomLayout, so the
// notice shows the failed state whenever the boundary holds an error, including a creation error thrown by the
// Canvas before gfx.health says so.

import { createContext, useContext, useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import styled from 'styled-components';
import { theme } from '../theme';

const Report = createContext<(shown: boolean) => void>(() => {});

/** RoomLayout wraps the stage in this, to learn whether the fallback is showing. */
export function GraphicsFallbackReporter({ onChange, children }: { onChange: (shown: boolean) => void; children: ReactNode }): JSX.Element {
  return <Report.Provider value={onChange}>{children}</Report.Provider>;
}

const Fill = styled.div`
  position: absolute;
  inset: 0;
  background: ${theme.color.bg};
`;

export function GraphicsFallback(): JSX.Element {
  const report = useContext(Report);
  useLayoutEffect(() => {
    report(true);
    return () => report(false);
  }, [report]);
  return <Fill aria-hidden="true" data-testid="graphics-fallback" />;
}

// The app grid (9.7; C103, C104, C26): header row plus content row, 100dvh with a 100vh fallback, and no
// JavaScript height. Safe areas are honoured on all four sides: the shell pads the top inset above the header,
// the header pads left and right, and every screen's scroll container (ScreenScroll) pads left, right and
// bottom. The room stage is the one full-bleed exception: its HUD offsets by the left, right and bottom insets
// itself, and never adds the top inset again, because <main> already starts below it.

import type { ReactNode } from 'react';
import styled, { ThemeProvider } from 'styled-components';
import { theme } from '../theme';
import { Header } from './Header';
import { LiveAnnouncer } from '../common/LiveAnnouncer';
import { NoticeToasts } from '../common/NoticeToasts';
import { UpdateChip } from '../pwa/UpdateChip';

const Shell = styled.div`
  display: grid;
  grid-template-rows: ${theme.size.headerH} minmax(0, 1fr);
  /* One column that never grows past the viewport: the implicit auto column would widen to the widest
     child's min-content (an over-wide header at 320 px), and html and body clip the overflow. */
  grid-template-columns: minmax(0, 1fr);
  width: 100%;
  height: 100vh;
  height: 100dvh;
  padding-top: ${theme.safe.t};
  background: ${theme.color.bg};
  color: ${theme.color.fg};
  overflow: hidden;
`;

const Main = styled.main`
  position: relative;
  min-height: 0;
  overflow: hidden;
`;

/** A screen's scroll container. The inner column uses margin-block auto, so short content is centred and
 *  tall content scrolls instead of being clipped above the fold (C26). */
export const ScreenScroll = styled.div`
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px calc(16px + ${theme.safe.r}) calc(16px + ${theme.safe.b}) calc(16px + ${theme.safe.l});

  & > * {
    margin-block: auto;
    width: 100%;
  }
`;

/** Today's card: zinc border, 4 px radius, on the black ground. */
export const Card = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  padding: 24px;
  background: ${theme.color.card};
  border: 1px solid ${theme.color.border};
  border-radius: ${theme.size.radius};
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);

  @media (max-width: 767px) {
    padding: 14px;
  }
`;

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ThemeProvider theme={theme}>
      <Shell>
        <Header />
        <Main id="main">{children}</Main>
        <NoticeToasts />
        <UpdateChip />
        <LiveAnnouncer />
      </Shell>
    </ThemeProvider>
  );
}

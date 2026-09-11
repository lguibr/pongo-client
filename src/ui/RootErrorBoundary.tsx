// Top-level boundary (C39) with Home and Reload. `resetKey` (the location key) is a prop compared in
// componentDidUpdate, and a change only clears an error that is already shown. The error remembers the key
// it was thrown under (`errorKey`), so a render that changes the key and throws is reported once and keeps
// its error screen. The key is never a React `key`, so navigation does not remount the shell. Home navigates
// through the router, which changes the key and so clears the error; outside a router it loads `/`.

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import styled from 'styled-components';
import { log } from '../lib/log';
import { Button } from './common/Button';
import { H1 } from './common/Heading';
import { Text } from './common/Text';
import { theme } from './theme';

interface Props { resetKey: string; onError?: (e: Error) => void; children: ReactNode }
interface State { error: Error | null; errorKey: string }

const Screen = styled.div`
  height: 100%;
  overflow: auto;
  display: flex;
  padding: 24px calc(16px + ${theme.safe.r}) calc(24px + ${theme.safe.b}) calc(16px + ${theme.safe.l});
`;

const Box = styled.div`
  margin: auto;
  max-width: 440px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  text-align: center;
`;

const Actions = styled.div`
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
`;

function RouterHome(): JSX.Element {
  const navigate = useNavigate();
  return (
    <Button variant="secondary" onClick={() => navigate('/')}>
      Home
    </Button>
  );
}

function PageHome(): JSX.Element {
  return (
    <Button variant="secondary" onClick={() => window.location.assign('/')}>
      Home
    </Button>
  );
}

/** The boundary's fallback: Home through the router when there is one, else a page load of `/`. */
export function RootErrorScreen(): JSX.Element {
  const inRouter = useInRouterContext();
  return (
    <Screen>
      <Box role="alert">
        <H1>Something went wrong</H1>
        <Text $tone="muted">The page hit an unexpected error. Go back home, or reload to start fresh.</Text>
        <Actions>
          {inRouter ? <RouterHome /> : <PageHome />}
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </Actions>
      </Box>
    </Screen>
  );
}

export class RootErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  /** While no error is shown, track the key; once one is, keep the key it was thrown under. */
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return state.error === null ? { errorKey: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error('UI error', error, info.componentStack);
    this.props.onError?.(error);
  }

  componentDidUpdate(): void {
    if (this.state.error !== null && this.props.resetKey !== this.state.errorKey) this.setState({ error: null });
  }

  render(): ReactNode {
    return this.state.error === null ? this.props.children : <RootErrorScreen />;
  }
}

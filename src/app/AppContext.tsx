import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { App } from './types';

const AppCtx = createContext<App | null>(null);

export function AppProvider(props: { app: App; children: ReactNode }): JSX.Element {
  return <AppCtx.Provider value={props.app}>{props.children}</AppCtx.Provider>;
}

/** Throws outside AppProvider. */
// eslint-disable-next-line react-refresh/only-export-components
export function useApp(): App {
  const app = useContext(AppCtx);
  if (app === null) throw new Error('useApp() must be called inside <AppProvider>');
  return app;
}

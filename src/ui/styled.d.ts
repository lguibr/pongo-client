// styled-components theme typing. AppShell provides `theme` through ThemeProvider, so `props.theme` inside
// the shell carries these token names; components also import `theme` directly, which works anywhere.

import 'styled-components';
import type { AppTheme } from './theme';

declare module 'styled-components' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface DefaultTheme extends AppTheme {}
}

// File: src/types/styled.d.ts
import 'styled-components';
import { AppTheme } from '../styles/theme'; // Ensure AppTheme is exported from theme.ts

// Re-export AppTheme as DefaultTheme for styled-components
declare module 'styled-components' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface DefaultTheme extends AppTheme { }
}
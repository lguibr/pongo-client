// File: src/types/styled.d.ts
import 'styled-components';
import { AppTheme } from '../styles/theme'; // Adjust path as necessary

declare module 'styled-components' {
   
  export interface DefaultTheme extends AppTheme { }
}
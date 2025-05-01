// File: src/styles/GlobalStyle.ts
import { createGlobalStyle } from 'styled-components';
// AppTheme import is no longer strictly needed here for the definition,
// but can be kept for reference or if used elsewhere in the file.
// import { AppTheme } from './theme';

// Remove the explicit generic type <{ theme: AppTheme }>
// The theme is accessed via props automatically injected by ThemeProvider
const GlobalStyle = createGlobalStyle`
  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  html, body, #root {
    width: 100vw;
    height: 100vh;
    /* Access theme via props.theme */
    background: ${({ theme }) => theme.colors.background};
    overflow: hidden;
  }

  body {
    /* Access theme via props.theme */
    color: ${({ theme }) => theme.colors.text};
    font-family: ${({ theme }) => theme.fonts.primary};
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
`;

export default GlobalStyle;
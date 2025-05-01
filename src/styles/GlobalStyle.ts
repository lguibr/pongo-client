// File: src/styles/GlobalStyle.ts
import { createGlobalStyle } from 'styled-components';
import { AppTheme } from './theme'; // Import the theme type

// Access theme properties via props.theme
const GlobalStyle = createGlobalStyle<{ theme: AppTheme }>`
  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  html, body, #root {
    width: 100vw;
    height: 100vh;
    background: ${({ theme }) => theme.colors.background};
    overflow: hidden;
  }

  body {
    color: ${({ theme }) => theme.colors.text};
    font-family: ${({ theme }) => theme.fonts.primary};
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
`;

export default GlobalStyle;

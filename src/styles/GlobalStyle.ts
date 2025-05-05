// File: src/styles/GlobalStyle.ts
import { createGlobalStyle } from 'styled-components'; // Removed DefaultTheme import

// Global styles now primarily affect elements OUTSIDE the R3F canvas
// Remove explicit theme typing from createGlobalStyle generic
const GlobalStyle = createGlobalStyle`
  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  html, body, #root {
    width: 100vw;
    height: 100vh;
    /* Background set directly in AppContainer and R3F Canvas */
    overflow: hidden; /* Prevent scrollbars */
  }

  body {
    /* Base text color and font for UI elements */
    /* Access theme via props injected by ThemeProvider */
    color: ${({ theme }) => theme.colors.text};
    font-family: ${({ theme }) => theme.fonts.primary};
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
`;

export default GlobalStyle;
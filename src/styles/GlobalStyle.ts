
// File: src/styles/GlobalStyle.ts
import { createGlobalStyle } from 'styled-components';

const GlobalStyle = createGlobalStyle`
  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  html, body {
    width: 100%; /* Use 100% to fill parent */
    height: 100%; /* Use 100% to fill parent */
    overflow: hidden; /* Prevent scrollbars on html/body */
    -webkit-tap-highlight-color: transparent; /* Remove tap highlight on mobile */
  }

  #root {
    width: 100%;
    /* height is now set dynamically by src/main.tsx to window.innerHeight */
    /* Do not set height: 100vh here as it causes issues on mobile */
    overflow: hidden; /* Prevent scrollbars on root */
    display: flex; /* Ensure AppContainer can fill it */
    flex-direction: column; /* Ensure AppContainer can fill it */
  }

  body {
    color: ${({ theme }) => theme.colors.text};
    font-family: ${({ theme }) => theme.fonts.primary};
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    /* Background color for the body, if #root doesn't cover everything (e.g. overscroll) */
    background-color: ${({ theme }) => theme.colors.background};
  }
`;

export default GlobalStyle;
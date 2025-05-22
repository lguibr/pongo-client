// File: src/styles/GlobalStyle.ts
import { createGlobalStyle } from 'styled-components';

const GlobalStyle = createGlobalStyle`
  :root {
    /* Define fixed heights for header and controls */
    --header-height: 60px; /* Adjust as needed */
    --controls-height: 70px; /* Adjust for your button size + padding */
    
    /* Define the desired aspect ratio for your game area */
    /* Example: 16:9. Adjust to your game's native aspect ratio */
    --game-aspect-ratio: 16 / 9; 
  }

  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  html, body {
    width: 100%; 
    height: 100%; 
    overflow: hidden; 
    -webkit-tap-highlight-color: transparent; 
  }

  #root {
    width: 100%;
    /* height is set dynamically by src/main.tsx */
    overflow: hidden; 
    display: flex; 
    flex-direction: column; 
  }

  body {
    color: ${({ theme }) => theme.colors.text};
    font-family: ${({ theme }) => theme.fonts.primary};
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    background-color: ${({ theme }) => theme.colors.background};
  }
`;

export default GlobalStyle;
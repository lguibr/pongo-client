import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'styled-components';
import App from './App.tsx';
import GlobalStyle from './styles/GlobalStyle.ts';
import theme from './styles/theme.ts';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error("Root element #root not found in the document.");
}

// Function to adjust root height to actual window inner height
const adjustRootHeight = () => {
  const rootElement = document.getElementById('root');
  if (rootElement) {
    // Use visualViewport height if available, otherwise fallback to window.innerHeight
    const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    rootElement.style.height = `${height}px`;
    // Also scroll to top to hide address bar if possible
    window.scrollTo(0, 0);
  }
};

// Initial adjustment
adjustRootHeight();

// Adjust on resize and orientation change
window.addEventListener('resize', adjustRootHeight);
window.addEventListener('orientationchange', adjustRootHeight);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', adjustRootHeight);
}

const root = createRoot(container);

import { BrowserRouter } from 'react-router-dom';

root.render(
  <ThemeProvider theme={theme}>
    <GlobalStyle />
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </ThemeProvider>
);
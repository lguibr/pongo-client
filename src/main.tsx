
// File: src/main.tsx
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'styled-components'; // Keep for outer UI
import App from './App.tsx';
import GlobalStyle from './styles/GlobalStyle.ts'; // Keep for outer UI
import theme from './styles/theme.ts';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error("Root element #root not found in the document.");
}

const root = createRoot(container);

root.render(
  // ThemeProvider still wraps App for outer UI elements
  <ThemeProvider theme={theme}>
    <GlobalStyle /> {/* Apply global styles for body, etc. */}
    <App />
  </ThemeProvider>
);
// File: src/main.tsx
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'styled-components'; // Import ThemeProvider
import App from './App.tsx';
import GlobalStyle from './styles/GlobalStyle.ts'; // Import GlobalStyle
import theme from './styles/theme.ts'; // Import your theme
import './index.css'; // Keep base CSS for potential resets or root variables

const container = document.getElementById('root');
if (!container) {
  throw new Error("Root element #root not found in the document.");
}

const root = createRoot(container);

root.render(
  <ThemeProvider theme={theme}>
    <GlobalStyle /> {/* Apply global styles */}
    <App />
  </ThemeProvider>
);
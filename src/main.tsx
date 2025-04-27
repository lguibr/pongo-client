// File: frontend/src/main.tsx
// import { StrictMode } from 'react' // Remove StrictMode import
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  // <StrictMode> // Remove StrictMode wrapper
  <App />
  // </StrictMode>, // Remove StrictMode wrapper
)
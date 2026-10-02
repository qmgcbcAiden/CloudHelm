import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import './global.css';

declare global {
  interface Window { cloudhelm: import('@cloudhelm/contracts').DesktopAPI }
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

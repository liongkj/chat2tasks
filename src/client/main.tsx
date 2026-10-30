import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { DesktopRoot } from './Onboarding.js';
import { installTauriBridge } from './tauri.js';
import '../shared/theme.css';
import './style.css';
installTauriBridge();
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <React.StrictMode>
      <DesktopRoot>
        <App />
      </DesktopRoot>
    </React.StrictMode>,
  );

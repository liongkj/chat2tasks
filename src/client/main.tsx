import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { DesktopRoot } from './Onboarding.js';
import '../shared/theme.css';
import './style.css';
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <React.StrictMode>
      <DesktopRoot>
        <App />
      </DesktopRoot>
    </React.StrictMode>,
  );

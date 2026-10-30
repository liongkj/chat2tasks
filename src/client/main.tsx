import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { DesktopRoot } from './Onboarding.js';
import { installTauriBridge } from './tauri.js';
import { WorkspacePicker } from './WorkspacePicker.js';
import { RemoteConnecting } from './RemoteConnecting.js';
import '../shared/theme.css';
import './style.css';
installTauriBridge();
const root = document.getElementById('root');
const desktopView = new URLSearchParams(window.location.search).get('desktop');
if (root)
  createRoot(root).render(
    <React.StrictMode>
      {desktopView === 'workspace' ? (
        <WorkspacePicker />
      ) : desktopView === 'connecting' ? (
        <RemoteConnecting />
      ) : (
        <DesktopRoot>
          <App />
        </DesktopRoot>
      )}
    </React.StrictMode>,
  );

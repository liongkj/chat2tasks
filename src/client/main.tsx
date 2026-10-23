import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App.js';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';
import './style.css';
const root = document.getElementById('root');
if (root) createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);

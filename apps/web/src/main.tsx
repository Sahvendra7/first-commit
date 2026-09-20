import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App.js';
import { registerServiceWorker, shouldRegister, unregisterServiceWorker } from './lib/register-sw.js';

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Installed only for a production build outside demo mode. A device that once
// ran the real app and then opens `?demo=1` has its worker removed, so the demo
// leaves nothing cached behind it.
if (shouldRegister()) registerServiceWorker();
else unregisterServiceWorker();

import './boot-watchdog.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { reportError } from './errors.js';
import { ToastProvider } from './toastContext.jsx';

(function mountApp() {
  try {
    const el = document.getElementById('root');
    if (!el) throw new Error('Missing #root container.');
    const root = createRoot(el);
    root.render(
      <React.StrictMode>
        <ToastProvider>
          <App />
        </ToastProvider>
      </React.StrictMode>
    );
    window.__dmgBoot = window.__dmgBoot || {};
    window.__dmgBoot.rendered = true;
  } catch (err) {
    reportError('DMG-E002', {
      phase: 'mount',
      message: err && err.message ? err.message : String(err),
    });
    window.__dmgBoot = window.__dmgBoot || {};
    window.__dmgBoot.rendered = false;
    window.__dmgBoot.bootError = err && err.message ? err.message : String(err);
    const rootEl = document.getElementById('root');
    const detail = window.__dmgBoot.bootError;
    if (rootEl) {
      window.__dmgBoot.fatalUi = true;
      rootEl.innerHTML =
        '<div class="boot-fatal" role="alert"><div class="boot-card">' +
        '<h1>Could not start the application</h1>' +
        '<p>Something went wrong while starting the app. Try refreshing the page.</p>' +
        '<pre>' +
        String(detail).replace(/</g, '&lt;') +
        '</pre>' +
        '<p class="boot-sub">Error code: DMG-E002. If this keeps happening, clear site data or try another browser.</p>' +
        '</div></div>';
    }
  }
})();

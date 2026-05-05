import React, { useState, useEffect } from 'react';
import { clearErrorLog, copyDiagnostics, reportError } from './errors.js';

/**
 * Help tab: diagnostics, error code summary, optional DMG-E012 repair when corrupt keys exist.
 */
export default function HelpCenter({
  currentUser,
  corruptKeys = [],
  onRepairStorageKey,
}) {
  const isAdmin = currentUser?.role === 'admin';
  const [diagMsg, setDiagMsg] = useState('');
  const [diagBusy, setDiagBusy] = useState(false);
  const [repairKey, setRepairKey] = useState(() => corruptKeys[0] || '');
  const [repairJson, setRepairJson] = useState('');
  const [repairMsg, setRepairMsg] = useState('');

  useEffect(() => {
    if (corruptKeys.length && !corruptKeys.includes(repairKey)) {
      setRepairKey(corruptKeys[0]);
    }
  }, [corruptKeys, repairKey]);

  async function handleCopyDiagnostics() {
    setDiagMsg('');
    setDiagBusy(true);
    try {
      const r = await copyDiagnostics({
        username: currentUser?.username || '',
        role: currentUser?.role || '',
      });
      if (r === true) {
        setDiagMsg('Diagnostics copied to clipboard. Paste into email or chat for support.');
      } else if (typeof r === 'string') {
        window.prompt('Clipboard unavailable — copy this text manually:', r);
        setDiagMsg('Copy the text from the dialog above.');
      }
    } catch (e) {
      reportError('DMG-E002', { phase: 'copy_diagnostics', message: String(e) });
      setDiagMsg('Could not prepare diagnostics. Try again or note the error message.');
    } finally {
      setDiagBusy(false);
    }
  }

  function handleClearErrorLog() {
    clearErrorLog();
    setDiagMsg('Recent error log cleared on this device.');
  }

  function handleApplyRepair() {
    setRepairMsg('');
    if (!repairKey.trim()) {
      setRepairMsg('Choose which key to fix.');
      return;
    }
    if (!repairJson.trim()) {
      setRepairMsg('Paste valid JSON from an export or backup.');
      return;
    }
    try {
      JSON.parse(repairJson);
    } catch {
      setRepairMsg('That text is not valid JSON. Check brackets and quotes.');
      return;
    }
    if (typeof onRepairStorageKey === 'function') {
      const ok = onRepairStorageKey(repairKey, repairJson.trim());
      if (ok) {
        setRepairJson('');
        setRepairMsg(`Key "${repairKey}" was replaced. If the banner persists, refresh the page.`);
      }
    }
  }

  return (
    <div>
      <div className="section-title">Help</div>
      <div className="card mb-3">
        <div style={{ fontWeight: 700, color: 'var(--brown)', marginBottom: 8 }}>Diagnostics for support</div>
        <p style={{ fontSize: 13, lineHeight: 1.7, color: '#555', marginBottom: 12 }}>
          Copy a safe snapshot (build id, browser, storage availability, recent app error codes). Passwords are never included.
        </p>
        <div className="flex gap-2 flex-wrap">
          <button type="button" className="btn btn-primary" disabled={diagBusy} onClick={handleCopyDiagnostics}>
            {diagBusy ? 'Copying…' : '📋 Copy diagnostics'}
          </button>
          <button type="button" className="btn btn-outline" onClick={handleClearErrorLog}>
            Clear recent error log
          </button>
        </div>
        {diagMsg && <p className="text-muted" style={{ marginTop: 12, marginBottom: 0 }}>{diagMsg}</p>}
      </div>

      {!!corruptKeys.length && typeof onRepairStorageKey === 'function' && (
        <div className="card mb-3" style={{ borderColor: '#fde047', background: '#fffef5' }}>
          <div style={{ fontWeight: 700, color: 'var(--brown)', marginBottom: 8 }}>Fix unreadable storage (DMG-E012)</div>
          <p style={{ fontSize: 13, lineHeight: 1.65, color: '#555', marginBottom: 12 }}>
            One or more saved values are not valid JSON. If you have a backup JSON for a key (from an exported file), paste it below to replace only that key.
            Ask your admin for a copy if needed.
          </p>
          <div className="field" style={{ marginBottom: 10 }}>
            <label>Key to repair</label>
            <select className="input" value={repairKey} onChange={(e) => setRepairKey(e.target.value)}>
              {corruptKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 10 }}>
            <label>Valid JSON for this key</label>
            <textarea
              className="input"
              rows={6}
              placeholder='e.g. [] or {"admin":{...}}'
              value={repairJson}
              onChange={(e) => setRepairJson(e.target.value)}
              style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
            />
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={handleApplyRepair}>
            Replace key with pasted JSON
          </button>
          {repairMsg && <p className="text-muted" style={{ marginTop: 10, marginBottom: 0 }}>{repairMsg}</p>}
        </div>
      )}

      <div className="card mb-3">
        <div style={{ fontWeight: 700, color: 'var(--brown)', marginBottom: 8 }}>Supported browsers</div>
        <div style={{ fontSize: 13, lineHeight: 1.75, color: '#555' }}>
          Use a current <strong>Chrome</strong>, <strong>Microsoft Edge</strong>, or <strong>Firefox</strong> on desktop for best results.
          The app needs modern JavaScript, <strong>localStorage</strong>, and (for password hashing) <strong>HTTPS</strong> or <strong>localhost</strong>.
          If you go offline, inventory still saves on this device; central login and scanner sync need the network when you reconnect.
          Safari and mobile browsers often work but are less tested; enable site storage if saves fail.
        </div>
      </div>

      <div className="card mb-3">
        <div style={{ fontWeight: 700, color: 'var(--brown)', marginBottom: 8 }}>Understanding error codes</div>
        <div style={{ fontSize: 13, lineHeight: 1.75, color: '#555' }}>
          <strong>DMG-E001</strong> — App scripts did not finish loading (network or cache). Refresh or try another connection.
          <br />
          <strong>DMG-E002</strong> — App crashed while starting. Refresh; clear site data if it repeats.
          <br />
          <strong>DMG-E010–E012</strong> — Browser storage disabled, full, or unreadable. Export a backup when possible.
          <br />
          <strong>DMG-E020</strong> — Invalid username or password (central auth).
          <br />
          <strong>DMG-E021</strong> — Login or sync service unreachable (offline, timeout, or server error).
          <br />
          <strong>DMG-E022</strong> — Session expired or not authorized for that request.
          <br />
          <strong>DMG-E030–E031</strong> — Cannot reach backend (timeout or blocked origin). Admin checks Render / ALLOWED_ORIGINS.
          <br />
          <strong>DMG-E040–E041</strong> — Import/export problems.
          <br />
          <strong>DMG-E050–E051</strong> — Browser too old, missing Web Crypto / structured clone, or page not served over HTTPS (needed for some security APIs).
        </div>
      </div>
      <div className="card mb-3">
        <div style={{ fontWeight: 700, color: 'var(--brown)', marginBottom: 8 }}>Daily Basics</div>
        <div style={{ fontSize: 13, lineHeight: 1.8, color: '#555' }}>
          1) Log in with your assigned username and password.
          <br />
          2) Use the tabs at the top for your tasks.
          <br />
          3) Save your work before closing the browser.
          <br />
          4) Ask admin if your access or menu options are missing.
        </div>
      </div>
      <div className="card mb-3">
        <div style={{ fontWeight: 700, color: 'var(--brown)', marginBottom: 8 }}>Check In / Out</div>
        <div style={{ fontSize: 13, lineHeight: 1.8, color: '#555' }}>
          1) Scan the live work QR code.
          <br />
          2) Log in (you can use Remember Device for faster repeat use).
          <br />
          3) Tap Check In or Check Out once.
          <br />
          4) If you see “you are not at work”, ask admin for a fresh QR.
        </div>
      </div>
      {isAdmin && (
        <div className="card mb-3">
          <div style={{ fontWeight: 700, color: 'var(--brown)', marginBottom: 8 }}>Admin Notes</div>
          <div style={{ fontSize: 13, lineHeight: 1.8, color: '#555' }}>
            - Admin has full panel access from any device.
            <br />
            - Some features are local-device dependent (scanner automation, local kiosk station mode).
            <br />- Use Settings and Activity Log to diagnose issues quickly.
          </div>
        </div>
      )}
      <div className="card">
        <div style={{ fontWeight: 700, color: 'var(--brown)', marginBottom: 8 }}>If Something Fails</div>
        <div style={{ fontSize: 13, lineHeight: 1.8, color: '#555' }}>
          - Refresh once and retry.
          <br />
          - Confirm backend health if a tool depends on local service.
          <br />
          - Download failure logs and share with admin support.
        </div>
      </div>
    </div>
  );
}

import React, { useState, useEffect, useId } from 'react';
import { showToast, toastApiFailure } from '../toastContext.jsx';
import { SCAN_DOC_TYPES } from '../constants.js';
import { BackendUnavailableBanner } from '../ReliabilityBanners.jsx';
import { fmtDate } from '../formatters.js';

function FI({ label, suggestions, fieldStyle, ...props }) {
  const listId = useId();
  const hasSuggestions = Array.isArray(suggestions) && suggestions.length > 0;
  const baseFieldStyle = label ? {} : { marginBottom: 0 };
  return (
    <div className="field" style={{ ...baseFieldStyle, ...fieldStyle }}>
      {label && <label>{label}</label>}
      <input className="input" {...props} list={hasSuggestions ? listId : undefined} />
      {hasSuggestions && (
        <datalist id={listId}>
          {suggestions.map(s => <option key={s} value={s} />)}
        </datalist>
      )}
    </div>
  );
}

function Btn({ className = '', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

/**
 * Scan Database tab — admin-device only. Requires the backend server running locally
 * (typically http://localhost:8787). This is a separate system from the invoice database:
 * it organizes scanned files into a Windows folder hierarchy (Year / DocType / ...) with
 * descriptive filenames. Overlaps with invoices (e.g. scanned purchase invoices) are
 * intentional but the two systems are not linked — scan DB tracks document metadata,
 * invoice DB tracks accounting records.
 */
export default function ScanDatabaseBeta({ currentUser, onAuthHashSaved, isOnline, scanApiCall, hashPwd }) {
  const [pwd, setPwd] = useState('');
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [backendDown, setBackendDown] = useState(false);
  const [config, setConfig] = useState({ inboxPath: '', libraryPath: '', enabled: false });
  const [filters, setFilters] = useState({ q: '', sender: '', docType: '', year: '', month: '', businessTag: '', status: '' });
  const [results, setResults] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkBusiness, setBulkBusiness] = useState('');
  const [bulkType, setBulkType] = useState('');
  const [bulkStatus, setBulkStatus] = useState('');

  const hasAuth = !!currentUser?.authHash;

  async function refreshStatus(silent) {
    if (!hasAuth) return;
    const res = await scanApiCall('/api/scan/status', { currentUser });
    if (!res.ok) {
      if (!silent) toastApiFailure(res, 'Scanner unavailable');
      setErr(res.error || 'Failed to load scanner status');
      if (res.code === 'DMG-E021' || res.code === 'DMG-E030') setBackendDown(true);
      return;
    }
    setBackendDown(false);
    setErr('');
    setStatus(res.data);
    setConfig(res.data.config || { inboxPath: '', libraryPath: '', enabled: false });
  }

  async function runSearch(silent) {
    if (!hasAuth) return;
    const q = {};
    Object.entries(filters).forEach(([k, v]) => { if (String(v || '').trim()) q[k] = v; });
    const res = await scanApiCall('/api/scan/search', { currentUser, query: q });
    if (!res.ok) {
      if (!silent) toastApiFailure(res, 'Search failed');
      setErr(res.error || 'Search failed');
      return;
    }
    setErr('');
    setResults(res.data.items || []);
  }

  useEffect(() => {
    if (!hasAuth) return;
    refreshStatus(true);
    runSearch(true);
    const t = setInterval(() => { refreshStatus(true); }, 12000);
    return () => clearInterval(t);
  }, [hasAuth]);

  async function unlockAdmin() {
    setErr('');
    if (!pwd) { setErr('Enter admin password.'); return; }
    const authHash = await hashPwd(pwd);
    const probeUser = { ...currentUser, authHash };
    const probe = await scanApiCall('/api/scan/status', { currentUser: probeUser });
    if (!probe.ok) {
      toastApiFailure(probe, 'Scanner unreachable');
      setErr('Admin authentication failed.');
      return;
    }
    onAuthHashSaved(authHash);
    setPwd('');
  }

  async function saveConfig(nextEnabled = config.enabled) {
    setBusy(true);
    const res = await scanApiCall('/api/scan/config', {
      currentUser,
      method: 'POST',
      body: { inboxPath: config.inboxPath, libraryPath: config.libraryPath, enabled: !!nextEnabled }
    });
    setBusy(false);
    if (!res.ok) {
      toastApiFailure(res, 'Save failed');
      setErr(res.error || 'Save failed');
      return;
    }
    setErr('');
    setConfig(res.data.config);
    refreshStatus();
  }

  async function scanNow() {
    setBusy(true);
    const res = await scanApiCall('/api/scan/scan-now', { currentUser, method: 'POST' });
    setBusy(false);
    if (!res.ok) {
      toastApiFailure(res, 'Scan failed');
      setErr(res.error || 'Scan failed');
      return;
    }
    showToast('Scan completed.');
    refreshStatus();
    runSearch();
  }

  async function updateOne(item, patch) {
    const res = await scanApiCall(`/api/scan/update/${item.id}`, { currentUser, method: 'POST', body: patch });
    if (!res.ok) {
      toastApiFailure(res, 'Update failed');
      setErr(res.error || 'Update failed');
      return;
    }
    runSearch();
  }

  async function bulkApply() {
    if (!selectedIds.length) return;
    const res = await scanApiCall('/api/scan/bulk-tag', {
      currentUser,
      method: 'POST',
      body: { ids: selectedIds, businessTag: bulkBusiness, docType: bulkType, status: bulkStatus }
    });
    if (!res.ok) {
      toastApiFailure(res, 'Bulk update failed');
      setErr(res.error || 'Bulk update failed');
      return;
    }
    showToast(`Updated ${res.data.updated} documents.`);
    setSelectedIds([]);
    runSearch();
  }

  async function exportDb() {
    const res = await scanApiCall('/api/scan/export', { currentUser });
    if (!res.ok) {
      toastApiFailure(res, 'Export failed');
      setErr(res.error || 'Export failed');
      return;
    }
    const blob = new Blob([JSON.stringify(res.data.data, null, 2)], { type: 'application/json;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `scan-db-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importDb(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const res = await scanApiCall('/api/scan/import', { currentUser, method: 'POST', body: { data } });
      if (!res.ok) {
        toastApiFailure(res, 'Import failed');
        setErr(res.error || 'Import failed');
        return;
      }
      showToast('Backup imported.');
      refreshStatus();
      runSearch();
    } catch {
      setErr('Invalid backup file.');
    }
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Scanned Documents Database <span className="badge badge-user" style={{ marginLeft: 8 }}>BETA · WIP</span></h2>
        <div style={{ fontSize: 12, color: '#555' }}>Admin-only local-device scanner index</div>
      </div>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 10, background: '#f8f8f8', borderRadius: 6, padding: '6px 10px' }}>
        This tab requires the backend server running on the admin device (localhost:8787).
        It organizes scanned files into a folder-based archive — separate from the invoice database.
      </div>
      {(!isOnline || backendDown) && <BackendUnavailableBanner code={backendDown ? 'DMG-E021' : 'DMG-E030'} />}
      {!hasAuth && (
        <div style={{ background: '#FFF8DC', border: '1px solid #DEB887', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Unlock admin scanner controls</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="input" type="password" placeholder="Enter admin password" value={pwd} onChange={e => setPwd(e.target.value)} style={{ maxWidth: 280 }} />
            <Btn className="btn-primary btn-sm" onClick={unlockAdmin}>Unlock</Btn>
          </div>
        </div>
      )}
      {err && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '8px 12px', borderRadius: 6, marginBottom: 10, fontSize: 12.5 }}>{err}</div>}
      {hasAuth && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10, marginBottom: 12 }}>
            <FI label="Watch Inbox Folder" value={config.inboxPath || ''} onChange={e => setConfig(c => ({ ...c, inboxPath: e.target.value }))} placeholder="C:\Scans\Inbox" />
            <FI label="Library Root Folder" value={config.libraryPath || ''} onChange={e => setConfig(c => ({ ...c, libraryPath: e.target.value }))} placeholder="C:\Scans\Library" />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <Btn className="btn-outline btn-sm" disabled={busy} onClick={() => saveConfig(config.enabled)}>💾 Save Config</Btn>
            <Btn className="btn-primary btn-sm" disabled={busy} onClick={() => saveConfig(!config.enabled)}>{config.enabled ? '⏸ Stop Watcher' : '▶ Start Watcher'}</Btn>
            <Btn className="btn-outline btn-sm" disabled={busy} onClick={scanNow}>🔎 Scan Now</Btn>
            <Btn className="btn-outline btn-sm" onClick={exportDb}>⬇ Export Backup</Btn>
            <label className="btn btn-outline btn-sm" style={{ margin: 0, cursor: 'pointer' }}>
              ⬆ Import Backup
              <input type="file" accept=".json" style={{ display: 'none' }} onChange={e => { importDb(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          </div>
          {status && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, fontSize: 12.5 }}>
              <span className="badge badge-admin">Total: {status.counts?.total || 0}</span>
              <span className="badge badge-user">Needs Review: {status.counts?.needsReview || 0}</span>
              <span className="badge badge-user">Failures: {status.counts?.failures || 0}</span>
              <span className="badge badge-user">Polling: {status.pollMs}ms</span>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 8, marginBottom: 10 }}>
            <input className="input" placeholder="Search text/sender/type" value={filters.q} onChange={e => setFilters(f => ({ ...f, q: e.target.value }))} />
            <input className="input" placeholder="Sender" value={filters.sender} onChange={e => setFilters(f => ({ ...f, sender: e.target.value }))} />
            <select className="input" value={filters.docType} onChange={e => setFilters(f => ({ ...f, docType: e.target.value }))}>
              <option value="">All Types</option>
              {SCAN_DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input className="input" placeholder="Year (e.g. 2026)" value={filters.year} onChange={e => setFilters(f => ({ ...f, year: e.target.value }))} />
            <input className="input" placeholder="Month (e.g. March)" value={filters.month} onChange={e => setFilters(f => ({ ...f, month: e.target.value }))} />
            <select className="input" value={filters.businessTag} onChange={e => setFilters(f => ({ ...f, businessTag: e.target.value }))}>
              <option value="">All Businesses</option>
              <option value="degrill">degrill</option>
              <option value="parathas">parathas</option>
              <option value="dera">dera</option>
              <option value="unknown">unknown</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <Btn className="btn-outline btn-sm" onClick={() => runSearch(false)}>Search</Btn>
            <select className="input" style={{ maxWidth: 160 }} value={bulkType} onChange={e => setBulkType(e.target.value)}>
              <option value="">Bulk Type</option>
              {SCAN_DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select className="input" style={{ maxWidth: 160 }} value={bulkStatus} onChange={e => setBulkStatus(e.target.value)}>
              <option value="">Bulk Status</option>
              <option value="classified">classified</option>
              <option value="needs_review">needs_review</option>
            </select>
            <input className="input" style={{ maxWidth: 180 }} placeholder="Bulk Business Tag" value={bulkBusiness} onChange={e => setBulkBusiness(e.target.value)} />
            <Btn className="btn-outline btn-sm" onClick={bulkApply}>Apply to Selected ({selectedIds.length})</Btn>
          </div>
          <div style={{ maxHeight: 440, overflow: 'auto', border: '1px solid #eee', borderRadius: 8 }}>
            <table className="table">
              <thead>
                <tr><th></th><th>Date</th><th>Sender</th><th>Type</th><th>Business</th><th>Status</th><th>File</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {results.map(item => {
                  const checked = selectedIds.includes(item.id);
                  return (
                    <tr key={item.id}>
                      <td><input type="checkbox" checked={checked} onChange={e => setSelectedIds(ids => e.target.checked ? [...new Set([...ids, item.id])] : ids.filter(x => x !== item.id))} /></td>
                      <td>{fmtDate(String(item.importedAt || '').slice(0, 10))}</td>
                      <td>{item.sender}</td>
                      <td>{item.docType}</td>
                      <td>{item.businessTag || 'unknown'}</td>
                      <td>{item.status}</td>
                      <td style={{ maxWidth: 220, wordBreak: 'break-word' }}>{item.fileName}</td>
                      <td>
                        <Btn className="btn-outline btn-sm" onClick={() => updateOne(item, { status: 'classified' })}>Mark OK</Btn>
                      </td>
                    </tr>
                  );
                })}
                {!results.length && <tr><td colSpan={8}><div className="muted text-center">No scanned documents matched current filters.</div></td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

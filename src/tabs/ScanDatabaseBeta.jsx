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
export default function ScanDatabaseBeta({ currentUser, onAuthHashSaved, isOnline, scanApiCall, hashPwd, pendingOpen, onConsumePending }) {
  const [pwd, setPwd] = useState('');
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [backendDown, setBackendDown] = useState(false);
  const [config, setConfig] = useState({ inboxPath: '', libraryPath: '', enabled: false });
  const [filters, setFilters] = useState({ q: '', sender: '', docType: '', year: '', month: '', businessTag: '', status: '' });
  const [results, setResults] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [dragOver, setDragOver] = useState(false);
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

  // Pre-fill the search box when arriving here from a global-search "scan"
  // hit so she lands on the relevant rows immediately.
  useEffect(() => {
    if (pendingOpen?.query) {
      setFilters(f => ({ ...f, q: pendingOpen.query }));
      onConsumePending?.();
    }
  }, [pendingOpen]);

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

  // Upload documents straight from the browser (drag-drop, file picker, or
  // phone camera). Files go to the backend inbox and run through the same
  // AI extraction pipeline as watcher-discovered files.
  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []).filter(f =>
      /\.(pdf|jpe?g|png|webp)$/i.test(f.name) || /^(application\/pdf|image\/(jpeg|png|webp))$/.test(f.type));
    if (!files.length) { showToast('Choose PDF or photo files (JPG/PNG).', 'error'); return; }
    if (files.length > 20) { showToast('Upload at most 20 files at a time.', 'error'); return; }
    setUploading(true);
    setUploadResult(null);
    try {
      const payload = [];
      for (const f of files) {
        const buf = await f.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buf);
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        payload.push({ name: f.name, dataBase64: btoa(binary) });
      }
      const res = await scanApiCall('/api/scan/upload', { currentUser, method: 'POST', body: { files: payload } });
      if (!res.ok) {
        toastApiFailure(res, 'Upload failed');
        setErr(res.error || 'Upload failed');
        return;
      }
      setErr('');
      setUploadResult(res.data);
      showToast(`${res.data.uploaded} document${res.data.uploaded !== 1 ? 's' : ''} scanned and filed.`);
      refreshStatus(true);
      runSearch(true);
    } finally {
      setUploading(false);
    }
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
        <h2 style={{ margin: 0 }}>📄 Document Scanner</h2>
        <div style={{ fontSize: 12, color: '#555' }}>Admin-only · reads, names, and files your paperwork</div>
      </div>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 10, background: '#f8f8f8', borderRadius: 6, padding: '6px 10px' }}>
        Drop in PDFs or photos of any paperwork — business invoices, receipts, payroll, tax forms, IRS notices, personal mail, medical bills, bank statements.
        The computer reads each one, figures out who sent it, what it is, the date and amount, and files it into Year / Month / Type folders.
        Requires the backend server running on the admin device.
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
          {/* Drop zone — the main way mom feeds the pile of paper in */}
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); uploadFiles(e.dataTransfer.files); }}
            style={{
              border: `2.5px dashed ${dragOver ? 'var(--brown,#8B4513)' : '#DEB887'}`,
              background: dragOver ? '#FFF3DC' : '#FFFBF2',
              borderRadius: 10, padding: '22px 16px', textAlign: 'center', marginBottom: 14,
              transition: 'background .15s,border-color .15s',
            }}
          >
            <div style={{ fontSize: 28, marginBottom: 6 }}>📄</div>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--brown,#8B4513)' }}>
              Drop documents here — or
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 10, flexWrap: 'wrap' }}>
              <label className="btn btn-primary" style={{ margin: 0, cursor: 'pointer' }}>
                {uploading ? '⏳ Reading…' : '📁 Choose files'}
                <input type="file" accept=".pdf,image/jpeg,image/png,image/webp" multiple disabled={uploading}
                  style={{ display: 'none' }}
                  onChange={e => { uploadFiles(e.target.files); e.target.value = ''; }} />
              </label>
              <label className="btn btn-outline" style={{ margin: 0, cursor: 'pointer' }}>
                📷 Take photo
                <input type="file" accept="image/*" capture="environment" disabled={uploading}
                  style={{ display: 'none' }}
                  onChange={e => { uploadFiles(e.target.files); e.target.value = ''; }} />
              </label>
            </div>
            <div style={{ fontSize: 11.5, color: '#999', marginTop: 8 }}>
              PDF, JPG, PNG · up to 20 at a time · {status?.ai?.enabled
                ? <span style={{ color: '#15803d', fontWeight: 700 }}>🤖 AI reading ON ({status.ai.provider === 'gemini' ? 'Gemini' : status.ai.provider === 'anthropic' ? 'Claude' : 'AI'}) — sender, date, amount &amp; type extracted automatically</span>
                : <span style={{ color: '#b45309', fontWeight: 700 }}>AI reading OFF — set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY on the backend to enable</span>}
            </div>
          </div>

          {uploadResult && (
            <div style={{ background: '#F0FDF4', border: '1px solid #86EFAC', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 13 }}>
              <div style={{ fontWeight: 700, color: '#15803d', marginBottom: 6 }}>✓ {uploadResult.uploaded} document{uploadResult.uploaded !== 1 ? 's' : ''} filed</div>
              {(uploadResult.recent || []).map(d => (
                <div key={d.id} style={{ padding: '4px 0', borderTop: '1px solid #DCFCE7', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className="badge badge-admin">{d.docType}</span>
                  <strong>{d.sender}</strong>
                  {d.totalAmount != null && <span style={{ color: '#15803d', fontWeight: 700 }}>${Number(d.totalAmount).toFixed(2)}</span>}
                  {d.docDate && <span style={{ color: '#777' }}>{fmtDate(d.docDate)}</span>}
                  {d.summary && <span style={{ color: '#555' }}>— {d.summary}</span>}
                  {d.status === 'needs_review' && <span style={{ color: '#b45309', fontWeight: 700 }}>needs review</span>}
                </div>
              ))}
            </div>
          )}

          {/* Watcher status — make it impossible to miss whether automatic
              folder watching is on and where it points. Mom's scanner drops
              files into the inbox; this is the load-bearing setting. */}
          {(() => {
            const watching = !!(config.enabled && config.inboxPath && config.libraryPath);
            const haveConfig = !!(config.inboxPath && config.libraryPath);
            const bg = watching ? '#F0FDF4' : (haveConfig ? '#FFFBEB' : '#FEF2F2');
            const border = watching ? '#86EFAC' : (haveConfig ? '#FDE68A' : '#FCA5A5');
            const dot = watching ? '#15803d' : (haveConfig ? '#A16207' : '#b91c1c');
            return (
              <div style={{ background: bg, border: `1.5px solid ${border}`, borderRadius: 10, padding: '12px 16px', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: haveConfig ? 8 : 0 }}>
                  <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: dot, boxShadow: watching ? `0 0 0 4px ${dot}22` : 'none', animation: watching ? 'none' : undefined }} />
                  <strong style={{ fontSize: 14, color: '#222' }}>
                    {watching ? 'Auto-filing is ON' : haveConfig ? 'Auto-filing is paused' : 'Set up auto-filing'}
                  </strong>
                  {watching && status?.pollMs && <span style={{ fontSize: 11, color: '#15803d', marginLeft: 'auto' }}>checks every {Math.round(status.pollMs / 1000)}s</span>}
                </div>
                {haveConfig ? (
                  <div style={{ fontSize: 12.5, color: '#444', lineHeight: 1.6 }}>
                    <div>📥 Watches → <code style={{ background: '#fff', padding: '1px 6px', borderRadius: 3, border: '1px solid #ddd' }}>{config.inboxPath}</code></div>
                    <div>📚 Files into → <code style={{ background: '#fff', padding: '1px 6px', borderRadius: 3, border: '1px solid #ddd' }}>{config.libraryPath}</code></div>
                  </div>
                ) : (
                  <div style={{ fontSize: 12.5, color: '#7a1f1f', lineHeight: 1.5 }}>
                    Tell the scanner where to drop files (the inbox folder) and where the library should live below. Then press <strong>▶ Start Watcher</strong>.
                  </div>
                )}
              </div>
            );
          })()}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10, marginBottom: 12 }}>
            <FI label="Watch Inbox Folder (where the scanner saves files)" value={config.inboxPath || ''} onChange={e => setConfig(c => ({ ...c, inboxPath: e.target.value }))} placeholder="C:\Scans\Inbox" />
            <FI label="Library Root Folder (where filed documents go)" value={config.libraryPath || ''} onChange={e => setConfig(c => ({ ...c, libraryPath: e.target.value }))} placeholder="C:\Scans\Library" />
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
              <option value="">All Buckets</option>
              <option value="degrill">degrill</option>
              <option value="parathas">parathas</option>
              <option value="dera">dera</option>
              <option value="personal">personal / tax</option>
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
                <tr><th></th><th>Doc Date</th><th>Sender</th><th>Type</th><th>Amount</th><th>Business</th><th>Status</th><th>Summary / File</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {results.map(item => {
                  const checked = selectedIds.includes(item.id);
                  const needsReview = item.status === 'needs_review';
                  return (
                    <tr key={item.id} style={needsReview ? { background: '#FFFBEB' } : undefined}>
                      <td><input type="checkbox" checked={checked} onChange={e => setSelectedIds(ids => e.target.checked ? [...new Set([...ids, item.id])] : ids.filter(x => x !== item.id))} /></td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(item.docDate || String(item.importedAt || '').slice(0, 10))}</td>
                      <td style={{ fontWeight: 600 }}>{item.sender}</td>
                      <td>
                        <select className="input" style={{ padding: '2px 4px', fontSize: 12, minWidth: 110 }} value={item.docType}
                          onChange={e => updateOne(item, { docType: e.target.value })}>
                          {SCAN_DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </td>
                      <td style={{ whiteSpace: 'nowrap', fontWeight: 600, color: '#15803d' }}>{item.totalAmount != null ? `$${Number(item.totalAmount).toFixed(2)}` : ''}</td>
                      <td>
                        <select className="input" style={{ padding: '2px 4px', fontSize: 12 }} value={item.businessTag || 'unknown'}
                          onChange={e => updateOne(item, { businessTag: e.target.value === 'unknown' ? '' : e.target.value })}>
                          <option value="unknown">unknown</option>
                          <option value="degrill">degrill</option>
                          <option value="parathas">parathas</option>
                          <option value="dera">dera</option>
                          <option value="personal">personal / tax</option>
                        </select>
                      </td>
                      <td>{needsReview ? <span style={{ color: '#b45309', fontWeight: 700, fontSize: 12 }}>review</span> : <span style={{ color: '#15803d', fontSize: 12 }}>✓ ok</span>}</td>
                      <td style={{ maxWidth: 280, wordBreak: 'break-word', fontSize: 12 }}>
                        {item.summary ? <div style={{ color: '#444' }}>{item.summary}</div> : null}
                        <div style={{ color: '#999', fontSize: 11 }}>{item.fileName}{item.extractedBy === 'ai' ? ' · 🤖' : ''}</div>
                      </td>
                      <td>
                        {needsReview && <Btn className="btn-outline btn-sm" onClick={() => updateOne(item, { status: 'classified' })}>Mark OK</Btn>}
                      </td>
                    </tr>
                  );
                })}
                {!results.length && <tr><td colSpan={9}><div className="muted text-center">No scanned documents matched current filters.</div></td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// Unified search across catering / purchase / transfer invoices, customers,
// items, and (if the backend is up) scanned documents. One bar to find
// anything in the system — no more rooting around in tabs.
//
// Opens via Cmd/Ctrl+K or a Dashboard button. Results group by type, show
// the key fields, and click straight through to the record (parent App
// receives an onOpen({tab,id,kind}) and threads it to the destination tab
// as a pendingOpen prop).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { fmt$, fmtDate } from '../formatters.js';

const RESULTS_PER_GROUP = 6;

function tokenize(q) {
  return String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
}
function matchesAll(text, tokens) {
  const lc = String(text || '').toLowerCase();
  return tokens.every(t => lc.includes(t));
}

export default function GlobalSearch({
  open, onClose, onOpen,
  items = [], cateringInvoices = [], purchaseInvoices = [], transferInvoices = [],
  customers = [], suppliers = [],
  currentUser, isOnline, scanApiCall,
}) {
  const [q, setQ] = useState('');
  const [scanHits, setScanHits] = useState([]);
  const [scanLoading, setScanLoading] = useState(false);
  const inputRef = useRef(null);
  const adminScanEnabled = !!(currentUser?.role === 'admin' && currentUser?.authHash && isOnline && scanApiCall);

  // Reset on open and focus the input.
  useEffect(() => {
    if (open) {
      setQ('');
      setScanHits([]);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Debounced scan-DB search — only runs when the backend is reachable
  // and the admin has unlocked the scanner. Otherwise we skip it silently
  // (the local-data results still work).
  useEffect(() => {
    if (!open || !adminScanEnabled || q.trim().length < 2) { setScanHits([]); return; }
    let cancelled = false;
    setScanLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await scanApiCall('/api/scan/search', { currentUser, query: { q: q.trim() } });
        if (!cancelled && res?.ok) setScanHits((res.data?.items || []).slice(0, RESULTS_PER_GROUP));
      } catch { /* offline / unauthorized — skip */ }
      finally { if (!cancelled) setScanLoading(false); }
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, open, adminScanEnabled]);

  // Local-data search, grouped by category.
  const local = useMemo(() => {
    const tokens = tokenize(q);
    if (!tokens.length) return null;
    const haystack = (...parts) => parts.filter(Boolean).join(' ');

    const catering = cateringInvoices
      .map(i => ({ inv: i, blob: haystack(i.id, i.customerName, i.customerPhone, i.eventType, i.notes, (i.lineItems || []).map(l => l.description).join(' ')) }))
      .filter(x => matchesAll(x.blob, tokens))
      .slice(0, RESULTS_PER_GROUP)
      .map(x => x.inv);

    const purchase = purchaseInvoices
      .map(i => ({ inv: i, blob: haystack(i.id, i.supplier, i.notes, (i.lineItems || []).map(l => l.description).join(' ')) }))
      .filter(x => matchesAll(x.blob, tokens))
      .slice(0, RESULTS_PER_GROUP)
      .map(x => x.inv);

    const transfer = transferInvoices
      .map(i => ({ inv: i, blob: haystack(i.id, i.from, i.to, (i.lineItems || []).map(l => l.item || l.description).join(' ')) }))
      .filter(x => matchesAll(x.blob, tokens))
      .slice(0, RESULTS_PER_GROUP)
      .map(x => x.inv);

    const cust = customers
      .map(c => ({ c, blob: haystack(c.name, c.phone, c.email, c.address) }))
      .filter(x => matchesAll(x.blob, tokens))
      .slice(0, RESULTS_PER_GROUP)
      .map(x => x.c);

    const itemHits = items
      .map(it => ({ it, blob: haystack(it.name, it.category, it.unit) }))
      .filter(x => matchesAll(x.blob, tokens))
      .slice(0, RESULTS_PER_GROUP)
      .map(x => x.it);

    const supHits = suppliers
      .map(s => ({ s, blob: haystack(s.name, s.contact, s.phone, s.email, s.address) }))
      .filter(x => matchesAll(x.blob, tokens))
      .slice(0, RESULTS_PER_GROUP)
      .map(x => x.s);

    return { catering, purchase, transfer, cust, itemHits, supHits };
  }, [q, cateringInvoices, purchaseInvoices, transferInvoices, customers, items, suppliers]);

  function fire(target) {
    onOpen?.(target);
    onClose?.();
  }

  const totalLocal = local ? (local.catering.length + local.purchase.length + local.transfer.length + local.cust.length + local.itemHits.length + local.supHits.length) : 0;
  const noResults = local && totalLocal === 0 && scanHits.length === 0 && !scanLoading;

  return (
    <Modal open={open} onClose={onClose} title="🔎 Search everything" maxW={680} closeOnBackdrop>
      <div style={{ position: 'sticky', top: 0, background: '#fff', paddingBottom: 8, zIndex: 1 }}>
        <input
          ref={inputRef}
          className="input"
          placeholder="Type a name, invoice #, dollar amount, supplier… (Esc to close)"
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') onClose?.(); }}
          style={{ fontSize: 15, padding: '10px 12px' }}
        />
        <div style={{ fontSize: 11.5, color: '#999', marginTop: 6 }}>
          Searches invoices, customers, items, suppliers{adminScanEnabled ? ', and scanned documents' : ''}.
          Click a result to open it.
        </div>
      </div>

      {!local && (
        <div style={{ padding: '24px 8px', color: '#999', textAlign: 'center', fontSize: 13 }}>
          Start typing to search.
        </div>
      )}

      {noResults && (
        <div style={{ padding: '20px 8px', color: '#b45309', textAlign: 'center', fontSize: 13 }}>
          No matches for <strong>"{q}"</strong>. Try fewer words or a different spelling.
        </div>
      )}

      {local && local.catering.length > 0 && (
        <Group title="Catering Invoices" color="#8B4513">
          {local.catering.map(i => (
            <Row key={i.id} onClick={() => fire({ kind: 'catering', id: i.id, tab: 'catering' })}
              left={<><strong>{i.id}</strong> · {i.customerName || '(no customer)'}</>}
              right={<>{fmt$(i.grandTotal || 0)}</>}
              sub={`${i.eventType || 'Catering'} · ${fmtDate(i.date || i.dateStart)}`}
            />
          ))}
        </Group>
      )}

      {local && local.purchase.length > 0 && (
        <Group title="Purchase Invoices" color="#1D4ED8">
          {local.purchase.map(i => (
            <Row key={i.id} onClick={() => fire({ kind: 'purchase', id: i.id, tab: 'purchase' })}
              left={<><strong>{i.id}</strong> · {i.supplier || '(no supplier)'}</>}
              right={<>{fmt$(i.total || 0)}</>}
              sub={`${fmtDate(i.date)} · ${i.status || 'unpaid'}`}
            />
          ))}
        </Group>
      )}

      {local && local.transfer.length > 0 && (
        <Group title="Transfer Invoices" color="#A16207">
          {local.transfer.map(i => (
            <Row key={i.id} onClick={() => fire({ kind: 'transfer', id: i.id, tab: 'transfer' })}
              left={<><strong>{i.id}</strong> · {i.from} → {i.to}</>}
              right={<>{fmt$(i.total || 0)}</>}
              sub={fmtDate(i.date)}
            />
          ))}
        </Group>
      )}

      {local && local.cust.length > 0 && (
        <Group title="Customers" color="#15803D">
          {local.cust.map(c => (
            <Row key={c.id} onClick={() => fire({ kind: 'customer', id: c.id, tab: 'customers' })}
              left={<strong>{c.name}</strong>}
              right={c.phone || ''}
              sub={[c.email, c.address].filter(Boolean).join(' · ')}
            />
          ))}
        </Group>
      )}

      {local && local.itemHits.length > 0 && (
        <Group title="Items" color="#7C3AED">
          {local.itemHits.map(it => (
            <Row key={it.id} onClick={() => fire({ kind: 'item', id: it.id, tab: 'items' })}
              left={<strong>{it.name}</strong>}
              right={it.unit || ''}
              sub={it.category || ''}
            />
          ))}
        </Group>
      )}

      {local && local.supHits.length > 0 && (
        <Group title="Suppliers" color="#DB2777">
          {local.supHits.map(s => (
            <Row key={s.id} onClick={() => fire({ kind: 'supplier', id: s.id, tab: 'suppliers' })}
              left={<strong>{s.name}</strong>}
              right={s.phone || ''}
              sub={[s.contact, s.email].filter(Boolean).join(' · ')}
            />
          ))}
        </Group>
      )}

      {adminScanEnabled && (scanHits.length > 0 || scanLoading) && (
        <Group title={`Scanned Documents${scanLoading ? ' (searching…)' : ''}`} color="#0E7490">
          {scanHits.map(d => (
            <Row key={d.id} onClick={() => fire({ kind: 'scan', id: d.id, tab: 'scanbeta', query: q })}
              left={<><strong>{d.sender || 'Unknown'}</strong> · <span style={{ color: '#666' }}>{d.docType}</span></>}
              right={d.totalAmount != null ? fmt$(d.totalAmount) : ''}
              sub={[d.docDate ? fmtDate(d.docDate) : null, d.summary, d.fileName].filter(Boolean).join(' · ')}
            />
          ))}
        </Group>
      )}
    </Modal>
  );
}

function Group({ title, color, children }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color, textTransform: 'uppercase', borderBottom: `1.5px solid ${color}`, paddingBottom: 3, marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

function Row({ left, right, sub, onClick }) {
  return (
    <button onClick={onClick}
      style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid #f3f3f3', padding: '8px 6px', cursor: 'pointer', fontSize: 13 }}
      onMouseEnter={e => e.currentTarget.style.background = '#FBF6EC'}
      onMouseLeave={e => e.currentTarget.style.background = 'none'}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#222' }}>{left}</div>
        <div style={{ color: '#555', fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{right}</div>
      </div>
      {sub && <div style={{ fontSize: 11.5, color: '#888', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>}
    </button>
  );
}

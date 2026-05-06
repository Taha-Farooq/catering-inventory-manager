import { load, save, today } from './storage.js';

// _seq: monotonic counters for human-readable invoice IDs (P-0001, C-0001, PPH-ENG-date-0001).
let _seq = load('_seq', { purchase: 0, catering: 0 });

export function nextId(type) {
  _seq[type] = (_seq[type] || 0) + 1;
  save('_seq', _seq);
  return (type === 'purchase' ? 'P-' : 'C-') + String(_seq[type]).padStart(4, '0');
}

export function nextTransferId(dateStr) {
  const d = (dateStr || today()).replace(/-/g, '');
  _seq.transfer = (_seq.transfer || 0) + 1;
  save('_seq', _seq);
  return `PPH-ENG-${d}-${String(_seq.transfer).padStart(4, '0')}`;
}

export function normalizeTransferInvoice(inv) {
  const date = inv?.date || today();
  const lineItems = Array.isArray(inv?.lineItems) ? inv.lineItems : [];
  const normalizedLines = lineItems.map(li => {
    const price = +((li?.price ?? li?.unitPrice ?? 0) || 0);
    const commission = +(li?.commission ?? (price * 0.15)).toFixed(2);
    const total = +(li?.total ?? (price + commission)).toFixed(2);
    return {
      quantity: li?.quantity ?? li?.qty ?? '',
      item: li?.item ?? li?.description ?? '',
      price: +price.toFixed(2),
      commission,
      total
    };
  });
  const subTotal = +(inv?.subTotal ?? normalizedLines.reduce((s, l) => s + (l.price || 0), 0)).toFixed(2);
  const commissionTotal = +(inv?.commissionTotal ?? normalizedLines.reduce((s, l) => s + (l.commission || 0), 0)).toFixed(2);
  const grandTotal = +(inv?.grandTotal ?? (subTotal + commissionTotal)).toFixed(2);
  return {
    ...inv,
    id: inv?.id || nextTransferId(date),
    invoiceType: inv?.invoiceType || 'pp_transfer',
    status: inv?.status || 'unpaid',
    date,
    from: inv?.from || 'Parathas & Platters - Hackensack',
    fromContact: inv?.fromContact || 'Hackensack Branch',
    to: inv?.to || 'Parathas & Platters - Englewood',
    toContact: inv?.toContact || 'Englewood Branch',
    notes: inv?.notes || '',
    lineItems: normalizedLines,
    commissionRate: inv?.commissionRate ?? 0.15,
    subTotal,
    commissionTotal,
    grandTotal,
    createdAt: inv?.createdAt || new Date().toISOString()
  };
}

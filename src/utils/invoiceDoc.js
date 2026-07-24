// Professional invoice document builder.
//
// One letterhead-quality template for all three invoice types (catering,
// purchase, transfer). Each type produces a slightly different "labels"
// shape but uses the same overall layout, so every document the business
// emits looks like it came from one disciplined operation.

import { buildProfessionalDoc, docMoney, esc } from './professionalDoc.js';

function fmtDate(s) {
  if (!s) return '';
  try { return new Date(String(s) + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch { return String(s); }
}

function lineItemsTable(lines, columns = ['Description', 'Qty', 'Unit Price', 'Total']) {
  const head = `<tr style="background:#FBF6EC">` + columns.map((c, i) => {
    const align = i === 0 ? 'left' : 'right';
    return `<th style="text-align:${align};padding:7px 10px;border-bottom:1.5px solid #8B4513;font-size:10.5px;letter-spacing:.5px;color:#8B4513;text-transform:uppercase;">${esc(c)}</th>`;
  }).join('') + `</tr>`;
  const body = (lines || []).map(l => {
    const qty = l.quantity ?? l.qty ?? '';
    const price = l.unitPrice ?? l.price ?? 0;
    const total = l.total != null ? l.total : (Number(qty) || 0) * (Number(price) || 0);
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;color:#222;">${esc(l.description || '')}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-size:13px;color:#222;font-variant-numeric:tabular-nums;">${esc(qty)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-size:13px;color:#222;font-variant-numeric:tabular-nums;">${esc(docMoney(price))}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-size:13px;color:#222;font-variant-numeric:tabular-nums;">${esc(docMoney(total))}</td>
    </tr>`;
  }).join('');
  return `<table style="width:100%;border-collapse:collapse;">${head}${body}</table>`;
}

function totalsBlock(rows, finalRow) {
  const rowsHtml = (rows || []).map(r => `<tr>
    <td style="padding:5px 10px;text-align:right;font-size:12.5px;color:#555;">${esc(r.label)}</td>
    <td style="padding:5px 10px;text-align:right;font-size:12.5px;color:#555;font-variant-numeric:tabular-nums;min-width:120px;">${esc(r.value)}</td>
  </tr>`).join('');
  const finalHtml = finalRow ? `<tr>
    <td style="padding:9px 10px;text-align:right;font-size:14px;font-weight:800;color:#111;border-top:2px solid #333;">${esc(finalRow.label)}</td>
    <td style="padding:9px 10px;text-align:right;font-size:14px;font-weight:800;color:${finalRow.accent || '#111'};border-top:2px solid #333;font-variant-numeric:tabular-nums;">${esc(finalRow.value)}</td>
  </tr>` : '';
  return `<table style="width:auto;margin-left:auto;border-collapse:collapse;margin-top:8px;">${rowsHtml}${finalHtml}</table>`;
}

function paymentsBlock(payments) {
  if (!payments || !payments.length) return '';
  const rows = payments.map(p => `<tr>
    <td style="padding:5px 10px;font-size:12px;color:#555;">${esc(fmtDate(p.date))}</td>
    <td style="padding:5px 10px;font-size:12px;color:#555;">${esc(p.note || '')}</td>
    <td style="padding:5px 10px;font-size:12.5px;text-align:right;color:#15803d;font-weight:600;font-variant-numeric:tabular-nums;">${esc(docMoney(p.amount))}</td>
  </tr>`).join('');
  return `<div style="margin-top:18px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:.6px;color:#15803d;text-transform:uppercase;margin-bottom:4px;">Payments Received</div>
    <table style="width:100%;border-collapse:collapse;">${rows}</table>
  </div>`;
}

/**
 * Catering invoice. `inv` = catering record. `brand` = letterhead.
 */
export function buildCateringInvoiceDoc(inv, brand) {
  const eventDate = inv.useRange && inv.dateStart
    ? `${fmtDate(inv.dateStart)} – ${fmtDate(inv.dateEnd)}`
    : fmtDate(inv.date);

  const totals = totalsBlock(
    [
      { label: 'Subtotal', value: docMoney(inv.subtotal || 0) },
      ...(inv.ccFee ? [{ label: 'Credit-card fee', value: docMoney(inv.ccFee) }] : []),
      ...(inv.taxAmount ? [{ label: 'Tax', value: docMoney(inv.taxAmount) }] : []),
    ],
    { label: 'Grand Total', value: docMoney(inv.grandTotal || 0) }
  );

  // Compute total paid from payments[] + legacy deposit field
  const totalPaid = (Array.isArray(inv.payments) ? inv.payments.reduce((s, p) => s + (Number(p.amount) || 0), 0) : 0) + (Number(inv.deposit) || 0);
  const balance = +(((inv.grandTotal || 0) - totalPaid)).toFixed(2);
  const balanceRow = balance > 0
    ? `<div style="margin-top:14px;padding:12px 16px;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:8px;text-align:right;">
        <span style="font-size:12px;color:#444;">BALANCE DUE</span>
        <span style="font-size:20px;font-weight:800;color:#b91c1c;margin-left:10px;">${esc(docMoney(balance))}</span>
      </div>`
    : `<div style="margin-top:14px;padding:10px 14px;background:#F0FDF4;border:1px solid #86EFAC;border-radius:8px;text-align:right;font-size:13px;color:#15803d;font-weight:700;">PAID IN FULL — thank you</div>`;

  const eventDetails = inv.eventType || inv.guestCount
    ? `<div style="margin-top:10px;padding:10px 12px;background:#FBF6EC;border:1px solid #EED9B0;border-radius:6px;font-size:12.5px;color:#5a3010;">
        ${inv.eventType ? `<div><strong>Event:</strong> ${esc(inv.eventType)}</div>` : ''}
        ${inv.guestCount ? `<div><strong>Guests:</strong> ${esc(String(inv.guestCount))}</div>` : ''}
      </div>` : '';

  const notes = inv.notes
    ? `<div style="margin-top:14px;padding-top:10px;border-top:1px solid #eee;font-size:12px;color:#555;"><strong>Notes:</strong> ${esc(inv.notes)}</div>`
    : '';

  return buildProfessionalDoc({
    branding: brand,
    docType: 'CATERING INVOICE',
    docNumber: inv.id,
    periodLabel: eventDate,
    recipient: {
      title: 'Bill To',
      lines: [inv.customerName, inv.customerAddress, [inv.customerPhone, inv.customerEmail].filter(Boolean).join(' · ')].filter(Boolean),
    },
    bodyHtml: lineItemsTable(inv.lineItems) + totals + balanceRow + eventDetails + paymentsBlock(inv.payments) + notes,
    footerNote: inv.paymentTerms || 'Thank you for choosing us. Please remit payment per the agreed terms.',
  });
}

/**
 * Purchase invoice. `inv` = purchase record. `brand` = your business
 * letterhead (the buyer).
 */
export function buildPurchaseInvoiceDoc(inv, brand) {
  const totals = totalsBlock(
    [{ label: 'Subtotal', value: docMoney(inv.subtotal || inv.total || 0) }],
    { label: 'Total', value: docMoney(inv.total || 0) }
  );
  const paidStatus = String(inv.status || 'unpaid').toLowerCase();
  const dueDate = inv.dueDate ? fmtDate(inv.dueDate) : '';
  const paidAt = inv.paidAt ? fmtDate(inv.paidAt) : (inv.payment?.date ? fmtDate(inv.payment.date) : '');

  const statusBlock = paidStatus === 'paid'
    ? `<div style="margin-top:14px;padding:10px 14px;background:#F0FDF4;border:1px solid #86EFAC;border-radius:8px;text-align:right;font-size:13px;color:#15803d;font-weight:700;">PAID${paidAt ? ` on ${esc(paidAt)}` : ''}</div>`
    : `<div style="margin-top:14px;padding:12px 16px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:12px;color:#7a5c20;font-weight:700;letter-spacing:.5px;">UNPAID${dueDate ? ` — DUE ${esc(dueDate)}` : ''}</span>
        <span style="font-size:18px;font-weight:800;color:#92400e;">${esc(docMoney(inv.total || 0))}</span>
      </div>`;

  const notes = inv.notes
    ? `<div style="margin-top:14px;padding-top:10px;border-top:1px solid #eee;font-size:12px;color:#555;"><strong>Notes:</strong> ${esc(inv.notes)}</div>`
    : '';

  return buildProfessionalDoc({
    branding: brand,
    docType: 'PURCHASE INVOICE',
    docNumber: inv.id,
    periodLabel: fmtDate(inv.date),
    recipient: {
      title: 'Supplier',
      lines: [inv.supplier, inv.supplierAddress, [inv.supplierPhone, inv.supplierEmail].filter(Boolean).join(' · ')].filter(Boolean),
    },
    bodyHtml: lineItemsTable(inv.lineItems) + totals + statusBlock + notes,
    footerNote: 'Goods received and recorded under this purchase invoice. Verify against supplier delivery slip.',
  });
}

/**
 * Transfer invoice (inter-location stock movement, e.g. Hackensack →
 * Englewood with a 15% commission). `brand` = letterhead.
 */
export function buildTransferInvoiceDoc(inv, brand) {
  const totals = totalsBlock(
    [
      { label: 'Goods subtotal', value: docMoney(inv.subtotal || 0) },
      ...(inv.commission ? [{ label: `Commission (${inv.commissionPct || 15}%)`, value: docMoney(inv.commission) }] : []),
    ],
    { label: 'Transfer Total', value: docMoney(inv.total || 0) }
  );

  const route = inv.from && inv.to ? `${inv.from} → ${inv.to}` : (inv.from || inv.to || 'Internal transfer');
  const notes = inv.notes
    ? `<div style="margin-top:14px;padding-top:10px;border-top:1px solid #eee;font-size:12px;color:#555;"><strong>Notes:</strong> ${esc(inv.notes)}</div>`
    : '';

  return buildProfessionalDoc({
    branding: brand,
    docType: 'INTER-LOCATION TRANSFER INVOICE',
    docNumber: inv.id,
    periodLabel: fmtDate(inv.date),
    recipient: { title: 'Route', lines: [route] },
    bodyHtml: lineItemsTable(inv.lineItems) + totals + notes,
    footerNote: 'Inter-location goods transfer. Commission is internal accounting between sister entities.',
  });
}

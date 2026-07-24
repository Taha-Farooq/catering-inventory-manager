// Professional document builder.
//
// Turns business data into printable, letterhead-quality documents — the kind
// you hand to a business partner, an employee, or a tax preparer to settle a
// question instead of arguing about it. Pure string functions (no React, no
// DOM) so the layout is unit-testable; the result is passed to
// printHtmlDocument() which opens the print/Save-as-PDF dialog.

/** HTML-escape a value for safe interpolation. */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Accounting-style currency: negatives in parentheses, thousands separators. */
export function docMoney(n) {
  const num = Number(n) || 0;
  const abs = Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return num < 0 ? `($${abs})` : `$${abs}`;
}

/**
 * Render one statement section: a heading and a set of rows, with an optional
 * bold total line. Each row: { label, value, indent?, strong?, muted?, accent? }.
 * `value` is rendered verbatim (pre-format money with docMoney before passing).
 */
export function docSection({ heading, rows = [], total = null, accent = '#8B4513' }) {
  const headHtml = heading
    ? `<tr><td colspan="2" style="padding:14px 0 6px;font-size:11px;font-weight:700;letter-spacing:.8px;color:${esc(accent)};text-transform:uppercase;border-bottom:1.5px solid ${esc(accent)};">${esc(heading)}</td></tr>`
    : '';
  const rowsHtml = rows.map(r => {
    const pad = r.indent ? 'padding-left:18px;' : '';
    const weight = r.strong ? 'font-weight:700;' : '';
    const color = r.muted ? 'color:#777;' : r.accent ? `color:${esc(r.accent)};` : 'color:#222;';
    return `<tr>
      <td style="padding:5px 0;${pad}${weight}${color}font-size:13px;">${esc(r.label)}</td>
      <td style="padding:5px 0;text-align:right;${weight}${color}font-size:13px;font-variant-numeric:tabular-nums;">${esc(r.value)}</td>
    </tr>`;
  }).join('');
  const totalHtml = total
    ? `<tr>
        <td style="padding:8px 0;border-top:2px solid #333;font-weight:800;font-size:14px;color:#111;">${esc(total.label)}</td>
        <td style="padding:8px 0;border-top:2px solid #333;text-align:right;font-weight:800;font-size:14px;color:${total.accent ? esc(total.accent) : '#111'};font-variant-numeric:tabular-nums;">${esc(total.value)}</td>
      </tr>`
    : '';
  return `<table style="width:100%;border-collapse:collapse;margin-bottom:6px;">${headHtml}${rowsHtml}${totalHtml}</table>`;
}

/**
 * Assemble a full professional document.
 *
 * opts:
 *  - branding: { name, address, phone, email, logo }  — letterhead
 *  - docType:  e.g. "PROFIT & LOSS STATEMENT"
 *  - docNumber: optional reference id (top-right)
 *  - periodLabel: e.g. "October 1 – 31, 2026"
 *  - recipient: optional { title, lines: [] } block (e.g. PAID TO an employee)
 *  - bodyHtml: main content (build with docSection)
 *  - footerNote: optional fine-print string
 *  - accent: hex accent color (default brand brown)
 *  - confidential: when true, stamps a subtle CONFIDENTIAL note
 */
export function buildProfessionalDoc(opts = {}) {
  const {
    branding = {},
    docType = 'DOCUMENT',
    docNumber = '',
    periodLabel = '',
    recipient = null,
    bodyHtml = '',
    footerNote = '',
    accent = '#8B4513',
    confidential = false,
  } = opts;

  const generated = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const logoHtml = branding.logo
    ? `<img src="${esc(branding.logo)}" alt="" style="width:54px;height:54px;border-radius:50%;object-fit:cover;border:2px solid #EED9B0;margin-right:12px;" />`
    : '';

  const recipientHtml = recipient
    ? `<div style="margin:18px 0 10px;">
        <div style="font-size:10.5px;font-weight:700;letter-spacing:.6px;color:#888;text-transform:uppercase;">${esc(recipient.title || 'Prepared for')}</div>
        ${(recipient.lines || []).map((l, i) => `<div style="font-size:${i === 0 ? '15px;font-weight:700' : '12.5px'};color:#222;margin-top:2px;">${esc(l)}</div>`).join('')}
      </div>`
    : '';

  const periodHtml = periodLabel
    ? `<div style="display:inline-block;margin-top:6px;font-size:12px;color:#444;background:#FBF6EC;border:1px solid #EED9B0;border-radius:6px;padding:4px 12px;">Period: <strong>${esc(periodLabel)}</strong></div>`
    : '';

  const confidentialHtml = confidential
    ? `<div style="margin-top:6px;font-size:10px;letter-spacing:1px;color:#b91c1c;font-weight:700;">CONFIDENTIAL — FOR INTERNAL / AUTHORIZED USE ONLY</div>`
    : '';

  const footerHtml = footerNote || confidential
    ? `<div style="margin-top:28px;padding-top:10px;border-top:1px solid #eee;font-size:10.5px;color:#999;line-height:1.5;">
        ${footerNote ? esc(footerNote) + '<br/>' : ''}
        Generated ${esc(generated)}${branding.name ? ' · ' + esc(branding.name) : ''}
      </div>`
    : `<div style="margin-top:28px;padding-top:10px;border-top:1px solid #eee;font-size:10.5px;color:#999;">Generated ${esc(generated)}${branding.name ? ' · ' + esc(branding.name) : ''}</div>`;

  return `
    <div style="max-width:760px;margin:0 auto;font-family:'Segoe UI',Arial,sans-serif;color:#222;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid ${esc(accent)};padding-bottom:14px;">
        <div style="display:flex;align-items:center;">
          ${logoHtml}
          <div>
            <div style="font-size:20px;font-weight:800;color:${esc(accent)};">${esc(branding.name || 'Business')}</div>
            ${branding.address ? `<div style="font-size:11.5px;color:#666;margin-top:2px;">${esc(branding.address)}</div>` : ''}
            <div style="font-size:11.5px;color:#666;">${[branding.phone, branding.email].filter(Boolean).map(esc).join(' · ')}</div>
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:13px;font-weight:800;letter-spacing:1px;color:#333;">${esc(docType)}</div>
          ${docNumber ? `<div style="font-size:11.5px;color:#888;margin-top:3px;">No. ${esc(docNumber)}</div>` : ''}
          ${periodHtml}
          ${confidentialHtml}
        </div>
      </div>
      ${recipientHtml}
      <div style="margin-top:14px;">${bodyHtml}</div>
      ${footerHtml}
    </div>
  `;
}

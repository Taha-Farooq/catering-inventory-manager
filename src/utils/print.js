import { showToast } from '../toastContext.jsx';
import { resolveAssetUrl } from '../formatters.js';

export function documentBaseHref() {
  try {
    const u = new URL(window.location.href);
    u.hash = '';
    u.search = '';
    const path = u.pathname || '/';
    const i = path.lastIndexOf('/');
    u.pathname = i >= 0 ? path.slice(0, i + 1) : '/';
    return u.href;
  } catch {
    return window.location.href.split('#')[0].split('?')[0];
  }
}

export function rewriteImgSrcsForPrint(html, baseHref) {
  const base = baseHref || documentBaseHref();
  try {
    const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
    const root = doc.getElementById('root');
    if (!root) return html;
    root.querySelectorAll('img[src]').forEach((img) => {
      const raw = img.getAttribute('src') || '';
      img.setAttribute('src', resolveAssetUrl(raw, base));
    });
    return root.innerHTML;
  } catch {
    return html;
  }
}

export function printHtmlDocument(html, title = 'Invoice') {
  const w = window.open('', '_blank', 'width=1024,height=768');
  if (!w) { showToast('Pop-up blocked. Please allow pop-ups.', 'error'); return false; }
  const base = documentBaseHref();
  const safeHtml = rewriteImgSrcsForPrint(html, base);
  const escBase = base.replace(/"/g, '&quot;');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"/><base href="${escBase}"/><title>${title}</title>
<style>
  body{font-family:Segoe UI,Arial,sans-serif;margin:20px;color:#222}
  .print-wrap{max-width:900px;margin:0 auto}
  .invoice-mark{display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:50%;background:#8B4513;color:#fff;font-weight:800;font-size:13px;margin-right:10px;overflow:hidden}
  .invoice-mark img{width:42px;height:42px;object-fit:cover}
  table{width:100%;border-collapse:collapse;margin-top:10px}
  th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:12px}
  th{background:#f7f7f7}
  .text-right{text-align:right}
  .muted{color:#666;font-size:12px}
  @media print{body{margin:8mm} .no-print{display:none}}
</style></head><body><div class="print-wrap">${safeHtml}</div></body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
  return true;
}

export function printInvoiceById(sectionId) {
  const el = document.getElementById(sectionId);
  if (!el) { showToast('Invoice content not found.', 'error'); return; }
  printHtmlDocument(el.outerHTML, 'Invoice');
}

// One-click full backup, callable from anywhere (Dashboard nudge, Settings).
//
// Reads every dataset from storage rather than React state — state and
// storage are kept in sync by save(), so the archive matches what Settings'
// export produces (same keys, same version string, same README).

import JSZip from 'jszip';
import { load, today } from './storage.js';
import { secureGet } from './secureStore.js';
import { showToast } from '../toastContext.jsx';
import { logActivity } from '../tabUtils.js';
import {
  INVENTORY_ADJUSTMENTS_KEY,
  CUSTOM_CATEGORIES_KEY,
  LOGO_OVERRIDES_KEY,
  BIZ_CONTACT_KEY,
  STAFF_SESSION_TIMEOUT_KEY,
  DEFAULT_STAFF_SESSION_TIMEOUT,
} from '../constants.js';

function loadEmpRegistry() {
  try { return JSON.parse(localStorage.getItem('_employeeRegistry') || '{}'); } catch { return {}; }
}

export async function quickBackupZip() {
  try {
    const zip = new JSZip();
    const pwdStoreRaw = await secureGet('_staffPasswordStore', {});
    const payload = {
      items: load('items', []),
      shoppingList: load('shoppingList', []),
      purchaseInvoices: load('purchaseInvoices', []),
      cateringInvoices: load('cateringInvoices', []),
      transferInvoices: load('transferInvoices', []),
      payrollInvoices: load('payrollInvoices', []),
      dailyFinanceEntries: load('_dailyFinanceEntries', []),
      customers: load('customers', []),
      priceHistory: load('priceHistory', []),
      suppliers: load('_suppliers', []),
      inventoryAdjustments: load(INVENTORY_ADJUSTMENTS_KEY, []),
      credentials: load('credentials', {}),
      employeeRegistry: loadEmpRegistry(),
      staffPasswordStore: pwdStoreRaw || {},
      settings: {
        selectedBusiness: load('_lastBiz', 'degrill'),
        logoOverrides: load(LOGO_OVERRIDES_KEY, {}),
        bizContact: load(BIZ_CONTACT_KEY, {}),
        customCategories: load(CUSTOM_CATEGORIES_KEY, []),
        staffSessionTimeout: load(STAFF_SESSION_TIMEOUT_KEY, DEFAULT_STAFF_SESSION_TIMEOUT),
      },
      exportDate: new Date().toISOString(),
      version: '2.6',
    };
    Object.entries(payload).forEach(([k, v]) => zip.file(k + '.json', JSON.stringify(v, null, 2)));
    zip.file('README.txt',
      'Catering Inventory Manager — Backup\nExported: ' + new Date().toLocaleString() + '\n\n' +
      'To restore: Open the app → Settings (⚙) → Import Backup → select this ZIP file.\n\n' +
      'NOTE: This backup includes hashed staff login credentials for seamless device migration.\n' +
      'Keep this file secure — do not share it publicly.'
    );
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'catering-backup-' + today() + '.zip';
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    logActivity('export_backup', 'Exported data backup (quick backup)');
    showToast('Backup downloaded! Save the ZIP file somewhere safe.');
    return true;
  } catch (e) {
    showToast(`Backup failed: ${e.message}`, 'error');
    return false;
  }
}

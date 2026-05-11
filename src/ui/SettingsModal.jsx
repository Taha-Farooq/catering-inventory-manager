import React, { useState, useEffect, useMemo, useRef, useId } from 'react';
import JSZip from 'jszip';
import { load, save, today } from '../utils/storage.js';
import { logActivity } from '../utils/activity.js';
import { documentBaseHref } from '../utils/print.js';
import { showToast } from '../toastContext.jsx';
import { reportError } from '../errors.js';
import { normalizeLogoOverrides, fmtBytes, fmt$, resolveAssetUrl, normalizeApiBase } from '../formatters.js';
import {
  hashPwd,
  logFailure,
  syncCredentialsToBackend,
  loadAdminResetApiBase,
  saveAdminResetApiBase,
  probeResetApi,
  resolveResetApiBase,
  gatherDiagnosticsPayload,
  copyDiagnosticsReport,
  openSupportDiagnosticsEmail,
  openDiagnosticsGitHubIssue,
  downloadFailureLog,
  SUPPORT_CONTACT_EMAIL,
  BRANDING,
} from '../authHelpers.js';
import {
  DEFAULT_USER_PERMS,
  ALL_USER_TABS,
  ADMIN_RESET_API_BASE,
  ADMIN_RESET_CODE_KEY,
  LOGO_OVERRIDES_KEY,
  BIZ_CONTACT_KEY,
  CATEGORIES,
  CUSTOM_CATEGORIES_KEY,
  INVENTORY_ADJUSTMENTS_KEY,
} from '../constants.js';
import Modal from './Modal.jsx';
import Confirm from './Confirm.jsx';
import { BrandMark } from './BrandMark.jsx';

function loadEmpRegistry() {
  try { return JSON.parse(localStorage.getItem('_employeeRegistry') || '{}'); } catch { return {}; }
}

function genUsername(name) {
  return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'user';
}

function genPassword(name) {
  const first = name.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '') || 'user';
  return first + Math.floor(1000 + Math.random() * 9000);
}

function FI({ label, suggestions, fieldStyle, ...props }) {
  const listId = useId();
  const hasSuggestions = Array.isArray(suggestions) && suggestions.length > 0;
  const baseFieldStyle = label ? {} : { marginBottom: 0 };
  return (
    <div className="field" style={{ ...baseFieldStyle, ...fieldStyle }}>
      {label&&<label>{label}</label>}
      <input className="input" {...props} list={hasSuggestions ? listId : undefined} />
      {hasSuggestions && (
        <datalist id={listId}>
          {suggestions.map(s => <option key={s} value={s} />)}
        </datalist>
      )}
    </div>
  );
}
function Btn({ className='', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

function LogoField({ label, fieldKey, logoFields, setLogoFields, fileRef, onFile }) {
  const val = logoFields[fieldKey] || '';
  const isDataUrl = val.startsWith('data:');
  return (
    <div style={{display:'flex',alignItems:'flex-end',gap:8,marginBottom:10,flexWrap:'wrap'}}>
      <div style={{flex:'1 1 200px'}}>
        <FI label={label + ' URL'} value={isDataUrl ? '' : val}
          onChange={e=>{ const v=e.target.value; setLogoFields(prev=>Object.assign({},prev,{[fieldKey]:v})); }}
          placeholder="https://..." />
      </div>
      <div style={{paddingBottom:2}}>
        <input ref={fileRef} type="file" accept="image/*" style={{display:'none'}}
          onChange={e=>{onFile(fieldKey,e.target.files?.[0]);e.target.value='';}} />
        <Btn className="btn-outline btn-sm" onClick={()=>fileRef.current?.click()}>
          {isDataUrl ? '✓ File loaded' : '📁 Upload file'}
        </Btn>
      </div>
    </div>
  );
}

// SETTINGS MODAL (admin only)
export default function SettingsModal({ open, onClose, appState, currentUser, onPermsChange, localFeatureWarning, brandingMap }) {
  const { items, shopping, purchaseInv, cateringInv, transferInv, payrollInvoices,
          dailyFinanceEntries, customers, priceHist, suppliers,
          setItems, setShopping, setPurchaseInv, setCateringInv, setTransferInv,
          setPayrollInvoices, setDailyFinanceEntries, setCustomers, setPriceHist, setBiz,
          setSuppliers,
          logoOverrides, setLogoOverrides,
          bizContact, setBizContact } = appState;
  const importRef = useRef();
  const [diagPayload, setDiagPayload] = useState(null);
  const [diagLoading, setDiagLoading] = useState(false);

  // Staff user management
  const loadStaff = () => {
    const creds = load('credentials', {});
    return Object.entries(creds).filter(([k]) => k !== 'admin').map(([k, v]) => ({
      username: k, displayName: v.displayName || k, permissions: v.permissions || DEFAULT_USER_PERMS
    }));
  };
  const [staff, setStaff] = useState(loadStaff);
  const [showAdd, setShowAdd] = useState(false);
  const [newUname, setNewUname] = useState('');
  const [newDisplay, setNewDisplay] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [newPwdC, setNewPwdC] = useState('');
  const [newPerms, setNewPerms] = useState([...DEFAULT_USER_PERMS]);
  const [addErr, setAddErr] = useState('');
  const [editPwdFor, setEditPwdFor] = useState(null);
  const [editPwd, setEditPwd] = useState('');
  const [editPwdC, setEditPwdC] = useState('');
  const [editPermsFor, setEditPermsFor] = useState(null);
  const [editPerms, setEditPerms] = useState([]);
  const [resetCode, setResetCode] = useState('');
  const [resetCodeC, setResetCodeC] = useState('');
  const [resetCodeMsg, setResetCodeMsg] = useState('');
  const [resetApiInput, setResetApiInput] = useState(() => loadAdminResetApiBase());
  const [resetApiState, setResetApiState] = useState({ kind:'idle', msg:'' });
  const [pendingDeleteUser, setPendingDeleteUser] = useState(null);
  const [pendingBackupFile, setPendingBackupFile] = useState(null);
  const [customCategories, setCustomCategories] = useState(() => load(CUSTOM_CATEGORIES_KEY, []));
  const [newCatInput, setNewCatInput] = useState('');
  const [logoFields, setLogoFields] = useState({ degrill:'', parathas:'', dera:'', transfer:'' });
  const [empRegistry, setEmpRegistry] = useState({});
  const [quickCreateName, setQuickCreateName] = useState(null);
  const [quickUname, setQuickUname] = useState('');
  const [quickPwd, setQuickPwd] = useState('');
  const [quickErr, setQuickErr] = useState('');
  const logoFileRefs = { degrill: useRef(), parathas: useRef(), dera: useRef(), transfer: useRef() };
  const BIZ_KEYS = ['degrill', 'parathas', 'dera', 'transfer'];
  const blankContact = () => BIZ_KEYS.reduce((acc,k) => ({...acc,[k]:{phone:'',address:'',email:''}}), {});
  const [contactFields, setContactFields] = useState(blankContact);
  const MAX_LOGO_BYTES = 500 * 1024;

  async function handleLogoFile(key, file) {
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      showToast(`Logo file too large (DMG-E040). Max 500 KB — got ${fmtBytes(file.size)}.`, 'error');
      reportError('DMG-E040', { phase: 'logo_upload', key, size: file.size });
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      const dataUrl = e.target.result;
      setLogoFields(f => ({ ...f, [key]: dataUrl }));
    };
    reader.readAsDataURL(file);
  }

  useEffect(() => {
    if (!open) return;
    setStaff(loadStaff());
    setResetApiInput(loadAdminResetApiBase());
    setResetApiState({ kind:'idle', msg:'' });
    setEmpRegistry(loadEmpRegistry());
    setQuickCreateName(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setLogoFields({
      degrill: logoOverrides.degrill || '',
      parathas: logoOverrides.parathas || '',
      dera: logoOverrides.dera || '',
      transfer: logoOverrides.transfer || '',
    });
    const bc = bizContact || {};
    setContactFields(BIZ_KEYS.reduce((acc, k) => ({
      ...acc,
      [k]: { phone: bc[k]?.phone || '', address: bc[k]?.address || '', email: bc[k]?.email || '' },
    }), {}));
  }, [open, logoOverrides, bizContact]);

  function commitLogoOverrides() {
    const next = normalizeLogoOverrides({
      degrill: logoFields.degrill,
      parathas: logoFields.parathas,
      dera: logoFields.dera,
      transfer: logoFields.transfer,
    });
    setLogoOverrides(next);
    save(LOGO_OVERRIDES_KEY, next);
    showToast('Logo URLs saved. Invoices and the header use them immediately.');
    logActivity('profile_update', 'Saved invoice logo URL overrides');
  }
  function clearLogoOverrides() {
    setLogoFields({ degrill:'', parathas:'', dera:'', transfer:'' });
    setLogoOverrides({});
    save(LOGO_OVERRIDES_KEY, {});
    showToast('Logo overrides cleared — default images from the site are used.');
    logActivity('profile_update', 'Cleared invoice logo URL overrides');
  }

  function commitContactOverrides() {
    const cleaned = BIZ_KEYS.reduce((acc, k) => ({
      ...acc,
      [k]: {
        phone:   (contactFields[k]?.phone   || '').trim(),
        address: (contactFields[k]?.address || '').trim(),
        email:   (contactFields[k]?.email   || '').trim(),
      },
    }), {});
    setBizContact(cleaned);
    save(BIZ_CONTACT_KEY, cleaned);
    showToast('Business contact info saved. Invoices updated immediately.');
    logActivity('profile_update', 'Saved business contact overrides');
  }
  function clearContactOverrides() {
    setContactFields(blankContact());
    setBizContact({});
    save(BIZ_CONTACT_KEY, {});
    showToast('Contact overrides cleared — built-in placeholders restored.');
    logActivity('profile_update', 'Cleared business contact overrides');
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDiagLoading(true);
    gatherDiagnosticsPayload(localFeatureWarning || '').then(p => {
      if (!cancelled) {
        setDiagPayload(p);
        setDiagLoading(false);
      }
    }).catch(() => { if (!cancelled) setDiagLoading(false); });
    return () => { cancelled = true; };
  }, [open, localFeatureWarning]);

  async function handleCopyDiagnostics() {
    const r = await copyDiagnosticsReport(localFeatureWarning || '');
    if (r.ok) showToast('Diagnostics copied. Paste into email or GitHub.', 'success');
    else showToast('Copy failed — use ⬇ Failure Log.', 'error');
  }

  const TAB_DESC = {
    checkio:  'Clock users in/out and run payroll summaries',
    shopping: 'Build and export shopping lists',
    items:    'Add new items to the database',
    pricer:   'Update supplier prices',
    catering: 'View and create catering invoices',
    dailyfin: 'Track daily income/expenses with tax summaries',
    archive:  'Browse and search past invoices',
    help:     'View role-based help and troubleshooting',
  };
  async function syncCredsBestEffort(action) {
    const creds = load('credentials', {});
    const result = await syncCredentialsToBackend(creds, resetApiInput);
    if (!result.ok) {
      logFailure({ area:'settings', action:`sync_credentials_${action}`, error:result.error });
      showToast('Saved locally. Central login sync is currently unavailable.', 'warning');
      return false;
    }
    return true;
  }

  async function addUser() {
    setAddErr('');
    const uname = newUname.trim().toLowerCase().replace(/\s+/g, '_');
    if (!uname) { setAddErr('Username is required.'); return; }
    if (!/^[a-z0-9_]+$/.test(uname)) { setAddErr('Use only letters, numbers, or underscores.'); return; }
    if (uname === 'admin') { setAddErr('"admin" is a reserved username.'); return; }
    const creds = load('credentials', {});
    if (creds[uname]) { setAddErr('That username is already taken.'); return; }
    if (newPwd.length < 6) { setAddErr('Password must be at least 6 characters.'); return; }
    if (newPwd !== newPwdC) { setAddErr('Passwords do not match.'); return; }
    if (newPerms.length === 0) { setAddErr('At least one tab must be enabled.'); return; }
    const hash = await hashPwd(newPwd, uname);
    const displayName = newDisplay.trim() || uname;
    creds[uname] = { password: hash, role: 'user', displayName, permissions: newPerms };
    save('credentials', creds);
    await syncCredsBestEffort('add_user');
    setStaff(s => [...s, { username: uname, displayName, permissions: newPerms }]);
    setNewUname(''); setNewDisplay(''); setNewPwd(''); setNewPwdC(''); setNewPerms([...DEFAULT_USER_PERMS]);
    setShowAdd(false);
    showToast(displayName + ' added!');
    logActivity('add_user', 'Created staff user: ' + uname);
  }

  function deleteUser(uname) {
    setPendingDeleteUser(uname);
  }
  function confirmDeleteUser() {
    const uname = pendingDeleteUser;
    if (!uname) return;
    const creds = load('credentials', {});
    delete creds[uname];
    save('credentials', creds);
    syncCredsBestEffort('delete_user');
    setStaff(s => s.filter(x => x.username !== uname));
    showToast('User removed.');
    logActivity('delete_user', 'Deleted staff user: ' + uname);
    setPendingDeleteUser(null);
  }

  async function saveUserPwd(uname) {
    if (editPwd.length < 6) { showToast('Password must be at least 6 characters.', 'error'); return; }
    if (editPwd !== editPwdC) { showToast('Passwords do not match.', 'error'); return; }
    const creds = load('credentials', {});
    if (!creds[uname]) return;
    creds[uname].password = await hashPwd(editPwd, uname);
    save('credentials', creds);
    await syncCredsBestEffort('reset_password');
    setEditPwdFor(null); setEditPwd(''); setEditPwdC('');
    showToast('Password updated for @' + uname);
    logActivity('reset_password', 'Reset password for: ' + uname);
  }

  function saveUserPerms(uname) {
    if (editPerms.length === 0) { showToast('At least one tab must be enabled.', 'error'); return; }
    const creds = load('credentials', {});
    if (!creds[uname]) return;
    creds[uname].permissions = editPerms;
    save('credentials', creds);
    syncCredsBestEffort('update_permissions');
    setStaff(s => s.map(x => x.username === uname ? { ...x, permissions: editPerms } : x));
    onPermsChange(editPerms, uname);
    setEditPermsFor(null);
    showToast('Permissions saved for @' + uname);
    logActivity('update_permissions', 'Updated permissions for: ' + uname);
  }

  async function testResetApi(urlToTest) {
    const chk = await probeResetApi(urlToTest);
    if (chk.ok) {
      setResetApiState({ kind:'ok', msg:`Connected: ${chk.base}` });
      return true;
    }
    logFailure({ area:'settings', action:'test_reset_api', error:chk.error || 'health check failed', extra:{ apiBase: urlToTest } });
    setResetApiState({ kind:'error', msg:chk.error || 'Health check failed' });
    return false;
  }
  async function saveResetApi() {
    const normalized = normalizeApiBase(resetApiInput);
    if (!normalized) {
      setResetApiState({ kind:'error', msg:'Enter a reset API URL first.' });
      return;
    }
    setResetApiState({ kind:'checking', msg:'Checking connection...' });
    const ok = await testResetApi(normalized);
    if (!ok) return;
    saveAdminResetApiBase(normalized);
    showToast('Reset API endpoint saved.');
  }
  async function autoDetectResetApi() {
    setResetApiState({ kind:'checking', msg:'Auto-detecting reset API...' });
    const resolved = await resolveResetApiBase(resetApiInput);
    if (!resolved.ok) {
      setResetApiState({ kind:'error', msg:'No healthy reset API found.' });
      return;
    }
    setResetApiInput(resolved.base);
    setResetApiState({ kind:'ok', msg:`Using: ${resolved.base}` });
    showToast('Reset API detected automatically.');
  }
  function resetResetApiDefault() {
    saveAdminResetApiBase(ADMIN_RESET_API_BASE);
    setResetApiInput(ADMIN_RESET_API_BASE);
    setResetApiState({ kind:'idle', msg:'Reverted to default local URL.' });
  }
  async function saveResetCode() {
    setResetCodeMsg('');
    if (!resetCode || resetCode.length < 6) { setResetCodeMsg('Reset Code must be at least 6 characters.'); return; }
    if (resetCode !== resetCodeC) { setResetCodeMsg('Reset Code values do not match.'); return; }
    const h = await hashPwd(resetCode);
    save(ADMIN_RESET_CODE_KEY, h);
    setResetCode('');
    setResetCodeC('');
    setResetCodeMsg('Reset Code saved.');
    showToast('Quick reset code updated.');
  }

  function startQuickCreate(name) {
    setQuickCreateName(name);
    setQuickUname(genUsername(name));
    setQuickPwd(genPassword(name));
    setQuickErr('');
  }

  async function confirmQuickCreate() {
    setQuickErr('');
    const uname = quickUname.trim().toLowerCase();
    if (!uname) { setQuickErr('Username is required.'); return; }
    if (!/^[a-z0-9_]+$/.test(uname)) { setQuickErr('Use only letters, numbers, or underscores.'); return; }
    if (uname === 'admin') { setQuickErr('"admin" is a reserved username.'); return; }
    const creds = load('credentials', {});
    if (creds[uname]) { setQuickErr('That username is already taken — edit it above.'); return; }
    if (quickPwd.length < 6) { setQuickErr('Password must be at least 6 characters.'); return; }
    const hash = await hashPwd(quickPwd, uname);
    const displayName = quickCreateName;
    creds[uname] = { password: hash, role: 'user', displayName, permissions: [...DEFAULT_USER_PERMS] };
    save('credentials', creds);
    await syncCredsBestEffort('quick_create_user');
    setStaff(s => [...s, { username: uname, displayName, permissions: [...DEFAULT_USER_PERMS] }]);
    const savedPwd = quickPwd;
    setQuickCreateName(null);
    setQuickErr('');
    setQuickUname('');
    setQuickPwd('');
    showToast(`${displayName} (@${uname}) created! Password: ${savedPwd}`);
    logActivity('add_user', 'Quick-created account for payroll employee: ' + uname);
  }

  function addCustomCategory() {
    const cat = newCatInput.trim();
    if (!cat) return;
    if (CATEGORIES.includes(cat) || customCategories.includes(cat)) {
      showToast(`"${cat}" already exists.`, 'warning'); return;
    }
    const next = [...customCategories, cat];
    setCustomCategories(next);
    save(CUSTOM_CATEGORIES_KEY, next);
    setNewCatInput('');
    logActivity('edit_item', `Added custom category: ${cat}`);
    showToast(`Category "${cat}" added.`);
  }
  function removeCustomCategory(cat) {
    const next = customCategories.filter(c => c !== cat);
    setCustomCategories(next);
    save(CUSTOM_CATEGORIES_KEY, next);
    logActivity('edit_item', `Removed custom category: ${cat}`);
    showToast(`Category "${cat}" removed.`);
  }

  async function doExport() {
    try {
      const zip = new JSZip();
      const payload = {
        items, shoppingList:shopping, purchaseInvoices:purchaseInv,
        cateringInvoices:cateringInv, transferInvoices:transferInv,
        payrollInvoices:(payrollInvoices||[]),
        dailyFinanceEntries:(dailyFinanceEntries||[]),
        customers, priceHistory:priceHist,
        suppliers:(suppliers||[]),
        inventoryAdjustments: load(INVENTORY_ADJUSTMENTS_KEY, []),
        credentials: load('credentials', {}),
        settings:{
          selectedBusiness: load('_lastBiz','degrill'), logoOverrides, bizContact,
          customCategories,
        },
        exportDate: new Date().toISOString(), version:'2.5'
      };
      Object.entries(payload).forEach(([k,v]) => zip.file(k+'.json', JSON.stringify(v,null,2)));
      zip.file('README.txt',
        'Catering Inventory Manager — Backup\nExported: ' + new Date().toLocaleString() + '\n\n' +
        'To restore: Open the app → Settings (⚙) → Import Backup → select this ZIP file.\n\n' +
        'NOTE: This backup includes hashed staff login credentials for seamless device migration.\n' +
        'Keep this file secure — do not share it publicly.'
      );
      const blob = await zip.generateAsync({ type:'blob', compression:'DEFLATE', compressionOptions:{level:6} });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'catering-backup-' + today() + '.zip';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
      logActivity('export_backup', 'Exported data backup');
      showToast('Backup exported! Save the ZIP file somewhere safe.');
    } catch (e) {
      reportError('DMG-E041', { phase: 'export_zip', message: String(e?.message || e) });
      logFailure({ area: 'settings', action: 'export_backup', error: e });
      showToast(`Export failed (DMG-E041): ${e.message}`, 'error');
    }
  }

  function doImport(file) {
    if (!file) return;
    setPendingBackupFile(file);
  }
  function runBackupImport() {
    const file = pendingBackupFile;
    if (!file) return;
    setPendingBackupFile(null);
    JSZip.loadAsync(file).then(async zip => {
      // Read backup format version (absent in v1.x ZIPs)
      const verFile = zip.file('version.json');
      const backupVersion = verFile ? JSON.parse(await verFile.async('string')) : '1.0';
      const isLegacy = parseFloat(backupVersion) < 2.1;

      const keys = ['items','shoppingList','purchaseInvoices','cateringInvoices',
                    'transferInvoices','payrollInvoices','dailyFinanceEntries',
                    'customers','priceHistory','suppliers','inventoryAdjustments','credentials','settings'];
      const entries = await Promise.all(keys.map(async k => {
        const f = zip.file(k+'.json');
        if (!f) return [k, null];
        return [k, JSON.parse(await f.async('string'))];
      }));

      entries.forEach(([k,v]) => {
        if (!v) return;
        if (k==='items')                { setItems(v);               save('items',v); }
        if (k==='shoppingList')         { setShopping(v);            save('shoppingList',v); }
        if (k==='purchaseInvoices')     { setPurchaseInv(v);         save('purchaseInvoices',v); }
        if (k==='cateringInvoices')     { setCateringInv(v);         save('cateringInvoices',v); }
        if (k==='transferInvoices')     { setTransferInv(v);         save('transferInvoices',v); }
        if (k==='payrollInvoices')      { setPayrollInvoices(v);     save('payrollInvoices',v); }
        if (k==='dailyFinanceEntries')  { setDailyFinanceEntries(v); save('_dailyFinanceEntries',v); }
        if (k==='customers')            { setCustomers(v);           save('customers',v); }
        if (k==='priceHistory')         { setPriceHist(v);           save('priceHistory',v); }
        if (k==='settings'&&v.selectedBusiness) { setBiz(v.selectedBusiness); save('_lastBiz',v.selectedBusiness); }
        if (k==='settings'&&v.logoOverrides!=null) {
          const next = normalizeLogoOverrides(v.logoOverrides);
          setLogoOverrides(next);
          save(LOGO_OVERRIDES_KEY, next);
        }
        if (k==='settings'&&v.bizContact!=null) {
          setBizContact(v.bizContact);
          save(BIZ_CONTACT_KEY, v.bizContact);
        }
        if (k==='settings'&&Array.isArray(v.customCategories)) {
          setCustomCategories(v.customCategories);
          save(CUSTOM_CATEGORIES_KEY, v.customCategories);
        }
        if (k==='suppliers')            { setSuppliers(v);           save('_suppliers',v); }
        if (k==='inventoryAdjustments') {
          save(INVENTORY_ADJUSTMENTS_KEY, v);
        }
        if (k==='credentials' && v && typeof v === 'object' && Object.keys(v).length > 0) {
          save('credentials', v);
        }
      });
      logActivity('restore_backup', `Restored data from backup (format v${backupVersion})`);
      showToast('Backup restored! All data has been loaded.');
      if (parseFloat(backupVersion) < 2.4) {
        const missing = [];
        if (!zip.file('transferInvoices.json'))       missing.push('Transfer Invoices');
        if (!zip.file('payrollInvoices.json'))        missing.push('Payroll Invoices');
        if (!zip.file('dailyFinanceEntries.json'))    missing.push('Daily Finance Entries');
        if (!zip.file('inventoryAdjustments.json'))   missing.push('Inventory Adjustments');
        if (!zip.file('suppliers.json'))              missing.push('Suppliers');
        if (missing.length) {
          showToast(
            `Older backup (v${backupVersion}): ${missing.join(', ')} were not in this ZIP and remain unchanged on your device.`,
            'warn'
          );
        }
      }
      onClose();
    }).catch(e => {
      reportError('DMG-E041', { phase: 'import_zip', message: String(e?.message || e) });
      logFailure({ area: 'settings', action: 'import_backup', error: e });
      showToast(`Import failed (DMG-E041): ${e.message}`, 'error');
    });
  }

  const totalInvoices = purchaseInv.length + cateringInv.length + (transferInv||[]).length + (payrollInvoices||[]).length;
  const unpaidBal = cateringInv.reduce((s,i)=>s+(i.balanceDue||0),0);

  return (
    <>
    <Modal open={open} onClose={onClose} title="⚙️ Settings & Backup" wide maxW={680}>
      {/* Data Summary */}
      <div style={{background:'var(--cream)',padding:14,borderRadius:8,marginBottom:20}}>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:10,fontSize:14}}>📊 Data Summary</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(110px,1fr))',gap:8}}>
          {[['Items',items.length],['Customers',customers.length],['Invoices',totalInvoices],['Outstanding',fmt$(unpaidBal)]].map(([l,v])=>(
            <div key={l} style={{background:'white',padding:'10px 8px',borderRadius:6,textAlign:'center',border:'1px solid #EED9B0'}}>
              <div style={{fontWeight:700,color:'var(--brown)',fontSize:18}}>{v}</div>
              <div style={{fontSize:11,color:'#999',marginTop:3}}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Invoice logos — optional HTTPS URLs or uploaded files override bundled JPGs */}
      <div style={{border:'1px solid #EED9B0',borderRadius:8,padding:14,marginBottom:20,background:'#fffdf8'}}>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:6,fontSize:14}}>🖼 Invoice logos (optional)</div>
        <p style={{fontSize:12,color:'#6b4b20',marginBottom:12,lineHeight:1.55}}>
          Leave blank to use the images shipped with the app (<code style={{fontSize:11}}>public/assets/logos/</code>).
          Paste a full <strong>https://…</strong> URL <em>or</em> upload an image file (max 500 KB).
          Saved on this device and included in backup ZIP.
        </p>
        <LogoField label="DeGrill logo" fieldKey="degrill" logoFields={logoFields} setLogoFields={setLogoFields} fileRef={logoFileRefs.degrill} onFile={handleLogoFile} />
        <LogoField label="Parathas &amp; Platters logo" fieldKey="parathas" logoFields={logoFields} setLogoFields={setLogoFields} fileRef={logoFileRefs.parathas} onFile={handleLogoFile} />
        <LogoField label="Dera Masala Grill logo" fieldKey="dera" logoFields={logoFields} setLogoFields={setLogoFields} fileRef={logoFileRefs.dera} onFile={handleLogoFile} />
        <LogoField label="Internal transfer logo" fieldKey="transfer" logoFields={logoFields} setLogoFields={setLogoFields} fileRef={logoFileRefs.transfer} onFile={handleLogoFile} />
        <div className="flex gap-2 flex-wrap" style={{marginTop:4,alignItems:'center'}}>
          <Btn className="btn-primary btn-sm" onClick={commitLogoOverrides}>Save logos</Btn>
          <Btn className="btn-outline btn-sm" onClick={clearLogoOverrides}>Clear overrides</Btn>
        </div>
        <div style={{display:'flex',gap:12,marginTop:14,flexWrap:'wrap',alignItems:'center'}}>
          <span style={{fontSize:12,color:'#888'}}>Preview:</span>
          {(['degrill','parathas','dera','transfer']).map((key)=>(
            <img key={key} alt={`${key} logo preview`} src={resolveAssetUrl(brandingMap[key]?.logo || '', documentBaseHref())}
              style={{width:40,height:40,objectFit:'cover',borderRadius:'50%',border:'1px solid #EED9B0',background:'#fff'}} />
          ))}
        </div>
      </div>

      {/* Business contact info */}
      <div style={{border:'1px solid #EED9B0',borderRadius:8,padding:14,marginBottom:20,background:'#fffdf8'}}>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:6,fontSize:14}}>📇 Business contact info</div>
        <p style={{fontSize:12,color:'#6b4b20',marginBottom:12,lineHeight:1.55}}>
          Override the phone, address and email shown on invoices for each business.
          Leave blank to use the built-in defaults.
        </p>
        {[
          {key:'degrill',  label:'DeGrill Inc'},
          {key:'parathas', label:'Parathas and Platters Inc'},
          {key:'dera',     label:'Dera Masala Grill Inc'},
          {key:'transfer', label:'Internal Transfer (Parathas brand)'},
        ].map(({key, label}) => (
          <div key={key} style={{marginBottom:14}}>
            <div style={{fontWeight:600,fontSize:13,color:'var(--brown)',marginBottom:6}}>{label}</div>
            <div className="grid-2 mb-2" style={{gap:8}}>
              <FI label="Phone" value={contactFields[key]?.phone||''} onChange={e=>setContactFields(f=>({...f,[key]:{...f[key],phone:e.target.value}}))} placeholder={BRANDING[key]?.phone||'(555) 000-0000'} />
              <FI label="Email" type="email" value={contactFields[key]?.email||''} onChange={e=>setContactFields(f=>({...f,[key]:{...f[key],email:e.target.value}}))} placeholder={BRANDING[key]?.email||'info@example.com'} />
            </div>
            <FI label="Address" value={contactFields[key]?.address||''} onChange={e=>setContactFields(f=>({...f,[key]:{...f[key],address:e.target.value}}))} placeholder={BRANDING[key]?.address||'Street, City, State ZIP'} />
          </div>
        ))}
        <div className="flex gap-2 flex-wrap" style={{marginTop:4}}>
          <Btn className="btn-primary btn-sm" onClick={commitContactOverrides}>Save contact info</Btn>
          <Btn className="btn-outline btn-sm" onClick={clearContactOverrides}>Clear overrides</Btn>
        </div>
      </div>

      {/* System health & warnings */}
      <div style={{border:'1.5px solid #f59e0b',borderRadius:8,padding:16,marginBottom:20,background:'linear-gradient(180deg,#fffbeb 0%,#fff7ed 100%)'}}>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8,fontSize:15}}>⚠️ System health &amp; warnings</div>
        <p style={{fontSize:13,color:'#78350f',lineHeight:1.65,marginBottom:10}}>
          The app records errors automatically (failed logins, backend checks, and unexpected crashes). Use the buttons below to share a <strong>full report</strong> with support so they can suggest a fix.
          This website cannot push code changes by itself — updates are published on GitHub; after that, users only need to <strong>reload the page</strong> (F5).
        </p>
        {diagLoading && <div style={{fontSize:13,color:'#92400e',marginBottom:8}}>Checking backend and storage…</div>}
        {!diagLoading && diagPayload && (
          <div style={{marginBottom:12}}>
            <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:8}}>
              {localFeatureWarning && (
                <span style={{background:'#fef3c7',border:'1px solid #fcd34d',color:'#92400e',padding:'6px 10px',borderRadius:20,fontSize:12.5}}>
                  Scanner / local tools: {localFeatureWarning}
                </span>
              )}
              {!diagPayload.healthResetApi?.ok && (
                <span style={{background:'#fee2e2',border:'1px solid #fca5a5',color:'#991b1b',padding:'6px 10px',borderRadius:20,fontSize:12.5}}>
                  Reset / login server not reachable ({diagPayload.healthResetApi?.error || 'unknown'})
                </span>
              )}
              {diagPayload.healthResetApi?.ok && (
                <span style={{background:'#dcfce7',border:'1px solid #86efac',color:'#166534',padding:'6px 10px',borderRadius:20,fontSize:12.5}}>
                  Reset API OK ({diagPayload.healthResetApi.base})
                </span>
              )}
              {!diagPayload.storageHint?.ok && (
                <span style={{background:diagPayload.storageHint?.level==='error'?'#fee2e2':'#fef3c7',border:'1px solid #fcd34d',color:'#92400e',padding:'6px 10px',borderRadius:20,fontSize:12.5}}>
                  {diagPayload.storageHint?.msg}
                </span>
              )}
              {diagPayload.storageHint?.ok && diagPayload.storageHint?.pct != null && (
                <span style={{background:'#e0f2fe',border:'1px solid #7dd3fc',color:'#0369a1',padding:'6px 10px',borderRadius:20,fontSize:12.5}}>
                  {diagPayload.storageHint.msg}
                </span>
              )}
            </div>
            {(diagPayload.failuresRecent || []).length > 0 && (
              <div style={{background:'white',border:'1px solid #EED9B0',borderRadius:6,padding:'10px 12px',maxHeight:140,overflowY:'auto',fontSize:12,color:'#444'}}>
                <div style={{fontWeight:600,color:'var(--brown)',marginBottom:6,fontSize:12.5}}>Recent logged issues (newest first)</div>
                {[...(diagPayload.failuresRecent || [])].reverse().slice(0, 6).map((f, fi) => (
                  <div key={f.id || `f-${fi}-${f.timestamp}`} style={{marginBottom:8,paddingBottom:8,borderBottom:'1px solid #f5ead5',lineHeight:1.45}}>
                    <span style={{color:'#888',fontSize:11}}>{f.timestamp?.slice(0, 19).replace('T', ' ')}</span>
                    {' · '}{f.area}/{f.action}
                    <div style={{color:'#991b1b',marginTop:2}}>{f.error}</div>
                  </div>
                ))}
              </div>
            )}
            {(diagPayload.failuresRecent || []).length === 0 && !localFeatureWarning && diagPayload.healthResetApi?.ok && diagPayload.storageHint?.ok && (
              <div style={{fontSize:13,color:'#166534'}}>No recent errors logged. If something still feels wrong, copy a report anyway.</div>
            )}
          </div>
        )}
        <div className="flex gap-2 flex-wrap" style={{marginBottom:10}}>
          <Btn className="btn-primary btn-sm" onClick={handleCopyDiagnostics}>📋 Copy diagnostics report</Btn>
          <Btn className="btn-outline btn-sm" onClick={()=>openSupportDiagnosticsEmail(localFeatureWarning || '')}>✉️ Email support ({SUPPORT_CONTACT_EMAIL})</Btn>
          <Btn className="btn-outline btn-sm" onClick={()=>openDiagnosticsGitHubIssue(localFeatureWarning || '')}>🐙 Open GitHub issue</Btn>
          <Btn className="btn-outline btn-sm" onClick={downloadFailureLog}>⬇ Raw failure log (.json)</Btn>
        </div>
        <div style={{fontSize:12,color:'#57534e',background:'#fff',border:'1px dashed #d6d3d1',borderRadius:6,padding:'10px 12px',lineHeight:1.55}}>
          <strong>After a fix is released:</strong> Close nothing permanently — just press <strong>F5</strong> (Refresh) or tap your browser&apos;s reload button.
          If the page looks unchanged, wait a minute and refresh again (school networks sometimes cache the old file).
          Major risky fixes are developed and merged carefully on GitHub; this menu cannot auto-install them.
        </div>
      </div>

      {/* Backup / Restore */}
      <div style={{border:'1.5px solid #EED9B0',borderRadius:8,padding:16,marginBottom:20}}>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:6,fontSize:15}}>💾 Backup &amp; Restore</div>
        <p style={{fontSize:13,color:'#666',marginBottom:14,lineHeight:1.6}}>
          Export a ZIP file of ALL your data — items, invoices, customers, price history.
          Import it any time to restore if browser data is cleared.
        </p>
        <div className="flex gap-2 flex-wrap">
          <Btn className="btn-primary" onClick={doExport}>⬇ Export Backup (.zip)</Btn>
          <Btn className="btn-outline" onClick={()=>importRef.current.click()}>⬆ Import Backup</Btn>
          <input ref={importRef} type="file" accept=".zip" style={{display:'none'}} onChange={e=>{doImport(e.target.files[0]);e.target.value='';}} />
        </div>
        <p style={{fontSize:11.5,color:'#aaa',marginTop:10}}>
          💡 Tip: Save backups to Google Drive, OneDrive, or email them to yourself for safekeeping.
        </p>
      </div>

      {/* Custom Categories */}
      <div style={{border:'1.5px solid #EED9B0',borderRadius:8,padding:16,marginBottom:20}}>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:6,fontSize:15}}>🏷️ Item Categories</div>
        <p style={{fontSize:13,color:'#666',marginBottom:12,lineHeight:1.5}}>
          Built-in categories cannot be removed. Add custom categories below — they appear in the Item Database.
        </p>
        <div style={{display:'flex',flexWrap:'wrap',gap:6,marginBottom:12}}>
          {CATEGORIES.map(c => (
            <span key={c} style={{background:'#F5F0E8',color:'#7B5E3A',padding:'3px 10px',borderRadius:12,fontSize:12}}>{c}</span>
          ))}
          {customCategories.map(c => (
            <span key={c} style={{background:'#DCFCE7',color:'#15803D',padding:'3px 10px',borderRadius:12,fontSize:12,display:'inline-flex',alignItems:'center',gap:4}}>
              {c}
              <button onClick={() => removeCustomCategory(c)} title="Remove" style={{background:'none',border:'none',cursor:'pointer',color:'#DC2626',fontWeight:700,padding:'0 2px',lineHeight:1}}>×</button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input className="input" placeholder="New category name…" value={newCatInput} onChange={e=>setNewCatInput(e.target.value)}
            onKeyDown={e=>{ if(e.key==='Enter') addCustomCategory(); }} style={{flex:1}} />
          <Btn className="btn-outline" onClick={addCustomCategory}>＋ Add</Btn>
        </div>
      </div>

      {/* Staff Users */}
      <div style={{border:'1.5px solid #EED9B0',borderRadius:8,padding:16,marginBottom:20}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
          <div style={{fontWeight:700,color:'var(--brown)',fontSize:15}}>👥 Staff Users</div>
          {!showAdd && <Btn className="btn-primary btn-sm" onClick={()=>{setShowAdd(true);setAddErr('');}}>＋ Add User</Btn>}
        </div>

        {showAdd && (
          <div style={{background:'#f9f6ef',border:'1.5px solid #DEB887',borderRadius:8,padding:14,marginBottom:14}}>
            <div style={{fontWeight:700,marginBottom:10,color:'var(--brown)'}}>✨ New Staff User</div>
            <div className="grid-2">
              <FI label="Username (used to log in)" value={newUname} onChange={e=>setNewUname(e.target.value)} placeholder="e.g. john" autoComplete="off" />
              <FI label="Display Name (shown in app)" value={newDisplay} onChange={e=>setNewDisplay(e.target.value)} placeholder="e.g. John Smith" />
              <FI label="Password" type="password" value={newPwd} onChange={e=>setNewPwd(e.target.value)} placeholder="Min 6 characters" autoComplete="new-password" />
              <FI label="Confirm Password" type="password" value={newPwdC} onChange={e=>setNewPwdC(e.target.value)} placeholder="Re-enter password" autoComplete="new-password" />
            </div>
            <div style={{marginBottom:6,fontWeight:600,fontSize:13,color:'var(--brown)'}}>Tab Access:</div>
            <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:12}}>
              {ALL_USER_TABS.map(t=>(
                <label key={t.id} title={TAB_DESC[t.id]} style={{display:'flex',alignItems:'center',gap:6,background:newPerms.includes(t.id)?'var(--cream)':'#f0f0f0',padding:'5px 10px',borderRadius:20,border:newPerms.includes(t.id)?'1.5px solid #DEB887':'1px solid #ddd',cursor:'pointer',fontSize:13,userSelect:'none'}}>
                  <input type="checkbox" checked={newPerms.includes(t.id)} onChange={e=>setNewPerms(p=>e.target.checked?[...p,t.id]:p.filter(id=>id!==t.id))} />
                  {t.label}
                </label>
              ))}
            </div>
            {addErr && <div style={{background:'#fee2e2',color:'#991b1b',padding:'7px 10px',borderRadius:5,marginBottom:10,fontSize:13}}>{addErr}</div>}
            <div className="flex gap-2">
              <Btn className="btn-primary btn-sm" onClick={addUser}>✓ Create User</Btn>
              <Btn className="btn-outline btn-sm" onClick={()=>{setShowAdd(false);setAddErr('');}}>Cancel</Btn>
            </div>
          </div>
        )}

        {staff.length === 0 && !showAdd && (
          <div style={{textAlign:'center',padding:'24px 16px',color:'#bbb',fontSize:13,border:'1px dashed #ddd',borderRadius:8}}>
            No staff users yet. Click <strong>＋ Add User</strong> to create the first one.
          </div>
        )}

        {staff.map(u => (
          <div key={u.username} style={{border:'1px solid #EED9B0',borderRadius:8,padding:'12px 14px',marginBottom:10,background:'white'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:8}}>
              <div>
                <div style={{fontWeight:700,fontSize:14}}>{u.displayName} <span style={{fontWeight:400,color:'#999',fontSize:12}}>@{u.username}</span></div>
                <div style={{fontSize:12,color:'#888',marginTop:3}}>
                  Access: {u.permissions.map(p=>ALL_USER_TABS.find(t=>t.id===p)?.label||p).join(' · ') || '(none)'}
                </div>
              </div>
              <div className="flex gap-2" style={{flexWrap:'wrap'}}>
                <Btn className="btn-outline btn-sm" onClick={()=>{setEditPermsFor(editPermsFor===u.username?null:u.username);setEditPerms([...u.permissions]);setEditPwdFor(null);}}>🔒 Permissions</Btn>
                <Btn className="btn-outline btn-sm" onClick={()=>{setEditPwdFor(editPwdFor===u.username?null:u.username);setEditPwd('');setEditPwdC('');setEditPermsFor(null);}}>🔑 Password</Btn>
                <Btn className="btn-sm" style={{background:'#fee2e2',color:'#991b1b',border:'1px solid #fca5a5'}} onClick={()=>deleteUser(u.username)}>🗑</Btn>
              </div>
            </div>

            {editPermsFor === u.username && (
              <div style={{marginTop:12,paddingTop:12,borderTop:'1px solid #EED9B0'}}>
                <div style={{fontWeight:600,fontSize:13,marginBottom:8,color:'var(--brown)'}}>Tab access for @{u.username}:</div>
                <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:10}}>
                  {ALL_USER_TABS.map(t=>(
                    <label key={t.id} title={TAB_DESC[t.id]} style={{display:'flex',alignItems:'center',gap:6,background:editPerms.includes(t.id)?'var(--cream)':'#f0f0f0',padding:'5px 10px',borderRadius:20,border:editPerms.includes(t.id)?'1.5px solid #DEB887':'1px solid #ddd',cursor:'pointer',fontSize:13,userSelect:'none'}}>
                      <input type="checkbox" checked={editPerms.includes(t.id)} onChange={e=>setEditPerms(p=>e.target.checked?[...p,t.id]:p.filter(id=>id!==t.id))} />
                      {t.label}
                    </label>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Btn className="btn-primary btn-sm" onClick={()=>saveUserPerms(u.username)}>💾 Save Access</Btn>
                  <Btn className="btn-outline btn-sm" onClick={()=>setEditPermsFor(null)}>Cancel</Btn>
                </div>
              </div>
            )}

            {editPwdFor === u.username && (
              <div style={{marginTop:12,paddingTop:12,borderTop:'1px solid #EED9B0'}}>
                <div style={{fontWeight:600,fontSize:13,marginBottom:8,color:'var(--brown)'}}>Set new password for @{u.username}:</div>
                <div className="grid-2">
                  <FI label="New Password" type="password" value={editPwd} onChange={e=>setEditPwd(e.target.value)} placeholder="Min 6 characters" autoComplete="new-password" />
                  <FI label="Confirm Password" type="password" value={editPwdC} onChange={e=>setEditPwdC(e.target.value)} placeholder="Re-enter" autoComplete="new-password" />
                </div>
                <div className="flex gap-2">
                  <Btn className="btn-primary btn-sm" onClick={()=>saveUserPwd(u.username)}>💾 Save Password</Btn>
                  <Btn className="btn-outline btn-sm" onClick={()=>setEditPwdFor(null)}>Cancel</Btn>
                </div>
              </div>
            )}
          </div>
        ))}
        {/* Quick-create from payroll employee registry */}
        {(() => {
          const regNames = Object.keys(empRegistry).sort();
          if (!regNames.length) return null;
          const existingNames = new Set(staff.map(s => s.displayName?.toLowerCase()));
          const existingUnames = new Set(staff.map(s => s.username));
          const unaccounted = regNames.filter(name =>
            !existingNames.has(name.toLowerCase()) && !existingUnames.has(genUsername(name))
          );
          if (!unaccounted.length) return null;
          return (
            <div style={{marginTop:14,padding:'12px 14px',background:'#EFF6FF',border:'1px solid #BFDBFE',borderRadius:8}}>
              <div style={{fontWeight:700,fontSize:13,color:'#1e40af',marginBottom:4}}>
                ⚡ Employees from Payroll Records
              </div>
              <p style={{fontSize:12,color:'#3b5fc0',marginBottom:10,lineHeight:1.5}}>
                These employees appear in payroll but don't have app accounts yet. Click to auto-generate simple login credentials.
              </p>
              {unaccounted.map(name => (
                <div key={name} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'8px 10px',background:'white',borderRadius:6,border:'1px solid #BFDBFE',marginBottom:6}}>
                  <div>
                    <span style={{fontWeight:600}}>{name}</span>
                    {empRegistry[name]?.payRate && (
                      <span style={{fontSize:12,color:'#777',marginLeft:8}}>{fmt$(empRegistry[name].payRate)}/hr</span>
                    )}
                  </div>
                  <Btn className="btn-outline btn-sm" onClick={() => startQuickCreate(name)}>⚡ Create Account</Btn>
                </div>
              ))}
              {quickCreateName && (
                <div style={{marginTop:10,padding:'12px 14px',background:'#F0FDF4',border:'1px solid #86EFAC',borderRadius:8}}>
                  <div style={{fontWeight:700,fontSize:13,color:'#166534',marginBottom:10}}>
                    Creating account for: <strong>{quickCreateName}</strong>
                  </div>
                  <div className="grid-2 mb-2">
                    <FI label="Username" value={quickUname} onChange={e=>setQuickUname(e.target.value)} autoComplete="off" />
                    <FI label="Temporary Password" value={quickPwd} onChange={e=>setQuickPwd(e.target.value)} autoComplete="off" />
                  </div>
                  <div style={{fontSize:12,color:'#15803D',background:'#DCFCE7',padding:'7px 10px',borderRadius:6,marginBottom:10}}>
                    📋 Note down this password to share with the employee — it won't be shown again.
                  </div>
                  {quickErr && <div style={{background:'#fee2e2',color:'#991b1b',padding:'7px 10px',borderRadius:5,marginBottom:8,fontSize:13}}>{quickErr}</div>}
                  <div className="flex gap-2">
                    <Btn className="btn-primary btn-sm" onClick={confirmQuickCreate}>✓ Create Account</Btn>
                    <Btn className="btn-outline btn-sm" onClick={()=>{setQuickCreateName(null);setQuickErr('');}}>Cancel</Btn>
                  </div>
                </div>
              )}
            </div>
          );
        })()}
        <div style={{fontSize:12,color:'#888',marginTop:4}}>💡 To view a user's activity, go to the <strong>Activity Log</strong> tab and filter by their username.</div>
      </div>

      {/* Admin Password */}
      <div style={{border:'1.5px solid #EED9B0',borderRadius:8,padding:16,marginBottom:20}}>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8,fontSize:15}}>🔑 Admin Credentials</div>
        <p style={{fontSize:13,color:'#555',lineHeight:1.7,marginBottom:8}}>
          Admin credentials are managed centrally and cannot be changed from inside the app.
        </p>
        <Btn className="btn-outline btn-sm" style={{marginBottom:10}} onClick={()=>requestAdminResetEmail('settings_admin_credentials')}>
          ✉️ Send Admin Password Reset Request
        </Btn>
        <div style={{fontSize:12.5,color:'#7a5c00',background:'#FFF8DC',border:'1px solid #DEB887',borderRadius:6,padding:'10px 12px'}}>
          To request admin credential changes, email <a href="mailto:fatimfarooq@yahoo.com" style={{color:'var(--brown)',fontWeight:700}}>fatimfarooq@yahoo.com</a>.
        </div>
        <div style={{marginTop:12,paddingTop:10,borderTop:'1px solid #EED9B0'}}>
          <div style={{fontWeight:600,fontSize:13,color:'#5a3010',marginBottom:4}}>Quick Reset Code (for login-screen reset)</div>
          {!load(ADMIN_RESET_CODE_KEY,'') && (
            <div style={{background:'#FEF3C7',border:'1px solid #F59E0B',borderRadius:6,padding:'7px 10px',marginBottom:8,fontSize:12.5,color:'#92400e'}}>
              ⚠️ <strong>No reset code set.</strong> Without this, the admin cannot recover access if locked out on a new device. Set one now and save it somewhere safe.
            </div>
          )}
          <div className="grid-2">
            <FI label="New Reset Code" type="password" value={resetCode} onChange={e=>{setResetCode(e.target.value);setResetCodeMsg('');}} placeholder="Min 6 characters" />
            <FI label="Confirm Reset Code" type="password" value={resetCodeC} onChange={e=>{setResetCodeC(e.target.value);setResetCodeMsg('');}} placeholder="Re-enter reset code" />
          </div>
          {resetCodeMsg && <div style={{fontSize:12.5,color:resetCodeMsg==='Reset Code saved.'?'#166534':'#991b1b',marginBottom:8}}>{resetCodeMsg}</div>}
          <Btn className="btn-primary btn-sm" onClick={saveResetCode}>💾 Save Reset Code</Btn>
        </div>
      </div>

      <div style={{border:'1.5px solid #EED9B0',borderRadius:8,padding:16,marginBottom:20}}>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8,fontSize:15}}>🛡️ Reset Service Endpoint</div>
        <p style={{fontSize:13,color:'#666',lineHeight:1.6,marginBottom:10}}>
          Keep this working for low-tech users. The app auto-checks health and falls back to known local endpoints.
        </p>
        <FI label="Reset API Base URL" value={resetApiInput} onChange={e=>{setResetApiInput(e.target.value); setResetApiState({kind:'idle',msg:''});}} placeholder="http://localhost:8787" />
        <div className="flex gap-2 flex-wrap" style={{marginBottom:8}}>
          <Btn className="btn-primary btn-sm" onClick={saveResetApi}>💾 Save Endpoint</Btn>
          <Btn className="btn-outline btn-sm" onClick={autoDetectResetApi}>🧪 Auto Detect</Btn>
          <Btn className="btn-outline btn-sm" onClick={()=>testResetApi(resetApiInput)}>🔍 Test Only</Btn>
          <Btn className="btn-outline btn-sm" onClick={resetResetApiDefault}>↺ Default</Btn>
        </div>
        {resetApiState.msg && (
          <div style={{
            fontSize:12.5,
            borderRadius:6,
            padding:'8px 10px',
            background: resetApiState.kind==='ok' ? '#dcfce7' : resetApiState.kind==='error' ? '#fee2e2' : '#E8F4FC',
            color: resetApiState.kind==='ok' ? '#166534' : resetApiState.kind==='error' ? '#991b1b' : '#1e4f72'
          }}>
            {resetApiState.msg}
          </div>
        )}
      </div>

      <div style={{marginTop:4,textAlign:'right'}}>
        <Btn className="btn-outline" onClick={onClose}>Close</Btn>
      </div>
    </Modal>
    <Confirm
      open={!!pendingDeleteUser}
      title="Remove staff user"
      message={`Remove "${pendingDeleteUser}" from this device? Their login will stop working here.`}
      detail="This cannot be undone on this device. Central sync will update other devices when the network is available."
      dangerCode="DMG-E012 (destructive local change)"
      confirmLabel="Remove user"
      confirmClass="btn-danger"
      onConfirm={confirmDeleteUser}
      onCancel={() => setPendingDeleteUser(null)}
    />
    <Confirm
      open={!!pendingBackupFile}
      title="Replace all data from backup?"
      message="This will overwrite items, shopping list, invoices, customers, price history, and staff credentials on this device with the contents of the ZIP file."
      detail={`File: ${pendingBackupFile?.name || 'backup.zip'}\n\nExport a fresh backup first if you are unsure. This cannot be undone.`}
      dangerCode="DMG-E040 / DMG-E012 — full local restore"
      confirmLabel="Replace all data"
      confirmClass="btn-danger"
      wide
      onConfirm={runBackupImport}
      onCancel={() => setPendingBackupFile(null)}
    />
    </>
  );
}

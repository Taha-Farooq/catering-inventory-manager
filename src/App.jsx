import React, { useState, useEffect, useMemo, useRef, useCallback, useId, lazy, Suspense } from 'react';
import QRCode from 'qrcode';
import { load, save, uid, today } from './utils/storage.js';
import { logActivity } from './utils/activity.js';
import { documentBaseHref, rewriteImgSrcsForPrint, printHtmlDocument, printInvoiceById } from './utils/print.js';
import { nextId, nextTransferId, normalizeTransferInvoice } from './utils/invoiceIds.js';
import { BrandMark } from './ui/BrandMark.jsx';
import { getBootCapabilityWarnings } from './browserCaps.js';
import { useOnlineStatus } from './useOnlineStatus.js';
import { OfflineBanner, BrowserCapsBanner, BackendUnavailableBanner } from './ReliabilityBanners.jsx';
import { reportError } from './errors.js';
import { showToast, toastApiFailure } from './toastContext.jsx';
import {
  classifyFetchException,
  classifyHttpStatus,
  mergeApiFailure,
  userMessageForCode,
} from './apiErrors.js';
import {
  probeLocalStorage,
  estimateStorageUsage,
  findCorruptStorageKeys,
  removeStorageKeys,
  setSaveFailNotifier,
  notifySaveFailure,
} from './storageHealth.js';
import {
  hashPwd,
  parseAdminResetParams,
  parseAttendanceParams,
  loadAdminResetApiBase,
  saveAdminResetApiBase,
  probeResetApi,
  resolveResetApiBase,
  getAuthStatus,
  loginViaBackend,
  syncCredentialsToBackend,
  authFromCurrentUser,
  scanApiCall,
  attendanceApiCall,
  requestAdminResetEmail,
  pushAuditEvent,
  logFailure,
  initGlobalFailureCapture,
  downloadFailureLog,
  gatherDiagnosticsPayload,
  copyDiagnosticsReport,
  openSupportDiagnosticsEmail,
  openDiagnosticsGitHubIssue,
  BRANDING,
  mergeBrandingWithOverrides,
  SUPPORT_CONTACT_EMAIL,
  DIAGNOSTICS_ISSUES_NEW_URL,
} from './authHelpers.js';
import SettingsModal from './ui/SettingsModal.jsx';
import LoginScreen from './ui/LoginScreen.jsx';
import QrScanGate from './ui/QrScanGate.jsx';
import AdminResetPortal from './ui/AdminResetPortal.jsx';
import HelpCenter from './HelpCenter.jsx';
import PayrollInvoices from './tabs/PayrollInvoices.jsx';
import ActivityLog from './tabs/ActivityLog.jsx';
import ScanDatabaseBeta from './tabs/ScanDatabaseBeta.jsx';
import CustomerManagement from './tabs/CustomerManagement.jsx';
import SupplierManagement from './tabs/SupplierManagement.jsx';
import DailyIncomeExpense from './tabs/DailyIncomeExpense.jsx';
import CheckInOutPage from './tabs/CheckInOutPage.jsx';
import MenuMarginsLab from './tabs/MenuMarginsLab.jsx';
import Dashboard from './tabs/Dashboard.jsx';
import ItemDatabase from './tabs/ItemDatabase.jsx';
import InventoryAdjustments from './tabs/InventoryAdjustments.jsx';
import ShoppingList from './tabs/ShoppingList.jsx';
import PurchaseInvoices from './tabs/PurchaseInvoices.jsx';
import CateringInvoices from './tabs/CateringInvoices.jsx';
import TransferInvoices from './tabs/TransferInvoices.jsx';
import InvoiceArchive from './tabs/InvoiceArchive.jsx';
import Analytics from './tabs/Analytics.jsx';
import PriceHistory from './tabs/PriceHistory.jsx';
import PriceUpdater from './tabs/PriceUpdater.jsx';
import Confirm from './ui/Confirm.jsx';
import Modal from './ui/Modal.jsx';
import {
  BUSINESSES,
  TABS_ADMIN,
  ALL_USER_TABS,
  DEFAULT_USER_PERMS,
  PROFILE_ICONS,
  CATEGORIES,
  CHART_COLORS,
  PAYMENT_TERMS,
  MENU_UNITS,
  INTERNAL_SELLER_NAME_KEYS,
  NAV_GROUPS_ADMIN,
  NAV_GROUPS_USER,
  ADMIN_RESET_QUERY_KEY,
  ADMIN_RESET_REQ_KEY,
  ADMIN_RESET_EMAIL,
  ADMIN_RESET_API_BASE,
  ADMIN_RESET_API_ENDPOINTS,
  ADMIN_RESET_API_BASE_KEY,
  CENTRAL_AUTH_CONFIG_PATH,
  ADMIN_RESET_CODE_KEY,
  FAILURE_LOG_KEY,
  LOGO_OVERRIDES_KEY,
  BIZ_CONTACT_KEY,
  SCAN_DOC_TYPES,
  ATT_QR_QUERY_KEY,
  STAFF_SESSION_TIMEOUT_KEY,
  DEFAULT_STAFF_SESSION_TIMEOUT,
  UI_MODE_SIMPLE,
  UI_MODE_POWER,
} from './constants.js';
import { getUiMode, setUiMode as persistUiMode, applyBodyClass } from './utils/uiMode.js';
import {
  fmt$,
  fmtBytes,
  fmtDate,
  safeQty,
  sellerKey,
  normalizeApiBase,
  parseUrlSafe,
  isLoopbackHost,
  trimText,
  migrateShoppingList,
  uniqSuggestions,
  safePrice,
  resolveAssetUrl,
  normalizeLogoOverrides,
} from './formatters.js';
import * as XLSX from 'xlsx';

const LazyDailyFinanceCharts = lazy(() => import('./charts/DailyFinanceCharts.jsx'));
const LazyAnalyticsCharts = lazy(() => import('./charts/AnalyticsCharts.jsx'));
const LazyPriceHistoryChart = lazy(() => import('./charts/PriceHistoryChart.jsx'));

function getInvoiceBranding(inv, brandingMap) {
  const b = brandingMap || mergeBrandingWithOverrides(load(LOGO_OVERRIDES_KEY, {}), load(BIZ_CONTACT_KEY, {}));
  if (inv?._type === 'transfer' || inv?.invoiceType === 'pp_transfer') return b.transfer;
  return b[inv?.business] || { mark: 'INV', name: 'Invoice', location: '' };
}
function SetupQuickActions({ itemsCount, onOpenSettings, onGoTransfer, onGoArchive, uiMode }) {
  const hasResetCode = !!load(ADMIN_RESET_CODE_KEY, '');
  const creds = load('credentials', {});
  const hasStarterData = !!creds?.admin && itemsCount > 0;
  const log = load('_activityLog', []);
  const hasBackup = log.some(e => e?.action === 'export_backup');
  const doneCount = [hasStarterData, hasResetCode, hasBackup].filter(Boolean).length;
  const allDone = doneCount === 3;
  if (allDone) return null;
  const simple = uiMode === UI_MODE_SIMPLE;

  // What's the next thing she should do? Just the first unchecked step.
  const nextStep = !hasStarterData
    ? { label: 'Import starter data', sub: 'Add admin login + items', cta: 'Open Settings → Backup', go: onOpenSettings }
    : !hasResetCode
    ? { label: 'Set a Quick Reset Code', sub: 'So you can recover if you forget your password', cta: 'Open Settings', go: onOpenSettings }
    : { label: 'Export your first backup', sub: 'Keeps your data safe', cta: 'Open Settings → Backup', go: onOpenSettings };

  return (
    <div className="card" style={{border:'1.5px solid #EED9B0',background:'#fffdf8'}}>
      <div className="flex-between mb-2" style={{flexWrap:'wrap',gap:8}}>
        <div style={{fontWeight:800,color:'var(--brown)',fontSize:16}}>✅ First-Time Setup Checklist</div>
        <span className="badge badge-user">{doneCount}/3 complete</span>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr',gap:6,fontSize:13,marginBottom:12}}>
        <div>{hasStarterData ? '✅' : '⬜'} Starter data imported (admin + items available)</div>
        <div>{hasResetCode ? '✅' : '⬜'} Quick Reset Code configured (Settings → Admin Credentials)</div>
        <div>{hasBackup ? '✅' : '⬜'} At least one backup exported</div>
      </div>
      {simple ? (
        // In simple mode: one obvious action — what to do next — and nothing else.
        <div style={{background:'#FFF8DC',border:'1px solid #E7CFA6',borderRadius:8,padding:'10px 12px'}}>
          <div style={{fontWeight:700,color:'var(--brown)',fontSize:14,marginBottom:2}}>Next: {nextStep.label}</div>
          <div style={{fontSize:12.5,color:'#7a5c20',marginBottom:8}}>{nextStep.sub}</div>
          <Btn className="btn-primary btn-sm" onClick={nextStep.go}>{nextStep.cta}</Btn>
        </div>
      ) : (
        // Power mode: keep the original 4-button toolkit.
        <>
          <div style={{fontWeight:700,color:'var(--brown)',fontSize:14,marginBottom:8}}>⚡ Quick Actions</div>
          <div className="flex gap-2 flex-wrap">
            <Btn className="btn-primary btn-sm" onClick={onOpenSettings}>⚙ Open Settings</Btn>
            <Btn className="btn-outline btn-sm" onClick={onGoTransfer}>🚚 Go to Transfer Invoices</Btn>
            <Btn className="btn-outline btn-sm" onClick={onGoArchive}>🗂 Open Archive</Btn>
            <Btn className="btn-outline btn-sm" onClick={downloadFailureLog}>⬇ Download Failure Log</Btn>
          </div>
        </>
      )}
    </div>
  );
}
function getProfile(username) {
  const profiles = load('_profiles', {});
  return profiles[username] || { displayName: username==='admin'?'Administrator':'Staff User', icon: username==='admin'?'👤':'👨‍🍳' };
}
function saveProfileData(username, data) {
  const profiles = load('_profiles', {});
  profiles[username] = { ...(profiles[username]||{}), ...data };
  save('_profiles', profiles);
}

function Toggle({ checked, onChange, label }) {
  return (
    <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',userSelect:'none',margin:0}}>
      <span className="toggle">
        <input type="checkbox" checked={checked} onChange={e=>onChange(e.target.checked)} />
        <span className="toggle-slider" />
      </span>
      <span style={{fontSize:13.5,color:'#5a3010'}}>{label}</span>
    </label>
  );
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
function FS({ label, children, ...props }) {
  return <div className="field">{label&&<label>{label}</label>}<select className="input" {...props}>{children}</select></div>;
}
function Btn({ className='', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

// PROFILE MODAL
function ProfileModal({ open, onClose, username, profile, onSave }) {
  const [icon, setIcon] = useState(profile ? profile.icon : '👤');
  const [displayName, setDisplayName] = useState(profile ? profile.displayName : '');

  useEffect(() => {
    if (open && profile) { setIcon(profile.icon); setDisplayName(profile.displayName); }
  }, [open]);

  function handleSave() {
    if (!displayName.trim()) { showToast('Please enter a display name.', 'error'); return; }
    onSave({ icon, displayName: displayName.trim() });
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="✏️ Edit Your Profile" maxW={480}>
      <FI label="Display Name" value={displayName} onChange={e=>setDisplayName(e.target.value)} maxLength={40} placeholder="Enter your name" />
      <div className="field">
        <label>Choose Your Icon</label>
        <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:8,marginTop:4}}>
          {PROFILE_ICONS.map(emoji=>(
            <button key={emoji} type="button" onClick={()=>setIcon(emoji)}
              style={{fontSize:26,padding:8,border:icon===emoji?'2.5px solid var(--brown)':'1.5px solid #ddd',
                background:icon===emoji?'var(--cream)':'white',borderRadius:8,cursor:'pointer',lineHeight:1,transition:'all .12s'}}>
              {emoji}
            </button>
          ))}
        </div>
      </div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:14,background:'var(--cream)',borderRadius:8,padding:'12px 16px',marginBottom:16,border:'1px solid var(--border)'}}>
        <span style={{fontSize:34}}>{icon}</span>
        <span style={{fontSize:16,color:'var(--brown)',fontWeight:700}}>{displayName||'Your Name'}</span>
      </div>
      <div className="flex gap-2" style={{justifyContent:'flex-end'}}>
        <Btn className="btn-outline" onClick={onClose}>Cancel</Btn>
        <Btn className="btn-primary" onClick={handleSave}>💾 Save Profile</Btn>
      </div>
    </Modal>
  );
}


// PRICE UPDATER
function App() {
  useEffect(() => { initGlobalFailureCapture(); }, []);
  const attendanceParams = useMemo(() => parseAttendanceParams(), []);

  const bootWarnings = useMemo(() => getBootCapabilityWarnings(), []);
  const online = useOnlineStatus();

  useEffect(() => {
    bootWarnings.forEach((w) => reportError(w.code, { phase: 'boot_caps', detail: w.message }));
  }, [bootWarnings]);

  const [currentUser, setCurrentUser] = useState(()=>load('_session',null));
  const [tab, setTab] = useState('items');
  const [biz, setBiz] = useState(()=>load('_lastBiz','degrill'));
  const [logoOverrides, setLogoOverrides] = useState(() => normalizeLogoOverrides(load(LOGO_OVERRIDES_KEY, {})));
  const [bizContact, setBizContact] = useState(() => load(BIZ_CONTACT_KEY, {}));
  const brandingMap = useMemo(() => mergeBrandingWithOverrides(logoOverrides, bizContact), [logoOverrides, bizContact]);
  const [showSettings, setShowSettings] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [navGroup, setNavGroup] = useState('ops');
  const [items, setItems] = useState(()=>load('items',[]));
  const [shopping, setShopping] = useState(()=>migrateShoppingList(load('shoppingList',[])));
  const [purchaseInv, setPurchaseInv] = useState(()=>load('purchaseInvoices',[]));
  const [transferInv, setTransferInv] = useState(()=>load('transferInvoices',[]));
  const [payrollInvoices, setPayrollInvoices] = useState(()=>load('payrollInvoices',[]));
  const [cateringInv, setCateringInv] = useState(()=>load('cateringInvoices',[]));
  const [customers, setCustomers] = useState(()=>load('customers',[]));
  const [suppliers, setSuppliers] = useState(()=>load('_suppliers',[]));
  const [purchasePreset, setPurchasePreset] = useState(null);
  const [dailyFinanceEntries, setDailyFinanceEntries] = useState(()=>load('_dailyFinanceEntries', []));
  const [priceHist, setPriceHist] = useState(()=>load('priceHistory',[]));
  const [userPerms, setUserPerms] = useState(()=>load('_userPermissions', DEFAULT_USER_PERMS));
  const [kioskLock, setKioskLock] = useState(()=>load('_kioskLock', false));
  // Staff QR gate: 'idle' | 'scan_required' | 'ready'
  // Lazy init: if a checkio-only session is restored from storage (tab reopen / remember-me),
  // force QR gate immediately so history/tab tricks can't bypass it.
  const [staffQrPhase, setStaffQrPhase] = useState(() => {
    const u = load('_session', null);
    if (!u || u.role === 'admin') return 'idle';
    const creds = load('credentials', {});
    const perms = u.permissions || creds[u.username]?.permissions || [];
    const isCheckioOnly = perms.length > 0 && perms.every(p => p === 'checkio');
    return isCheckioOnly ? 'scan_required' : 'idle';
  });
  const [staffAttToken, setStaffAttToken] = useState('');
  const [staffSessionTimer, setStaffSessionTimer] = useState(0);
  const staffTimerRef = useRef(null);
  const [localFeatureWarning, setLocalFeatureWarning] = useState('');
  const [storageEnvOk, setStorageEnvOk] = useState(true);
  const [storageQuotaWarn, setStorageQuotaWarn] = useState(null);
  const [storageCorruptKeys, setStorageCorruptKeys] = useState([]);
  const storageWarnRef = useRef({ quota: false });
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [confirmKiosk, setConfirmKiosk] = useState(false);
  const [confirmClearCorrupt, setConfirmClearCorrupt] = useState(false);
  const [uiMode, setUiMode] = useState(() => getUiMode());
  useEffect(() => { applyBodyClass(uiMode); }, [uiMode]);
  function toggleUiMode() {
    const next = uiMode === UI_MODE_SIMPLE ? UI_MODE_POWER : UI_MODE_SIMPLE;
    persistUiMode(next);
    setUiMode(next);
    showToast(next === UI_MODE_SIMPLE ? 'Switched to simple mode' : 'Switched to power mode — all controls visible', 'success');
  }
  const isSimple = uiMode === UI_MODE_SIMPLE;
  const [profile, setProfile] = useState(()=> {
    const u = load('_session', null);
    return u ? getProfile(u.username) : { displayName:'Staff User', icon:'👤' };
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const probe = probeLocalStorage();
      if (!probe.ok) {
        setStorageEnvOk(false);
        reportError('DMG-E010', { phase: 'probe', readable: probe.readable, writable: probe.writable });
      }
      const est = await estimateStorageUsage();
      if (cancelled) return;
      if (est.usageRatio != null && est.usageRatio > 0.9) {
        setStorageQuotaWarn({
          usageBytes: est.usageBytes,
          quotaBytes: est.quotaBytes,
          ratio: est.usageRatio,
        });
        if (!storageWarnRef.current.quota) {
          storageWarnRef.current.quota = true;
          reportError('DMG-E011', { phase: 'estimate', usageRatio: est.usageRatio, warn: 'near_quota' });
        }
      }
      const bad = findCorruptStorageKeys();
      if (bad.length) {
        setStorageCorruptKeys(bad);
        reportError('DMG-E012', { keys: bad });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setSaveFailNotifier((payload) => {
      if (payload?.code === 'DMG-E011') {
        setStorageQuotaWarn((prev) => prev || { usageBytes: null, quotaBytes: null, ratio: 1 });
        showToast('Storage full — export a backup soon.', 'warning');
      }
    });
    return () => setSaveFailNotifier(() => {});
  }, []);

  // Keep active tab valid when permissions change — MUST be before any conditional return
  useEffect(() => {
    if (!currentUser) return;
    const isAdmin = currentUser.role === 'admin';
    const available = (isAdmin && kioskLock) ? TABS_ADMIN.filter(t=>t.id==='checkio') : isAdmin ? TABS_ADMIN : ALL_USER_TABS.filter(t => userPerms.includes(t.id));
    if (!available.find(t => t.id === tab)) {
      setTab(available[0]?.id || 'shopping');
    }
  }, [userPerms, currentUser, kioskLock]);

  useEffect(() => {
    if (!currentUser || currentUser.role !== 'admin' || !kioskLock) return;
    setTab('checkio');
    const onPop = () => { setTab('checkio'); window.history.pushState(null, '', window.location.href); };
    window.history.pushState(null, '', window.location.href);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [currentUser, kioskLock]);

  // Block back/forward navigation for all non-admin users (prevents bypassing QR gate)
  useEffect(() => {
    if (!currentUser || currentUser.role === 'admin' || kioskLock) return;
    window.history.pushState(null, '', window.location.href);
    const onPop = () => window.history.pushState(null, '', window.location.href);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [currentUser, kioskLock]);

  // Log when QR gate is re-enforced on a restored session (tab reopen / remember-me)
  const restoredQrLog = useRef(false);
  useEffect(() => {
    if (restoredQrLog.current) return;
    if (currentUser && staffQrPhase === 'scan_required') {
      restoredQrLog.current = true;
      logActivity('qr_gate_restored', 'QR gate enforced on restored session (tab reopen or history)');
    }
  }, [currentUser, staffQrPhase]);

  useEffect(() => {
    if (!currentUser || currentUser.role !== 'admin') return;
    probeResetApi('http://localhost:8787').then(chk => {
      if (chk.ok) setLocalFeatureWarning('');
      else setLocalFeatureWarning('Local backend is not reachable on this device. Scanner folder automation and local kiosk attendance station features may not work here.');
    }).catch(() => {
      setLocalFeatureWarning('Local backend is not reachable on this device. Scanner folder automation and local kiosk attendance station features may not work here.');
    });
  }, [currentUser?.username]);

  // One-time in-place migration so older transfer invoice shapes keep working.
  useEffect(() => {
    const src = Array.isArray(transferInv) ? transferInv : [];
    const normalized = src.map(normalizeTransferInvoice);
    const changed = JSON.stringify(src) !== JSON.stringify(normalized);
    if (changed) {
      setTransferInv(normalized);
      save('transferInvoices', normalized);
    }
  }, []);

  useEffect(() => {
    const raw = load('shoppingList', []);
    const normalized = migrateShoppingList(raw);
    try {
      if (JSON.stringify(normalized) !== JSON.stringify(raw)) {
        setShopping(normalized);
        save('shoppingList', normalized);
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (!currentUser || currentUser.role !== 'admin') return;
    const creds = load('credentials', {});
    if (!creds || !Object.keys(creds).length) return;
    syncCredentialsToBackend(creds, loadAdminResetApiBase(), authFromCurrentUser(currentUser)).then(result => {
      if (!result.ok) {
        logFailure({ area:'app', action:'admin_login_sync_credentials', error:result.error });
      }
    });
  }, [currentUser]);

  function handleLogin(user) {
    setCurrentUser(user);
    save('_session', user);
    const p = getProfile(user.username);
    setProfile(p);
    const creds = load('credentials', {});
    const perms = user.permissions || creds[user.username]?.permissions || DEFAULT_USER_PERMS;
    setUserPerms(perms);
    const isAdmin = user.role === 'admin';
    // Staff with ONLY check-in/out access must scan the location QR before proceeding
    const isCheckioOnly = !isAdmin && perms.length > 0 && perms.every(p2 => p2 === 'checkio');
    const firstTab = isAdmin ? TABS_ADMIN[0].id : (ALL_USER_TABS.find(t => perms.includes(t.id))?.id || 'shopping');
    if (isCheckioOnly) {
      setTab('checkio');
      setStaffQrPhase('scan_required');
    } else if (attendanceParams && !isAdmin) {
      setTab('checkio');
    } else {
      setTab(firstTab);
    }
    logActivity('login', 'Signed in as ' + user.role);
  }

  function handleQrPassed(token) {
    const timeout = Math.max(30, load(STAFF_SESSION_TIMEOUT_KEY, DEFAULT_STAFF_SESSION_TIMEOUT));
    setStaffAttToken(token);
    setStaffQrPhase('ready');
    setStaffSessionTimer(timeout);
    logActivity('qr_scan_pass', 'Staff QR verified — session started (' + timeout + 's)');
    if (staffTimerRef.current) clearTimeout(staffTimerRef.current);
    const tick = () => {
      setStaffSessionTimer(prev => {
        if (prev <= 1) { doStaffAutoLogout('Session timer expired'); return 0; }
        staffTimerRef.current = setTimeout(tick, 1000);
        return prev - 1;
      });
    };
    staffTimerRef.current = setTimeout(tick, 1000);
  }

  function doStaffAutoLogout(reason) {
    if (staffTimerRef.current) { clearTimeout(staffTimerRef.current); staffTimerRef.current = null; }
    logActivity('logout', reason || 'Staff auto-logout');
    setCurrentUser(null);
    save('_session', null);
    setStaffQrPhase('idle');
    setStaffAttToken('');
    setStaffSessionTimer(0);
  }

  function handleAttendanceComplete() {
    // Called after staff successfully checks in or out — brief success then logout
    if (staffTimerRef.current) { clearTimeout(staffTimerRef.current); staffTimerRef.current = null; }
    setStaffSessionTimer(0);
    setTimeout(() => doStaffAutoLogout('Check-in/out completed'), 2200);
  }

  function handleLogout() {
    setConfirmLogout(true);
  }
  function confirmDoLogout() {
    setConfirmLogout(false);
    if (staffTimerRef.current) { clearTimeout(staffTimerRef.current); staffTimerRef.current = null; }
    logActivity('logout', 'Signed out');
    setCurrentUser(null);
    save('_session', null);
    setStaffQrPhase('idle');
    setStaffAttToken('');
    setStaffSessionTimer(0);
    if (kioskLock) { setKioskLock(false); save('_kioskLock', false); }
  }

  function handleBizChange(k) { setBiz(k); save('_lastBiz', k); }

  function handleTabChange(id) {
    if (kioskLock && currentUser?.role === 'admin' && id !== 'checkio') return;
    setTab(id);
    logActivity('tab_change', 'Navigated to ' + id);
  }
  function goToTab(id) {
    const owner = navGroups.find(g => g.tabs.includes(id));
    if (owner) setNavGroup(owner.id);
    handleTabChange(id);
  }

  function handleProfileSave(data) {
    saveProfileData(currentUser.username, data);
    setProfile(data);
    showToast('Profile updated!');
  }
  function handleScannerAuthHash(authHash) {
    if (!currentUser) return;
    const next = { ...currentUser, authHash };
    setCurrentUser(next);
    save('_session', next);
  }
  function enterKioskMode() {
    if (currentUser?.role !== 'admin') return;
    setConfirmKiosk(true);
  }
  function confirmDoKiosk() {
    setConfirmKiosk(false);
    setKioskLock(true);
    save('_kioskLock', true);
    setTab('checkio');
  }
  if (!currentUser) return <LoginScreen onLogin={handleLogin} bootWarnings={bootWarnings} online={online} />;

  // QR scan gate: shown for checkio-only staff immediately after login
  if (staffQrPhase === 'scan_required') {
    return (
      <QrScanGate
        onPassed={handleQrPassed}
        onFailed={() => doStaffAutoLogout('QR scan failed — 3 attempts')}
        attendanceApiCallFn={attendanceApiCall}
        currentUser={currentUser}
      />
    );
  }

  const isAdmin = currentUser.role === 'admin';
  // Simple mode hides power-user tabs (Inv. Log, Price History, Activity
  // Log) from the nav to cut clutter; the tabs still exist and power mode
  // restores them. If the active tab gets hidden, the effect below bounces
  // to Dashboard.
  const TABS = ((isAdmin && kioskLock) ? TABS_ADMIN.filter(t=>t.id==='checkio') : isAdmin ? TABS_ADMIN : ALL_USER_TABS.filter(t => userPerms.includes(t.id)))
    .filter(t => !(isSimple && t.powerOnly));
  useEffect(() => {
    if (isAdmin && isSimple && TABS_ADMIN.find(t => t.id === tab)?.powerOnly) setTab('dashboard');
  }, [isSimple, tab, isAdmin]);
  const navGroups = useMemo(() => {
    const allowed = new Set(TABS.map(t => t.id));
    const src = (isAdmin && kioskLock)
      ? [{ id:'work', label:'Work', tabs:['checkio'] }]
      : (isAdmin ? NAV_GROUPS_ADMIN : NAV_GROUPS_USER);
    const groups = src
      .map(g => ({ ...g, tabs: g.tabs.filter(id => allowed.has(id)) }))
      .filter(g => g.tabs.length > 0);
    return groups.length ? groups : [{ id:'all', label:'All', tabs:[...allowed] }];
  }, [isAdmin, kioskLock, TABS, userPerms]);
  const visibleTabIds = useMemo(() => {
    const g = navGroups.find(x => x.id === navGroup) || navGroups[0];
    return g ? g.tabs : TABS.map(t=>t.id);
  }, [navGroups, navGroup, TABS]);
  const visibleTabs = TABS.filter(t => visibleTabIds.includes(t.id));

  useEffect(() => {
    if (!navGroups.find(g => g.id === navGroup)) setNavGroup(navGroups[0]?.id || 'ops');
  }, [navGroups, navGroup]);
  useEffect(() => {
    if (!visibleTabIds.includes(tab)) {
      const g = navGroups.find(gx => gx.tabs.includes(tab));
      if (g) setNavGroup(g.id);
    }
  }, [tab, visibleTabIds, navGroups]);
  const bizInfo = BUSINESSES[biz];

  const appState = {
    items, shopping, purchaseInv, cateringInv, transferInv, payrollInvoices,
    dailyFinanceEntries, customers, priceHist, suppliers,
    setItems, setShopping, setPurchaseInv, setCateringInv, setTransferInv,
    setPayrollInvoices, setDailyFinanceEntries, setCustomers, setPriceHist, setBiz,
    setSuppliers,
    logoOverrides, setLogoOverrides,
    bizContact, setBizContact,
  };

  function handleClearCorruptKeys() {
    const keys = [...storageCorruptKeys];
    if (!keys.length) return;
    setConfirmClearCorrupt(true);
  }
  function confirmDoClearCorruptKeys() {
    const keys = [...storageCorruptKeys];
    if (!keys.length) { setConfirmClearCorrupt(false); return; }
    setConfirmClearCorrupt(false);
    removeStorageKeys(keys);
    reportError('DMG-E012', { phase: 'cleared_keys', cleared: keys });
    setStorageCorruptKeys([]);
    showToast('Removed unreadable keys. Reloading…', 'warning');
    window.setTimeout(() => window.location.reload(), 400);
  }

  function handleRepairStorageKey(key, jsonText) {
    if (!key || !jsonText) return false;
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return false;
    }
    if (!save(key, parsed)) {
      showToast('Could not write storage. Check space or permissions (DMG-E010/E011).', 'error');
      return false;
    }
    reportError('DMG-E012', { phase: 'repaired_key', key });
    setStorageCorruptKeys(findCorruptStorageKeys());
    const stillBad = findCorruptStorageKeys();
    if (!stillBad.includes(key)) {
      showToast(`Repaired storage key: ${key}`, 'success');
    } else {
      showToast('Key written but still unreadable — double-check JSON.', 'warning');
    }
    return true;
  }

  return (
    <div id="app-shell">
      <div className="app-header no-print">
        <div className="header-row">
          <div>
            <div className="header-title">
              <img className="header-title-logo" src={resolveAssetUrl(brandingMap[biz]?.logo || brandingMap.degrill.logo, documentBaseHref())} alt={`${bizInfo.name} logo`} />
              <h1 style={{margin:0}}>DMG Software Suite</h1>
            </div>
            <div className="sub">{bizInfo.name} · {bizInfo.location} · Tax: {(bizInfo.taxRate*100).toFixed(3)}%</div>
          </div>
          <div className="header-actions">
            {isAdmin && !kioskLock &&(
              <select style={{padding:'6px 10px',borderRadius:5,border:'none',background:'rgba(255,255,255,0.92)',color:'var(--brown)',fontWeight:700,fontSize:13,cursor:'pointer'}}
                value={biz} onChange={e=>handleBizChange(e.target.value)}>
                {Object.entries(BUSINESSES).map(([k,v])=><option key={k} value={k}>{v.name}</option>)}
              </select>
            )}
            {isAdmin && !kioskLock && (
              <Btn className="btn-ghost btn-sm" onClick={toggleUiMode}
                title={isSimple ? 'Simple mode hides advanced controls. Click to show everything.' : 'Power mode shows every control. Click for the calmer view.'}>
                {isSimple ? '✨ Simple' : '🔧 Power'}
              </Btn>
            )}
            {isAdmin && !kioskLock && <Btn className="btn-ghost btn-sm" onClick={()=>setShowSettings(true)}>⚙ Settings</Btn>}
            <div
              title="Click to edit your profile"
              onClick={()=>setShowProfile(true)}
              style={{display:'flex',alignItems:'center',gap:6,background:'rgba(255,255,255,0.12)',padding:'5px 10px',borderRadius:5,cursor:'pointer',transition:'background .15s'}}
              onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.22)'}
              onMouseLeave={e=>e.currentTarget.style.background='rgba(255,255,255,0.12)'}
            >
              <span style={{fontSize:20}}>{profile.icon}</span>
              <span style={{fontSize:13,color:'rgba(255,255,255,0.92)',fontWeight:600}}>{profile.displayName}</span>
              <span style={{fontSize:11,opacity:.65}}>✏️</span>
              <span className={`badge badge-${currentUser.role}`} style={{fontSize:11}}>{currentUser.role}</span>
              <Btn className="btn-ghost btn-sm" onClick={e=>{e.stopPropagation();handleLogout();}} style={{padding:'3px 8px',marginLeft:4}}>Sign Out</Btn>
            </div>
          </div>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="group-bar no-print">
        {navGroups.map(g => (
          <button
            key={g.id}
            className={`group-btn${navGroup===g.id?' active':''}`}
            onClick={()=>{
              setNavGroup(g.id);
              if (!g.tabs.includes(tab) && g.tabs[0]) handleTabChange(g.tabs[0]);
            }}
          >
            {g.label}
          </button>
        ))}
      </div>
      <div className="tab-bar no-print">
        {visibleTabs.map(t=>(
          <button key={t.id} className={`tab-btn${tab===t.id?' active':''}`} onClick={()=>handleTabChange(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div className="content-area">
        <div className="hint-card no-print">
          {isAdmin ? 'Use top groups to find tools faster. Start with Stock or Invoices for daily work.' : 'Use top groups to find what you need quickly. Start with Work or Stock.'}
        </div>
        <OfflineBanner online={online} />
        <BrowserCapsBanner warnings={bootWarnings} />
        {!storageEnvOk && (
          <div style={{background:'#fff7ed',border:'1px solid #fdba74',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:13,color:'#9a3412'}}>
            {isSimple
              ? <>This browser isn’t saving your data right now. Turn off strict private browsing or allow this site to save data, then refresh the page.</>
              : <><strong>DMG-E010:</strong> Browser storage is not available or blocked. The app cannot save changes reliably. Allow site data / exit strict private browsing, then refresh.</>
            }
          </div>
        )}
        {storageQuotaWarn && (
          <div style={{background:'#fffbeb',border:'1px solid #fcd34d',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:13,color:'#92400e'}}>
            {isSimple
              ? <>You’re running low on browser storage{storageQuotaWarn.usageBytes != null && storageQuotaWarn.quotaBytes != null ? <> ({fmtBytes(storageQuotaWarn.usageBytes)} of {fmtBytes(storageQuotaWarn.quotaBytes)} used)</> : null}. Open <strong>Settings → Backup</strong> to save your data, then clear out old invoices.</>
              : <><strong>DMG-E011:</strong> Device storage for this site is nearly full{storageQuotaWarn.usageBytes != null && storageQuotaWarn.quotaBytes != null ? <> ({fmtBytes(storageQuotaWarn.usageBytes)} / {fmtBytes(storageQuotaWarn.quotaBytes)})</> : null}. Export a backup from Settings, then remove old invoices or clear other sites’ data.</>
            }
          </div>
        )}
        {!!storageCorruptKeys.length && (
          <div style={{background:'#fefce8',border:'1px solid #fde047',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:13,color:'#713f12'}}>
            {isSimple
              ? <>Some saved data couldn’t be read. Export a backup first if you can, then click the button below to remove the unreadable entries — the rest of your data stays safe.</>
              : <><strong>DMG-E012:</strong> Some saved data could not be read (keys: {storageCorruptKeys.join(', ')}). Export a backup if possible, then remove the bad keys.</>
            }
            {' '}
            <button type="button" className="btn btn-outline btn-sm" style={{marginLeft:8}} onClick={handleClearCorruptKeys}>Remove unreadable keys</button>
          </div>
        )}
        {isAdmin && localFeatureWarning && (
          <div style={{background:'#fff7ed',border:'1px solid #fdba74',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:12.5,color:'#9a3412'}}>
            Note: {localFeatureWarning}
          </div>
        )}
        {isAdmin && !kioskLock && (
          <div className="mb-3">
            <SetupQuickActions
              itemsCount={items.length}
              onOpenSettings={()=>setShowSettings(true)}
              onGoTransfer={()=>goToTab('transfer')}
              onGoArchive={()=>goToTab('archive')}
              uiMode={uiMode}
            />
          </div>
        )}
        {tab==='dashboard' && isAdmin && <Dashboard items={items} purchaseInvoices={purchaseInv} cateringInvoices={cateringInv} payrollInvoices={payrollInvoices} setTab={setTab} shoppingList={shopping} setShoppingList={setShopping} onOpenSettings={()=>setShowSettings(true)} />}
        {tab==='items'     && <ItemDatabase     items={items} setItems={setItems} priceHistory={priceHist} setPriceHistory={setPriceHist} userRole={currentUser.role} purchaseInvoices={purchaseInv} />}
        {tab==='invadj'    && isAdmin && <InventoryAdjustments items={items} setItems={setItems} />}
        {tab==='shopping'  && <ShoppingList     items={items} shoppingList={shopping} setShoppingList={setShopping} purchaseInvoices={purchaseInv} setPurchaseInvoices={setPurchaseInv} selectedBusiness={biz} />}
        {tab==='checkio'   && <CheckInOutPage currentUser={currentUser} attendanceToken={staffAttToken || attendanceParams?.token || ''} onEnterKiosk={enterKioskMode} kioskLock={kioskLock} selectedBusiness={biz} payrollInvoices={payrollInvoices} setPayrollInvoices={setPayrollInvoices} isOnline={online} attendanceApiCall={attendanceApiCall} sessionTimeLeft={staffSessionTimer} onAttendanceComplete={handleAttendanceComplete} brandingMap={brandingMap} />}
        {tab==='pricer'    && <PriceUpdater     items={items} setItems={setItems} priceHistory={priceHist} setPriceHistory={setPriceHist} />}
        {tab==='purchase'  && isAdmin && <PurchaseInvoices purchaseInvoices={purchaseInv} setPurchaseInvoices={setPurchaseInv} selectedBusiness={biz} items={items} setItems={setItems} brandingMap={brandingMap} getInvoiceBranding={getInvoiceBranding} suppliers={suppliers} initialSupplier={purchasePreset} onConsumeInitialSupplier={()=>setPurchasePreset(null)} />}
        {tab==='transfer'  && isAdmin && <TransferInvoices transferInvoices={transferInv} setTransferInvoices={setTransferInv} items={items} brandingMap={brandingMap} getInvoiceBranding={getInvoiceBranding} />}
        {tab==='catering'  && isAdmin && <CateringInvoices cateringInvoices={cateringInv} setCateringInvoices={setCateringInv} customers={customers} setCustomers={setCustomers} selectedBusiness={biz} userRole={currentUser.role} items={items} brandingMap={brandingMap} getInvoiceBranding={getInvoiceBranding} />}
        {tab==='customers' && isAdmin && <CustomerManagement customers={customers} setCustomers={setCustomers} cateringInvoices={cateringInv} save={save} brandingMap={brandingMap} selectedBusiness={biz} />}
        {tab==='suppliers' && isAdmin && <SupplierManagement suppliers={suppliers} setSuppliers={setSuppliers} items={items} purchaseInvoices={purchaseInv} onCreateInvoice={name=>{setPurchasePreset(name);setTab('purchase');}} />}
        {tab==='analytics' && isAdmin && <Analytics cateringInvoices={cateringInv} purchaseInvoices={purchaseInv} dailyFinanceEntries={dailyFinanceEntries} payrollInvoices={payrollInvoices} brandingMap={brandingMap} />}
        {tab==='dailyfin'  && <DailyIncomeExpense entries={dailyFinanceEntries} setEntries={setDailyFinanceEntries} selectedBusiness={biz} save={save} brandingMap={brandingMap} />}
        {tab==='payroll'   && isAdmin && <PayrollInvoices payrollInvoices={payrollInvoices} setPayrollInvoices={setPayrollInvoices} selectedBusiness={biz} brandingMap={brandingMap} />}
        {tab==='archive'   && isAdmin && <InvoiceArchive purchaseInvoices={purchaseInv} setPurchaseInvoices={setPurchaseInv} cateringInvoices={cateringInv} setCateringInvoices={setCateringInv} transferInvoices={transferInv} setTransferInvoices={setTransferInv} payrollInvoices={payrollInvoices} setPayrollInvoices={setPayrollInvoices} userRole={currentUser.role} brandingMap={brandingMap} selectedBusiness={biz} getInvoiceBranding={getInvoiceBranding} />}
        {tab==='history'   && isAdmin && <PriceHistory items={items} priceHistory={priceHist} setPriceHistory={setPriceHist} />}
        {tab==='margins'   && isAdmin && <MenuMarginsLab items={items} priceHistory={priceHist} selectedBusiness={biz} />}
        {tab==='actlog'    && isAdmin && <ActivityLog save={save} />}
        {tab==='scanbeta'  && isAdmin && <ScanDatabaseBeta currentUser={currentUser} onAuthHashSaved={handleScannerAuthHash} isOnline={online} scanApiCall={scanApiCall} hashPwd={hashPwd} />}
        {tab==='help'      && <HelpCenter currentUser={currentUser} corruptKeys={storageCorruptKeys} onRepairStorageKey={handleRepairStorageKey} />}
      </div>

      {/* ── Modals ── */}
      <SettingsModal open={showSettings} onClose={()=>setShowSettings(false)} appState={appState} currentUser={currentUser} localFeatureWarning={localFeatureWarning} brandingMap={brandingMap} uiMode={uiMode} onPermsChange={(perms, uname)=>{ if(uname===currentUser.username) setUserPerms(perms); }} />
      <ProfileModal open={showProfile} onClose={()=>setShowProfile(false)} username={currentUser.username} profile={profile} onSave={handleProfileSave} />

      <Confirm
        open={confirmLogout}
        title="Sign out?"
        message="You will need to sign in again to use the app on this device."
        confirmLabel="Sign out"
        confirmClass="btn-danger"
        onConfirm={confirmDoLogout}
        onCancel={() => setConfirmLogout(false)}
      />
      <Confirm
        open={confirmKiosk}
        title="Enter Check-In Kiosk mode?"
        message="The screen will lock to Check In/Out only until you sign out and sign back in as admin."
        detail="Use this on a shared device at the counter. Keep the admin password private."
        dangerCode="DMG-E022 (session scope change)"
        confirmLabel="Enter kiosk mode"
        confirmClass="btn-danger"
        onConfirm={confirmDoKiosk}
        onCancel={() => setConfirmKiosk(false)}
      />
      <Confirm
        open={confirmClearCorrupt}
        title="Remove unreadable storage keys?"
        message={`Remove ${storageCorruptKeys.length} key(s) that could not be read as JSON?`}
        detail={`Keys: ${storageCorruptKeys.join(', ')}\n\nExport a backup from Settings first if unsure. The page will reload after removal.`}
        dangerCode="DMG-E012"
        confirmLabel="Remove keys"
        confirmClass="btn-danger"
        wide
        onConfirm={confirmDoClearCorruptKeys}
        onCancel={() => setConfirmClearCorrupt(false)}
      />
    </div>
  );
}

export default App;
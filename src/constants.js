/**
 * Shared app constants (businesses, tabs, nav, auth endpoints).
 * Import from here instead of duplicating in App.jsx.
 */

export const BUSINESSES = {
  degrill: { name: 'DeGrill Inc', location: 'Spring Valley, NY', taxRate: 0.08375 },
  parathas: { name: 'Parathas and Platters Inc', location: 'Hackensack, NJ', taxRate: 0.06625 },
  dera: { name: 'Dera Masala Grill Inc', location: 'Clifton, NJ', taxRate: 0.06625 },
};

export const INVENTORY_ADJUSTMENTS_KEY = '_inventoryAdjustments';

export const TABS_ADMIN = [
  { id: 'dashboard', label: '🏠 Dashboard' },
  { id: 'checkio', label: '✅ Check In/Out' },
  { id: 'items', label: '📦 Items' },
  { id: 'invadj', label: '📝 Inv. Log' },
  { id: 'shopping', label: '🛒 Shopping' },
  { id: 'pricer', label: '💰 Price Updater' },
  { id: 'purchase', label: '📋 Purchase Inv.' },
  { id: 'transfer', label: '🚚 Transfer Inv.' },
  { id: 'catering', label: '🍽️ Catering Inv.' },
  { id: 'payroll', label: '💼 Payroll Inv.' },
  { id: 'customers', label: '👥 Customers' },
  { id: 'suppliers', label: '🏪 Suppliers' },
  { id: 'analytics', label: '📊 Analytics' },
  { id: 'dailyfin', label: '🧾 Daily Income & Expense' },
  { id: 'archive', label: '🗂️ Archive' },
  { id: 'history', label: '📈 Price History' },
  { id: 'margins', label: '💹 Menu Margins' },
  { id: 'actlog', label: '🔍 Activity Log' },
  { id: 'scanbeta', label: '🧪 Scan DB (Beta)' },
  { id: 'help', label: '❓ Help' },
];

// Non-admin staff: no invoice or customer access — invoice data is admin-only
export const ALL_USER_TABS = [
  { id: 'checkio', label: '✅ Check In/Out' },
  { id: 'shopping', label: '🛒 Shopping List' },
  { id: 'items', label: '📦 Add Items' },
  { id: 'pricer', label: '💰 Price Updater' },
  { id: 'dailyfin', label: '🧾 Daily Finance' },
  { id: 'help', label: '❓ Help' },
];

export const DEFAULT_USER_PERMS = ['shopping', 'items', 'pricer'];

export const PROFILE_ICONS = [
  '👤','👨‍🍳','👩‍🍳','🧑‍💼','👨‍💼','👩‍💼','🍴','🍽️','🥘','🧑','👨','👩','🙋','🤵','👷','💼','⭐','🌟','🔑','📋','✨','🎯','🏆','🥇',
];

export const CATEGORIES = [
  'Meat','Poultry','Seafood','Produce','Dairy','Dry Goods','Spices','Beverages','Bakery','Supplies','Other',
];

export const LOCATIONS = ['Englewood', 'Hackensack'];

export const CUSTOM_CATEGORIES_KEY = '_customCategories';

export const CHART_COLORS = [
  '#8B4513','#D2691E','#A0522D','#B8860B','#CD853F','#DEB887','#8B6914','#C68642',
];

export const PAYMENT_TERMS = [
  'Due on receipt','3% monthly late fee (0.75% weekly)','$40 bounced check fee',
];

export const MENU_UNITS = ['each', 'oz', 'lb', 'g', 'kg', 'ml', 'l'];

// Standard purchase units for the item database and invoice lines
export const PURCHASE_UNITS = [
  'lb', 'oz', 'kg', 'g',       // weight
  'each', 'dozen',              // count
  'case', 'bag', 'box', 'flat', // case/bulk
  'gallon', 'qt', 'pint', 'liter', 'ml', // volume
  'bunch', 'head',              // produce
];
// Which unit values are weight-based (price = per weight unit)
export const WEIGHT_UNITS = new Set(['lb', 'oz', 'kg', 'g']);
// Which unit values are case/bulk (case size matters)
export const CASE_UNITS = new Set(['case', 'bag', 'box', 'flat']);

export const INTERNAL_SELLER_NAME_KEYS = new Set([
  'degrill inc',
  'degrill',
  'parathas and platters inc',
  'parathas & platters',
  'parathas and platters',
  'dera masala grill inc',
  'dera masala grill',
  'dmg software suite',
  'dmg',
]);

export const NAV_GROUPS_ADMIN = [
  { id: 'ops', label: 'Stock', tabs: ['dashboard', 'items', 'invadj', 'shopping', 'pricer'] },
  { id: 'inv', label: 'Invoices', tabs: ['purchase', 'catering', 'transfer', 'payroll', 'archive'] },
  { id: 'people', label: 'Staff', tabs: ['checkio', 'customers', 'suppliers', 'actlog'] },
  { id: 'finance', label: 'Money', tabs: ['analytics', 'dailyfin', 'margins', 'history'] },
  { id: 'admin', label: 'Tools', tabs: ['scanbeta', 'help'] },
];

export const NAV_GROUPS_USER = [
  { id: 'ops', label: 'Stock', tabs: ['shopping', 'items', 'pricer'] },
  { id: 'work', label: 'Work', tabs: ['checkio', 'dailyfin'] },
  { id: 'help', label: 'Help', tabs: ['help'] },
];

export const ADMIN_RESET_QUERY_KEY = 'adminResetToken';
export const ADMIN_RESET_REQ_KEY = 'adminResetReq';
export const ADMIN_RESET_EMAIL = 'fatimfarooq@yahoo.com';
export const ADMIN_RESET_API_BASE = 'http://localhost:8787';
export const ADMIN_RESET_API_ENDPOINTS = ['http://localhost:8787', 'http://127.0.0.1:8787'];
export const ADMIN_RESET_API_BASE_KEY = '_adminResetApiBase';
export const CENTRAL_AUTH_CONFIG_PATH = './auth-api-config.json';
export const ADMIN_RESET_CODE_KEY = '_adminResetCodeHash';
/** Optional per-business logo URLs (Settings); merged with built-in `assets/logos/*.jpg` paths in `App.jsx`. */
export const LOGO_OVERRIDES_KEY = '_logoOverrides';
/** Optional per-business contact info overrides (phone/address/email) editable in Settings. */
export const BIZ_CONTACT_KEY = '_bizContact';
export const FAILURE_LOG_KEY = '_failureLog';
export const SCAN_DOC_TYPES = ['legal','tax','credit','transaction_invoice','bank','payroll','other'];
export const ATT_QR_QUERY_KEY = 'attToken';

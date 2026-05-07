# Agent context — Catering Inventory Manager

## Purpose

Browser-first catering inventory and invoicing app for multiple businesses. Primary UX target is **GitHub Pages** static hosting (`index.html` + hashed JS/CSS). Optional **Node backend** in `backend/` for admin password reset and central auth (`render.yaml`).

## Repository layout (after Vite migration)

| Path | Role |
|------|------|
| `index.html` | Vite entry shell (lightweight); boots `/src/main.jsx` |
| `src/constants.js` | Businesses, tabs, nav groups, storage/auth key names, `LOCATIONS`, `CATEGORIES` (shared) |
| `src/formatters.js` | Pure helpers: currency/date/bytes, `migrateShoppingList`, `resolveAssetUrl` (relative logos under GitHub Pages), API URL helpers |
| `src/browserCaps.js` | Boot checks for Web Crypto + `structuredClone` → DMG-E050/E051 (tests in `browserCaps.test.js`) |
| `src/useOnlineStatus.js` | Hook: `navigator.onLine` + online/offline events for Slice 5 banner |
| `src/ReliabilityBanners.jsx` | Offline banner + shared browser-capability banner UI |
| `src/ui/Confirm.jsx` | Reusable destructive-confirm modal (used from `App.jsx`; z-index above nested modals) |
| `src/ui/Modal.jsx` | Reusable dialog shell (used from `App.jsx` for settings, invoice forms, profile) |
| `src/ui/SettingsModal.jsx` | Admin settings panel (backup/restore, staff user management, logo/contact overrides, diagnostics, reset API config) |
| `src/ui/LoginScreen.jsx` | Login form with central-auth support, quick admin reset, and device-remember flow |
| `src/ui/FirstRunSetup.jsx` | First-run starter-file import wizard (shown when no credentials exist) |
| `src/ui/AdminResetPortal.jsx` | Private admin password reset portal (accessed via deep-link token) |
| `src/authHelpers.js` | Shared module-level helpers: `hashPwd`, auth API calls (`loginViaBackend`, `syncCredentialsToBackend`, `scanApiCall`, `attendanceApiCall`, `getAuthStatus`), `logFailure`, `downloadFailureLog`, diagnostics utilities, `BRANDING`, `mergeBrandingWithOverrides` |
| `src/App.jsx` | Main React shell (~700 lines): routing, `getInvoiceBranding`, `SetupQuickActions`, `ProfileModal`, `App` component |
| `src/toastContext.jsx` | **`ToastProvider`** wraps `<App />` in `main.jsx`; **`showToast`** / **`toastApiFailure`** (global, works on login + modals) |
| `src/utils/storage.js` | `load`, `save` (with quota/DMG-E010/E011 handling), `uid`, `today` — importable by any tab |
| `src/utils/activity.js` | `logActivity(action, details)` — writes to `_activityLog`; imports from `storage.js` |
| `src/utils/print.js` | `documentBaseHref`, `rewriteImgSrcsForPrint`, `printHtmlDocument`, `printInvoiceById` |
| `src/utils/invoiceIds.js` | `nextId(type)`, `nextTransferId(dateStr)`, `normalizeTransferInvoice(inv)` — ID generators + transfer normaliser |
| `src/utils/errors.js` | `logFailure({ area, action, error, extra })` — structured error logger to `_failureLog` (max 500 entries) |
| `src/tabUtils.js` | Compatibility shim — re-exports `load`, `today`, `logActivity`, `logFailure`, `getProfile` for tabs extracted before canonical utils existed. **Use direct utils imports in new code.** |
| `src/ui/BrandMark.jsx` | `BrandMark` React component — renders business logo/mark badge on invoice headers |
| `src/errors.js` | `reportError`, diagnostics ring buffer, `copyDiagnostics`; wired from Help tab |
| `src/apiErrors.js` | DMG-E020–E031 mapping for auth/scan/attendance `fetch` + HTTP |
| `src/storageHealth.js` | localStorage probe, quota estimate, corrupt key scan, save-failure notify |
| `src/charts/` | Lazy `React.lazy` chart panels (Recharts only loads when chart UI mounts) |
| `src/HelpCenter.jsx` | Help tab: diagnostics, supported browsers, DMG codes, **repair one corrupt storage key** (paste JSON) |
| `src/styles.css` | Global styles (extracted from legacy HTML) |
| `public/` | Static copies served at site root (e.g. `auth-api-config.json`, **`public/assets/logos/*.jpg`** for invoice/header images — `BRANDING.logo` paths must match) |
| `assets/logos/` (repo root) | **Source** JPGs only; **deploy path** is `public/assets/logos/` (Vite copies `public/` → `dist/`). Replace files there and redeploy to update logos. |
| `dist/` | **Production build output** (`npm run build`) — deploy **contents** to Pages |
| `backend/` | Express-style reset/auth API for Render |
| `docs/PRODUCT_BACKLOG.md` | Roadmap: error codes, slices, deferred backlog |

## Commands

```bash
npm install          # deps at repo root
npm run dev          # local dev server (Vite)
npm run build        # production bundle → dist/
npm run preview      # serve dist locally
npm test             # Vitest (apiErrors, constants, storageHealth, formatters, browserCaps)
```

Backend (optional): see `backend/README.md`.

## Deployment (GitHub Pages)

**Source:** Settings → Pages → **GitHub Actions** (not “Deploy from a branch”).

| Workflow | When |
|----------|------|
| `.github/workflows/deploy-pages.yml` | Push to `master`, or **Actions → Run workflow** |
| `.github/workflows/ci.yml` | Push/PR to `master` — **test + build** |

Build output **`dist/`** is uploaded as the Pages artifact. On first deploy you may need to approve the **github-pages** environment once.

**Implementation notes**

- `vite.config.js` uses `base: './'` so hashed assets resolve under project URLs (`/catering-inventory-manager/`); `chunkSizeWarningLimit` raised because the intentional **recharts** chunk is large.
- `public/.nojekyll` is emitted into `dist/` so paths like `_assets` are not mangled by Jekyll.
- `public/auth-api-config.json` is copied to `dist/` at build time.

If Actions are unavailable, fall back: `npm run build`, then publish **contents of `dist/`** manually.

## Error codes

Stable catalog: `docs/PRODUCT_BACKLOG.md`. Implementation helpers:

- **`src/errors.js`** — ring buffer, diagnostics JSON.
- **`src/apiErrors.js`** — classify backend `fetch` / HTTP → DMG-E020–E031.
- **`showToast`** / **`toastApiFailure`** — `src/toastContext.jsx` (mounted once in `main.jsx` via `ToastProvider`).
- **`getBootCapabilityWarnings`** (`src/browserCaps.js`) — DMG-E050/E051 for missing Web Crypto; extra DMG-E050 when `structuredClone` is missing (export/import paths).
- **`useOnlineStatus`** — offline banner when `navigator.onLine` is false (local app data still saves).
- **`Confirm`** — `src/ui/Confirm.jsx` (imported by `App.jsx`) for destructive flows (settings restore, staff delete, shopping clear, activity log, menu delete, logout, kiosk, corrupt keys, tab deletes). Backdrop click = cancel.
- **`handleRepairStorageKey`** in `App.jsx` — Help tab overwrites one corrupt key after validating JSON (Slice 3 / BL-08).
- **`src/apiErrors.test.js`** / **`src/constants.test.js`** / **`src/storageHealth.test.js`** / **`src/formatters.test.js`** / **`src/browserCaps.test.js`** / **`src/utils/storage.test.js`** / **`src/utils/invoiceIds.test.js`** — Vitest (run `npm test`; 85 tests total).

Boot-related:

- **`DMG-E001`** — Bundle/scripts failed to load or hung before mount (watchdog).
- **`DMG-E002`** — Mount threw or compile/runtime failure during startup.
- **`DMG-E003`** — React render error thrown after initial mount. **Fixed** — `src/ErrorBoundary.jsx` wraps `<App>` in `main.jsx` (Slice 7).

Form validation:

- **`DMG-E006`** — Form submission blocked by a missing or invalid required field. Appears in the toast body (e.g. "Supplier name is required. [DMG-E006]"). Not a system error — used as a stable reference for support conversations.

## Data namespace policy

**Shared vs. per-business localStorage keys** — all three businesses (DeGrill, Parathas, Dera) read from the same `items`, `purchaseInvoices`, `cateringInvoices`, `customers`, `priceHistory`, etc. keys. `_lastBiz` is a UI context filter only, not a data partition.

**Current intentional design:**
- `items` (inventory catalog) and `customers` are **shared across all businesses** — the same vendors and clients serve all three locations.
- Invoice keys (`purchaseInvoices`, `cateringInvoices`, `transferInvoices`, `payrollInvoices`) are shared in localStorage but each invoice record carries a `business` field (string key e.g. `'degrill'`). Each invoice tab defaults to filtering by the currently selected business, with an "All businesses" toggle available to admins. This lets each business see their own data while keeping a single storage key.

**Invoice auth:** All invoice and customer tabs (`purchase`, `catering`, `transfer`, `payroll`, `archive`, `customers`) are **admin-only**. Non-admin staff only see: Check In/Out, Shopping, Items, Price Updater, Daily Finance, Help.

**Transfer invoices:** Tab renamed to "Transfer Inv." (from "P&P Transfer Inv.") to reflect that any business can originate a transfer. Source/destination are stored in `from`/`to` fields on the invoice record.

## Payroll invoices vs. Scan DB

`payrollInvoices` (localStorage) = manually-entered payroll summaries (amounts, periods, notes).
`backend/data/scan-db.json` = metadata for PDFs ingested via the Scan DB tab (may include payroll PDFs).

These are **separate systems** — scan-db stores document references, not payroll accounting entries. If a scanned PDF is a payroll document, the user must manually create a corresponding `payrollInvoices` entry; there is no automatic link. Full auto-linking is Epic B (BL-18, deferred).

**Scan DB backup:** `scan-db.json` lives on the backend and is NOT included in the Settings ZIP export. The Scan DB tab has a **"Download Scan DB Backup"** button (calls `/api/scan/export`, admin-only) to download a separate JSON backup. This is a manual step — it is not triggered by the main Settings ZIP export.

## Scan DB architecture (admin-device only)

The Scan DB (`src/tabs/ScanDatabaseBeta.jsx`) is intentionally **admin-device-only**. It requires the Node backend running locally (typically `http://localhost:8787`). The system:

- Watches a configured inbox folder for newly scanned files (PDFs, images)
- Organises them into a **Windows folder-based archive**: `Library Root / Year / DocType / descriptive-filename`
- Descriptive filenames encode sender, date, and document type at a glance (e.g. `2026-04-15_Invoice_SupplierX.pdf`)
- Stores metadata (sender, docType, businessTag, status) in `backend/data/scan-db.json`

**This system is entirely separate from the invoice database on the site.** Overlaps are intentional (e.g. a scanned supplier invoice may also appear as a `purchaseInvoice` record), but the two are not linked. The scan DB tracks raw document files; the invoice DB tracks accounting entries entered by users. Do NOT attempt to merge or auto-sync them without explicit design work (BL-18).

## Password hashing

`hashPwd(pwd, username)` in `App.jsx` computes `SHA-256(pwd + ':' + username.toLowerCase())` — a deterministic per-user salt (Slice 10, BL-19). Login tries the salted hash first; on a legacy no-salt match it silently upgrades the stored credential. `saveResetCode` intentionally stays unsalted (standalone PIN, not user-linked).

## Storage key reference

| Key | Purpose |
|-----|---------|
| `items` | Inventory item catalog (shared across businesses) |
| `shoppingList` | Current shopping list entries |
| `purchaseInvoices` | Purchase invoices from suppliers |
| `transferInvoices` | Inter-business transfer invoices |
| `payrollInvoices` | Manually-entered payroll summaries |
| `cateringInvoices` | Invoices issued to catering customers |
| `customers` | Customer contact database (shared) |
| `credentials` | SHA-256 password hashes for local auth |
| `priceHistory` | Historical item prices per supplier |
| `_dailyFinanceEntries` | Daily income/expense tracker entries |
| `_menuItems` | Menu item names and pricing (legacy key; see `_menuRecipes`) |
| `_menuRecipes` | Recipe definitions for menu margin costing (BL-01) |
| `_session` | Current logged-in user session |
| `_lastBiz` | UI context: last-selected business ID |
| `_userPermissions` | Per-user permission overrides |
| `_kioskLock` | Kiosk mode lock state for Check In/Out tab |
| `_activityLog` | Audit trail (max 500 entries) |
| `_profiles` | Staff profile display data |
| `_seq` | Monotonic sequence counter used for invoice number generation (e.g. `INV-0042`) |
| `_rememberedCheckinLogin` | Remembered username for kiosk check-in form |
| `_adminResetApiBase` | Cached backend URL for admin password reset |
| `_adminResetCodeHash` | Hash of pending admin reset code |
| `_failureLog` | Persistent error log (max 500 entries; complements sessionStorage ring buffer in `errors.js`) |
| `_logoOverrides` | Per-business invoice logo HTTPS URL overrides (BL-11) |
| `_bizContact` | Per-business phone/address/email overrides editable in Settings (Slice 15) |
| `settings` | User settings object (page size, preferences, `logoOverrides` for backup round-trip) |

## Conventions for agents

- Prefer **small, focused PRs** matching backlog slices.
- Do not revert **additive** `localStorage` keys without migration notes (see comments in `App.jsx` about compatibility).
- After editing `src/App.jsx`, `src/ui/*`, `src/utils/*`, or `src/tabs/*`, run **`npm run build`** to confirm no import errors; run **`npm test`** when changing `apiErrors.js`, `constants.js`, `storageHealth.js`, `formatters.js`, `browserCaps.js`, `utils/storage.js`, `utils/invoiceIds.js`, or adding `*.test.js`.
- **Invoice logos:** default files in **`public/assets/logos/*.jpg`**. Optional per-business **HTTPS** overrides in **Settings** → stored in localStorage key **`_logoOverrides`** (`LOGO_OVERRIDES_KEY` in `constants.js`); also embedded in backup ZIP `settings.json` as `logoOverrides` for round-trip.
- **COGS / costing** and heavy analytics belong in backlog (`BL-01`); pair with existing items + shopping list when implemented.
- **Entity IDs** use `crypto.randomUUID()` (BL-14). Existing IDs in localStorage use the old `_xxxxxxxxx` format and remain valid indefinitely.

## Backup / export contract (version history)

| Version | What's included |
|---------|----------------|
| `1.x` | items, shoppingList, purchaseInvoices, cateringInvoices, customers, priceHistory |
| `2.0` | + settings (selectedBusiness, logoOverrides) |
| `2.1` | + transferInvoices, payrollInvoices, dailyFinanceEntries |
| `2.2` | + settings.bizContact (editable business phone/address/email) — **current** |

Restoring an older ZIP shows a version-gap warning for any missing keys (Slice 13). The `bizContact` field within `settings.json` in the ZIP is optional — missing it leaves contact overrides unchanged on device.

## Key storage keys added since last audit

| Key | Purpose |
|-----|---------|
| `_archivePageSize` | User-selected page size for Invoice Archive (10/25/50, default 25). UI preference only — not critical data. |

## QR code

`CheckInOutPage` generates kiosk QR images using the `qrcode` npm package (Slice 12, BL-21). The previous external `api.qrserver.com` CDN call has been removed. QR is generated client-side via `QRCode.toDataURL(url)` and stored as a data-URL in `qrDataUrl` state — no outbound network requests for QR rendering.

## BRANDING constant (App.jsx)

`BRANDING` in `App.jsx` (search for `const BRANDING`) holds per-business display data: `mark`, `name`, `location`, `address`, `phone`, `email`, `logo`. Update the `address`, `phone`, `email` fields with real contact info when deploying. These are hardcoded constants — making them editable in Settings is tracked as BL-23.

`getInvoiceBranding(inv, brandingMap)` resolves the correct brand for an invoice (falls back to `b[inv.business]` or a generic fallback). All four invoice types (Purchase, Catering, Transfer, Payroll) render the full business header (name, address, phone, email) on their view/print modals.

## Tab file layout

| Component | File | Status |
|-----------|------|--------|
| `PayrollInvoices` | `src/tabs/PayrollInvoices.jsx` | extracted — manual payroll creation + edit/view/print |
| `ActivityLog` | `src/tabs/ActivityLog.jsx` | extracted — audit trail, user/date filters, clear-with-confirm |
| `ScanDatabaseBeta` | `src/tabs/ScanDatabaseBeta.jsx` | extracted — admin-device scan organiser; props: `scanApiCall`, `hashPwd` |
| `CustomerManagement` | `src/tabs/CustomerManagement.jsx` | extracted — customer CRUD, contact database |
| `DailyIncomeExpense` | `src/tabs/DailyIncomeExpense.jsx` | extracted — daily finance tracker |
| `CheckInOutPage` | `src/tabs/CheckInOutPage.jsx` | extracted — QR attendance + kiosk; prop: `attendanceApiCall` |
| `MenuMarginsLab` | `src/tabs/MenuMarginsLab.jsx` | extracted — menu costing & margin analytics |
| `ItemDatabase` | `src/tabs/ItemDatabase.jsx` | extracted — inventory item catalog |
| `ShoppingList` | `src/tabs/ShoppingList.jsx` | extracted — shopping list + auto-complete |
| `PurchaseInvoices` | `src/tabs/PurchaseInvoices.jsx` | extracted — purchase invoices; prop: `getInvoiceBranding` |
| `CateringInvoices` | `src/tabs/CateringInvoices.jsx` | extracted — catering invoices; prop: `getInvoiceBranding` |
| `TransferInvoices` | `src/tabs/TransferInvoices.jsx` | extracted — inter-business transfer invoices; prop: `getInvoiceBranding` |
| `InvoiceArchive` | `src/tabs/InvoiceArchive.jsx` | extracted — cross-type invoice archive; prop: `getInvoiceBranding` |
| `Analytics` | `src/tabs/Analytics.jsx` | extracted — revenue/cost analytics with Recharts |
| `PriceHistory` | `src/tabs/PriceHistory.jsx` | extracted — price history table + chart |
| `PriceUpdater` | `src/tabs/PriceUpdater.jsx` | extracted — bulk price update workflow |

`src/tabs/` is the extraction target for all tab components (Epic C / BL-07). `src/App.jsx` now holds only the shell: auth, settings modal, login screen, and routing.

### Shared utilities pattern for extracted tabs

Each extracted tab file imports only what it needs — no props drilling of utility functions:
```js
import { load, save, uid, today } from '../utils/storage.js';
import { logActivity } from '../utils/activity.js';
import { printHtmlDocument, printInvoiceById } from '../utils/print.js';
import { nextId, nextTransferId, normalizeTransferInvoice } from '../utils/invoiceIds.js';
import { BrandMark } from '../ui/BrandMark.jsx';
```
Exception: `getInvoiceBranding` remains in `App.jsx` (depends on `BRANDING` constant + `mergeBrandingWithOverrides`) and is passed as a prop to invoice tabs.

## Item schema (Slice 19 additions)

`items` records now carry optional per-location fields in addition to the legacy scalar fields:

```js
{
  id, name, category, unit, upc, sellers, notes, createdAt,
  currentQty, minQty,           // legacy scalars — still used for backward compat
  locQty:    { englewood: '', hackensack: '' },   // per-location quantity
  locMinQty: { englewood: '', hackensack: '' },   // per-location reorder point
}
```

Low-stock detection in `ItemDatabase.jsx` and `ShoppingList.jsx` checks **both** legacy scalars and per-location fields. Old items without `locQty` have empty-string defaults injected at edit time. The "Overall stock (legacy)" section in the item form is hidden under a `<details>` element — prefer per-location fields for new data.

`LOCATIONS = ['Englewood', 'Hackensack']` is the canonical list in `src/constants.js`. If locations change, update this constant and regenerate any `locQty`/`locMinQty` default objects that are computed from it.

## Price memory (Slice 19 / BL-41)

In `PurchaseInvoices.jsx`, the `setLine` function auto-fills `unitPrice` and `unit` when the description field exactly matches (case-insensitive) an item name in the DB. It prefers the seller that matches `form.supplier`; falls back to `sellers[0]`. Only fills blank fields — does not overwrite existing values.

## Shopping list location context (Slice 22 / BL-43)

`ShoppingList.jsx` has a "Shopping for:" location selector (dropdown, persisted as `_shoppingLoc`). The "⚠ Low Stock" button uses the selected location to check `item.locQty[lc] <= item.locMinQty[lc]` first, then falls back to legacy `currentQty/minQty`. The selected location is shown in the button label: "⚠ Low Stock (Hackensack)".

## Inventory adjustment log (Slice 22 / BL-39)

New admin tab "📝 Inv. Log" (`src/tabs/InventoryAdjustments.jsx`) added to the Stock nav group. Props: `{ items, setItems }`. Storage key: `INVENTORY_ADJUSTMENTS_KEY = '_inventoryAdjustments'` (array of `{ id, itemId, itemName, location, delta, reason, notes, date, createdAt }`). On save, immediately increments/decrements `item.locQty[location.toLowerCase()]`. Deleting a log entry does NOT reverse the stock change. Tab is admin-only; non-admin users don't see it.

## Custom categories (Slice 21 / BL-38)

`CUSTOM_CATEGORIES_KEY = '_customCategories'` in `constants.js` stores an array of admin-defined category strings. `SettingsModal.jsx` renders a "🏷️ Item Categories" section where admin can add/remove these. `ItemDatabase.jsx` computes `allCategories` via `useMemo` by merging `CATEGORIES` with the custom list on each render. The category dropdown in the item form, the category filter, and the bulk import validation all use `allCategories`. When adding custom categories, duplicates of built-in names are blocked at the UI level.

## Quick stock adjustment (Slice 21 / BL-42)

In `ItemDatabase.jsx`, each location row in the Stock column shows inline + and − buttons (admin-only) that call `adjustLocQty(itemId, loc, delta)`. This directly updates `locQty[loc]`, saves to storage, and logs activity. The Stock column also shows a category filter dropdown (`catFilter` state) beside the search bar, filtering the item list by selected category.

## Item export CSV (Slice 20 / BL-36)

`ItemDatabase.jsx` admin header has an "⬇ Export CSV" button. Exports all items as a CSV with columns: `name, category, unit, upc, seller, price, englewood_qty, englewood_min, hackensack_qty, hackensack_min, notes`. Round-trip compatible with the BL-35 import (same column aliases accepted on re-import).

## Purchase invoice → stock update (Slice 20 / BL-37)

Each purchase invoice row has a "📦 Stock" button (admin, requires `setItems` prop). Opens a modal to select Englewood or Hackensack location, shows which line items matched items in the DB (by name), and increments `locQty[location]` for matched items on confirm. `setItems` is now passed from App.jsx to PurchaseInvoices.

## Bulk CSV import (Slice 19 / BL-35)

`ItemDatabase.jsx` exposes an "Import CSV" button (admin only). Supports `.csv`, `.xlsx`, `.xls`. Requires a `name` column; optional `category`, `unit`, `upc`, `seller`, `price`. Column matching is case-insensitive and alias-aware (e.g. "supplier" → seller, "barcode" → upc). Shows a preview modal with per-row Add/Update/Skip status before committing.

## Inter-location stock transfer (Slice 23 / BL-46)

`InventoryAdjustments.jsx` now has a second card "Transfer Stock Between Locations" above the log table. It creates **two atomic adjustment records** — a negative delta at the source location and a positive delta at the destination. Both `locQty` keys on the item are updated in the same state mutation. The notes on each record describe the direction (e.g. "Transfer to Hackensack: [user notes]" / "Transfer from Englewood: [user notes]"). Logs `transfer_stock` activity. Required import: `logActivity` from `'../utils/activity.js'` (added in BL-46).

## Reorder point auto-suggest (Slice 23 / BL-45)

`ItemDatabase.jsx` accepts a `purchaseInvoices` prop (passed from `App.jsx`). When `openEdit(item)` is called, if ≥2 purchase invoice lines match the item name (case-insensitive), a green banner is shown in the edit modal: "Based on N purchases (avg X unit/order) — suggested reorder point: Y unit" with a "Use suggestion" button. Clicking fills all per-location `locMinQty` fields with `Math.ceil(avg * 0.5)` (50% of average purchase quantity). Requires: `purchaseInv` state in `App.jsx` passed as `purchaseInvoices={purchaseInv}`.

## Shopping list notes (Slice 23 / BL-47)

`ShoppingList.jsx` has a Notes column with an inline text `<input>` per row. Notes are persisted in `shoppingList` localStorage entries as `notes` field. CSV export already included `s.notes` — it now has a value from the UI.

## Storage keys (Slice 22–23 additions)

| Key | Purpose |
|-----|---------|
| `_inventoryAdjustments` | Inventory adjustment log records (`INVENTORY_ADJUSTMENTS_KEY`) |
| `_customCategories` | Admin-defined extra item categories (`CUSTOM_CATEGORIES_KEY`) |
| `_shoppingLoc` | Last-selected "Shopping for" location in ShoppingList (UI preference) |

## CSV import round-trip (Slice 27)

`ItemDatabase.jsx` import now reads per-location columns from the exported CSV format:
- Column names: `englewood_qty`, `hackensack_qty`, `englewood_min`, `hackensack_min`, `notes`
- On **Add**: new items get `locQty`/`locMinQty` populated from import data
- On **Update**: existing items merge import locQty/locMinQty (preserving values not in CSV)
- `IMPORT_COL` also handles `notes` column alias
- Round-trip verified: export → import produces same data

## Purchase invoice price back-propagation (Slice 25 / BL-54)

`PurchaseInvoices.jsx`: when "Mark Paid" is clicked, auto-updates matching item seller prices:
- Matches each line item description to item name (case-insensitive)
- Matches supplier name to seller name (case-insensitive)
- Only updates existing sellers — does NOT add new sellers automatically
- Logs a toast if any prices were updated: "Marked paid. Updated prices for X items."
- Requires `setItems` prop (already passed from App.jsx)

## Item history modal (Slice 26 / BL-50)

`ItemDatabase.jsx`: "History" button in admin Actions column opens a Modal with:
- Purchase invoice lines matching the item name (all invoices, newest first)
- Inventory adjustments matching the item (by id or name, newest first)
- Delta column colored green (positive) / red (negative)
- `purchaseInvoices` prop is required (passed from App.jsx since BL-45)

## Activity log CSV export (Slice 26 / BL-53)

`ActivityLog.jsx`: "⬇ Export CSV" button exports the currently-filtered log entries (respects user/date filters) as a downloadable CSV.

## Catering invoice price memory (Slice 26 / BL-52)

`CateringInvoices.jsx`: `setLine` function now auto-fills `unitPrice` when the description matches an item name (same pattern as purchase invoices). Uses `items[0].sellers[0].price` as the default price.

## Dashboard quick-add to shopping list (Slice 26)

`Dashboard.jsx`: "➕ Add all to Shopping List" button in the low-stock section adds all low-stock items to the shopping list. Requires `shoppingList` + `setShoppingList` props (passed from App.jsx using `shopping`/`setShopping` state).

## Purchase invoice Excel export (Slice 27 / BL-51)

`PurchaseInvoices.jsx`: "⬇ Export Excel" button exports visible invoices (respects "All businesses" toggle) as `purchase-invoices-YYYY-MM-DD.xlsx`.

## Test coverage (Slice 27)

101 tests across 9 files (up from 85). New: `src/tabs/itemUtils.test.js` (isLowStock pure function), `src/formatters.test.js` additions (safePrice, safeQty, sellerKey), `src/utils/activity.test.js` addition (unknown action type).

## Known technical debt

- `src/App.jsx` shell (~700 lines after Epic C full extraction); all tabs in `src/tabs/`, UI components in `src/ui/`, utility functions in `src/utils/`, shared auth/backend helpers in `src/authHelpers.js`. Epic C (BL-07) is complete.
- Recharts (~565KB min) loads **on demand** via `src/charts/*` lazy imports; initial shell avoids it until a chart tab renders charts.
- ~~No React error boundary (DMG-E003)~~ — **Fixed** (Slice 7, `src/ErrorBoundary.jsx`).
- ~~Password hashing is unsalted SHA-256~~ — **Fixed** (Slice 10, username salt added with silent legacy upgrade).
- ~~QR code uses external CDN (`api.qrserver.com`)~~ — **Fixed** (Slice 12, replaced with `qrcode` npm package).
- ~~Old backup ZIPs (v2.0) are missing transfer/payroll/dailyFin~~ — **Fixed** (Slice 13, restore warning).
- ~~BRANDING phone/address/email are hardcoded constants~~ — **Fixed** (Slice 15, `_bizContact` overrides editable in Settings).
- Transfer invoice direction is hardcoded to Parathas as default origin — generalize as part of Epic A.

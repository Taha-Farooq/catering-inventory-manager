# Agent context — Catering Inventory Manager

## Purpose

Browser-first catering inventory and invoicing app for multiple businesses. Primary UX target is **GitHub Pages** static hosting (`index.html` + hashed JS/CSS). Optional **Node backend** in `backend/` for admin password reset and central auth (`render.yaml`).

## Repository layout (after Vite migration)

| Path | Role |
|------|------|
| `index.html` | Vite entry shell (lightweight); boots `/src/main.jsx` |
| `src/constants.js` | Businesses, tabs, nav groups, storage/auth key names (shared) |
| `src/formatters.js` | Pure helpers: currency/date/bytes, `migrateShoppingList`, `resolveAssetUrl` (relative logos under GitHub Pages), API URL helpers |
| `src/browserCaps.js` | Boot checks for Web Crypto + `structuredClone` → DMG-E050/E051 (tests in `browserCaps.test.js`) |
| `src/useOnlineStatus.js` | Hook: `navigator.onLine` + online/offline events for Slice 5 banner |
| `src/ReliabilityBanners.jsx` | Offline banner + shared browser-capability banner UI |
| `src/ui/Confirm.jsx` | Reusable destructive-confirm modal (used from `App.jsx`; z-index above nested modals) |
| `src/ui/Modal.jsx` | Reusable dialog shell (used from `App.jsx` for settings, invoice forms, profile) |
| `src/App.jsx` | Main React shell + tab implementations (large; BL-07 — extract more from here over time) |
| `src/toastContext.jsx` | **`ToastProvider`** wraps `<App />` in `main.jsx`; **`showToast`** / **`toastApiFailure`** (global, works on login + modals) |
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
- **`src/apiErrors.test.js`** / **`src/constants.test.js`** / **`src/storageHealth.test.js`** / **`src/formatters.test.js`** / **`src/browserCaps.test.js`** — Vitest (run `npm test`).

Boot-related:

- **`DMG-E001`** — Bundle/scripts failed to load or hung before mount (watchdog).
- **`DMG-E002`** — Mount threw or compile/runtime failure during startup.
- **`DMG-E003`** — React render error thrown after initial mount. **Not yet wired** — tracked as BL-12. Implement via `src/ErrorBoundary.jsx` class component wrapping `<App>` in `main.jsx`.

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

These are **separate systems** — scan-db stores document references, not payroll accounting entries. If a scanned PDF is a payroll document, the user must manually create a corresponding `payrollInvoices` entry; there is no automatic link. See BL-18 for the planned integration.

**Scan DB backup gap:** `scan-db.json` lives on the backend and is NOT included in the Settings ZIP export. Use `/api/scan/export` (admin, GET) to download a separate JSON backup. See BL-18 for adding a UI trigger.

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
- After editing `src/App.jsx`, `src/ui/*`, or shared modules, run **`npm run build`**; run **`npm test`** when changing `apiErrors.js`, `constants.js`, `storageHealth.js`, `formatters.js`, `browserCaps.js`, or adding `*.test.js`.
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

`BRANDING` in `App.jsx` (≈ line 592) holds per-business display data: `mark`, `name`, `location`, `address`, `phone`, `email`, `logo`. Update the `address`, `phone`, `email` fields with real contact info when deploying. These are hardcoded constants — making them editable in Settings is tracked as BL-23.

`getInvoiceBranding(inv, brandingMap)` resolves the correct brand for an invoice (falls back to `b[inv.business]` or a generic fallback). All four invoice types (Purchase, Catering, Transfer, Payroll) render the full business header (name, address, phone, email) on their view/print modals.

## Invoice tabs file layout

| Component | File | Notes |
|-----------|------|-------|
| `PurchaseInvoices` | `src/App.jsx` | in-file component |
| `CateringInvoices` | `src/App.jsx` | in-file component; `customerAddress` field added |
| `TransferInvoices` | `src/App.jsx` | in-file component |
| `PayrollInvoices` | `src/tabs/PayrollInvoices.jsx` | **extracted** — manual payroll creation + edit/view/print |
| `InvoiceArchive` | `src/App.jsx` | in-file; `selectedBusiness` + `bizF` business filter added |

`src/tabs/` is the target directory for all future tab extractions (Epic C / BL-07).

## Known technical debt

- `src/App.jsx` is monolithic (~5900 lines); **`src/ui/Confirm.jsx`**, **`src/ui/Modal.jsx`**, and **`src/tabs/PayrollInvoices.jsx`** are extracts — continue with other tabs (`BL-07`).
- Recharts (~565KB min) loads **on demand** via `src/charts/*` lazy imports; initial shell avoids it until a chart tab renders charts.
- ~~No React error boundary (DMG-E003)~~ — **Fixed** (Slice 7, `src/ErrorBoundary.jsx`).
- ~~Password hashing is unsalted SHA-256~~ — **Fixed** (Slice 10, username salt added with silent legacy upgrade).
- ~~QR code uses external CDN (`api.qrserver.com`)~~ — **Fixed** (Slice 12, replaced with `qrcode` npm package).
- ~~Old backup ZIPs (v2.0) are missing transfer/payroll/dailyFin~~ — **Fixed** (Slice 13, restore warning).
- ~~BRANDING phone/address/email are hardcoded constants~~ — **Fixed** (Slice 15, `_bizContact` overrides editable in Settings).
- Transfer invoice direction is hardcoded to Parathas as default origin — generalize as part of Epic A.

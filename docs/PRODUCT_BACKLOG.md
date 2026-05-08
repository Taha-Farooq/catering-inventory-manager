# Product backlog — reliability, build, and vertical slices

This document plans end-to-end reliability work for the DMG Software Suite (static GitHub Pages app + optional Render backend). It defines **error codes**, **vertical development slices** (each shippable), and a **backlog** for gaps discovered along the way—including items too large for the current slice.

---

## Goals

1. **Predictable load:** App shell and core UI load without depending on flaky CDN + in-browser Babel for every visit.
2. **Observable failures:** Every failure class the user can hit has a **stable error code**, short copy, and one primary recovery action.
3. **Incremental delivery:** Each slice is independently deployable and testable; oversized ideas go to backlog with explicit deferral reason.

---

## Error code registry

Prefix: **`DMG-`** (machine-oriented string; show in UI and support conversations).

| Code | Category | When it applies | User-facing summary | Primary recovery |
|------|-----------|-----------------|---------------------|------------------|
| `DMG-E001` | Boot | React/ReactDOM failed to load (CDN blocked, offline) | Scripts did not load | Check network; allow CDN; retry |
| `DMG-E002` | Boot | App bundle failed to execute (syntax/runtime before mount) | App could not start | Refresh; clear cache; update browser |
| `DMG-E003` | Boot | Mount/render threw after bundle ran | Screen crashed | Refresh; note code in Help |
| `DMG-E010` | Storage | `localStorage` unavailable (disabled, private mode quirks) | Data storage is off | Enable storage; exit strict private mode |
| `DMG-E011` | Storage | Quota exceeded | Device storage full | Export backup; delete old data; admin help |
| `DMG-E012` | Storage | Corrupt JSON for a key (migration/read) | Data read error | Restore from export; admin reset |
| `DMG-E020` | Auth | Invalid credentials | Sign-in failed | Retry password; contact admin |
| `DMG-E021` | Auth | Central auth API unreachable | Login service unavailable | Retry later; offline allowance policy |
| `DMG-E022` | Auth | Token/session invalid or expired | Session expired | Sign in again |
| `DMG-E030` | Network | Fetch to backend failed (timeout/DNS) | Server unreachable | Check URL; VPN; try later |
| `DMG-E031` | Network | CORS or origin mismatch | Connection blocked | Admin: ALLOWED_ORIGINS config |
| `DMG-E040` | Data | Import file invalid or wrong format | Import failed | Use template; ask admin |
| `DMG-E041` | Data | Export interrupted | Export incomplete | Retry; less data |
| `DMG-E050` | Browser | Unsupported browser / missing APIs | Browser not supported | Use Chrome/Edge/Firefox current |
| `DMG-E051` | Browser | Required API missing (e.g. crypto.subtle HTTP) | Secure context required | Use HTTPS or localhost |

**Design gap:** Today some paths only show generic alerts. Slices below add a single **Error center** pattern: code + message + “Copy details” (JSON with code, user agent, build id).

---

## Vertical development slices

Each slice should end with: merged PR, GitHub Pages deploy, **manual smoke checklist**, and updated **error code** wiring where relevant.

### Slice 1 — Build pipeline and static bundle (foundation)

**Status:** Done — Vite at repo root (`package.json`, `vite.config.js`, `src/`). `npm run build` outputs hashed bundles under `dist/`; dependencies are React, Recharts, xlsx, JSZip (no Babel-in-browser for app code).

**Objective:** Replace browser Babel + scattered CDN with a checked-in build (e.g. Vite or esbuild) that emits `assets/index-*.js` and minimal HTML shell.

**Scope**

- Add `package.json` at repo root (or `frontend/`) with `build` / `preview`.
- Entry point extracts from current `index.html` JSX (or incremental move of `App` to `src/App.jsx`).
- Output directed to a folder GitHub Pages can serve (e.g. `dist/` or keep `index.html` at root pointing to built assets—align with existing Pages config).
- Pin dependency versions in lockfile; **no `development` React** in production artifact.

**Acceptance**

- Cold load does not fetch `@babel/standalone` for app code.
- Single bundle hash in filename for cache busting.
- Document `npm run build` in README.

**Backlog items discovered (defer)**

- **Source maps:** Enabled in Vite build for `DMG-E002` triage; revisit privacy/size in Slice 2 if needed.
- **Slice 4 follow-up:** Lazy-load Recharts (`import()`); analytics chunk is still large (~565KB min).
- **Pages CI:** `.github/workflows/deploy-pages.yml` added — enable **GitHub Actions** as Pages source in repo Settings after merge.

---

### Slice 2 — Error surface and diagnostics package

**Status:** Partial — `src/errors.js`; Help tab diagnostics; **`ToastProvider`** + **`showToast`** (no `alert`). **`src/ui/Confirm.jsx`** for destructive choices (replaces **`window.confirm`**): staff delete, full backup restore, shopping list clear, activity log clear, menu item delete, sign out, kiosk mode, corrupt-key removal, **and tab delete flows** (items, invoices, customers, archive, transfer, price history) with **DMG-E012** on confirm where relevant. **DMG-E003 done** (Slice 7 — `src/ErrorBoundary.jsx`). Optional remaining: DMG codes on form validation toasts (missing-field rejections show plain text toasts) — see BL-29.

**Objective:** Centralize errors; every categorized failure shows `DMG-Exxx` and structured detail for support.

**Scope**

- Small `reportError(code, context)` helper; optional ring buffer in sessionStorage for last N errors (privacy: no passwords).
- Replace scattered `alert()` / native confirms on critical paths with modal/banner + code where practical.
- “Copy diagnostics” includes: codes, app version/build hash, browser, storage available flag.

**Acceptance**

- Manual test matrix: trigger `DMG-E010` (simulate disabled storage in DevTools) → correct code.
- Help tab links to “Understanding error codes” section.

**Design gaps to close**

- **Tone:** Staff-friendly one-liners; technical detail collapsed under “Details”.
- **Admin vs staff:** Staff see recovery steps; admin sees config hints (`DMG-E031`) without exposing secrets.

---

### Slice 3 — Storage resilience

**Status:** Partial — probes, quota warn, corrupt-key detection; **Help** can paste JSON to repair one corrupt key (**BL-08** done); remove-all-keys still available from banner. `save()` in `App.jsx` already catches `QuotaExceededError` → DMG-E011 toast. **`_logoOverrides` scan gap fixed** (BL-13 done — key added to `STORAGE_SCAN_KEYS`).

**Objective:** Graceful behavior when storage is full, disabled, or corrupt.

**Scope**

- On startup: probe `localStorage` + estimate quota where supported; set global flag `storageHealth`.
- `DMG-E011`: detect `QuotaExceededError` on save; prompt export flow.
- `DMG-E012`: isolate corrupt keys; offer “reset key” vs full reset with backup prompt.

**Acceptance**

- Export offered before destructive reset.
- Corrupt single key does not blank entire app if recoverable.

**Backlog / defer**

- **IndexedDB migration** for large datasets—only if invoice/item counts justify complexity.

---

### Slice 4 — CDN elimination for app shell (optional vendor pass)

**Status:** Partial — No CDN for runtime app shell. **Recharts** is lazy-loaded only when Daily Finance / Analytics / Price History charts render (`src/charts/*.jsx` dynamic imports → separate chunk ≈565KB loaded on demand, not on initial route).

**Objective:** If any runtime libs remain external (charts, xlsx, jszip), vendor them into the bundle or self-host alongside GitHub Pages.

**Scope**

- Tree-shake or further split chart entry points if bundle size becomes an issue.
- Document remaining external origins if any (should be none for core path).

**Acceptance**

- Lighthouse / network panel: **zero** blocking third-party scripts for first interactive shell (charts may lazy).

---

### Slice 5 — Auth and backend contract hardening

**Status:** Partial — `src/apiErrors.js` classifies fetch/HTTP failures; auth and scan/attendance APIs report **DMG-E020–E031**. **Offline banner** (`navigator.onLine` via `useOnlineStatus`). Settings backup **ZIP export/import** failures → toast + **DMG-E041** (no blocking `alert`). **BL-15 done (Slice 8):** Check In/Out and Scan DB tabs show `BackendUnavailableBanner` with DMG code instead of raw error toasts. **BL-18 partial done:** Scan DB tab has a "Download Scan DB Backup" button calling `/api/scan/export`.

**Objective:** Predictable behavior when Render backend or central auth is down.

**Scope**

- Offline banner when `navigator.onLine` is false — **done** (`useOnlineStatus`, blue banner on login + main).
- Map fetch failures to `DMG-E021` / `DMG-E030`; distinguish timeout vs HTTP error body if API sends codes later.

**Design gap**

- **Conflict resolution:** If two devices edit same export—defer explicit merge UI; backlog item **“export merge wizard”**.

---

### Slice 6 — Browser support matrix and guardrails

**Status:** Partial — **`getBootCapabilityWarnings`** (`src/browserCaps.js`, Vitest): missing **`crypto.subtle`** → DMG-E050/E051; missing **`structuredClone`** → extra DMG-E050 banner. Same banners on **login** and main shell; **Help** documents browsers + offline behavior.

**Objective:** Fail fast with `DMG-E050` / `DMG-E051` instead of obscure runtime errors.

**Scope**

- Feature checks at boot: `crypto.subtle`, **`structuredClone`** (needed for some structured-copy paths).
- Document supported browsers in README and Help.

---

---

## Slices 7–11 — active queue

### Slice 7 — Crash recovery (DMG-E003) ✅ Done

**Status:** Done — `src/ErrorBoundary.jsx` class component wraps `<App>` in `main.jsx`. Post-mount render errors show a recovery card (Refresh + Copy diagnostics) and emit DMG-E003 via `reportError`. Closes BL-12; completes Slice 2.

**Scope**
- `src/ErrorBoundary.jsx` — `getDerivedStateFromError` + `componentDidCatch` → `reportError(‘DMG-E003’)`; renders `boot-fatal` recovery card with Refresh + Copy diagnostics buttons.
- `src/main.jsx` — wrap `<ToastProvider><App/></ToastProvider>` inside `<ErrorBoundary>`.

**Smoke test**
1. In any tab body temporarily add `throw new Error(‘boundary test’)`.
2. Expect: recovery card with heading “Something went wrong”, DMG-E003 code visible, Refresh button reloads, Copy diagnostics copies JSON.
3. No blank screen, no uncaught React error in console.

---

### Slice 8 — Backend resilience ✅ Done

**Status:** Done — `BackendUnavailableBanner` added to `src/ReliabilityBanners.jsx` (amber, DMG-E021). Both `CheckInOutPage` and `ScanDatabaseBeta` now accept `isOnline` prop and track `backendDown` state; banner renders when either flag is true. Scan DB already had an “Export Backup” button — noted as present. **Critical data-loss bug fixed:** backup ZIP was missing `transferInvoices`, `payrollInvoices`, and `dailyFinanceEntries`; export payload bumped to `version:'2.1'`; import restores all three. Settings data summary now counts all four invoice types. `appState` updated to include the missing state vars.

---

### Slice 9 — Archive pagination ✅ Done

**Status:** Done — `InvoiceArchive` now has `page` + `pageSize` state; `paginated` slice replaces full `filtered.map`; page controls (← Prev / page X of N / Next →) render when `totalPages > 1`; per-page selector (10/25/50) persisted in `_archivePageSize` localStorage key; `useEffect` resets to page 1 on any filter change.

---

### Slice 10 — Security hardening ✅ Done

**Status:** Done — `hashPwd(pwd, username=’’)` now accepts an optional username salt: input is `${pwd}:${username.toLowerCase()}` when username is provided, plain `pwd` otherwise (backward-compat). `handleLogin` tries the salted hash first, then falls back to the legacy no-salt hash; on a legacy match it silently upgrades the stored credential to the salted form and updates `_rememberedCheckinLogin`. `addUser` and `saveUserPwd` now pass the username to `hashPwd`. `saveResetCode` / `handleQuickAdminReset` intentionally kept unsalted (standalone PIN, not a user-linked credential). `_seq` comment added to `App.jsx` (BL-20 done).

---

### Slice 11 — Logo file upload ✅ Done

**Status:** Done — Settings logo section now renders a `📁 Upload file` button alongside each URL field. `handleLogoFile(key, file)` reads the file as a data-URL via `FileReader`; files over 500 KB are rejected with a DMG-E040 toast. When a data-URL is loaded the URL text field is hidden (button label changes to “✓ File loaded”). Data-URLs are included in the backup ZIP's `settings.json` → survive export/import round-trip. `_archivePageSize` added to storage docs.

---

---

### Slice 12 — QR code self-hosting (remove external CDN)

**Status:** Done — `qrcode` npm package installed. `import QRCode from 'qrcode'` added to `App.jsx`. `qrDataUrl` state driven by `useEffect(() => QRCode.toDataURL(qr.url)...)`. All `<img src={qrImageUrl}>` references replaced with `qrDataUrl`. `api.qrserver.com` call removed entirely. Bundle size increase ~25 KB min+gz (acceptable).

**Problem:** `CheckInOutPage` builds kiosk QR images from `https://api.qrserver.com/v1/create-qr-code/…` — an external CDN call. If that service is unavailable or blocked on a corporate network, the kiosk station shows a broken image silently. This is the only remaining external CDN dependency in the app shell (Recharts is already self-hosted; the QR URL is the sole external call after Slice 4).

**Scope (BL-21)**
- Add [`qrcode`](https://www.npmjs.com/package/qrcode) (small, maintained, zero-CDN) as a dependency: `npm install qrcode`.
- Replace the `qrImageUrl` string with a `useEffect` that calls `QRCode.toDataURL(qr.url)` → sets a `qrDataUrl` state.
- Remove the `https://api.qrserver.com` fetch entirely.
- Add `qrcode` to the Vite bundle (it is small, ~25 KB min+gz).

**Acceptance**
- Kiosk QR renders with no outbound request to api.qrserver.com (verify in Network tab).
- QR still refreshes every 60 s as before.
- `npm run build` with `qrcode` added shows no significant bundle size regression.

---

### Slice 13 — Backup version migration helper

**Status:** Done — `runBackupImport` reads `version.json` from the ZIP (falls back to `'1.0'` if absent). For backups with version `< 2.1`, after restoring, a `warn` toast lists whichever of Transfer Invoices / Payroll Invoices / Daily Finance Entries were absent from the ZIP and notes they are unchanged on device.

**Problem:** Backup ZIPs exported before the Slice 8 fix (version `2.0`) are missing `transferInvoices`, `payrollInvoices`, and `dailyFinanceEntries`. Restoring an old v2.0 ZIP silently omits these three datasets — user sees no warning, transfer history appears to vanish.

**Scope (BL-22)**
- In `runBackupImport`, read the `version` field from `version.json`.
- If version is `< 2.1`, show a warning toast after restoring: lists the missing keys and notes they remain unchanged on device.
- Do not overwrite those three keys if they are absent from the ZIP (current behaviour already does this — warning makes it explicit).

**Acceptance**
- Restoring a v2.0 ZIP shows the version-gap warning.
- Restoring a v2.1 ZIP shows no warning.
- Transfer/payroll data on device is never silently zeroed.

---

### Slice 15 — Editable business contact info in Settings (BL-27) ✅ Done

**Status:** Done — `_bizContact` localStorage key (JSON keyed by business ID) stores admin-editable phone/address/email overrides per business. `mergeBrandingWithOverrides` merges them on top of `BRANDING` defaults. `_bizContact` is included in Settings backup ZIP (v2.2) and restored by `runBackupImport`. `BIZ_CONTACT_KEY` is in `STORAGE_SCAN_KEYS`. All invoice view/print modals show the updated contact info.

**What was implemented:**
- `BIZ_CONTACT_KEY = '_bizContact'` in `src/constants.js`.
- `SettingsModal` in `App.jsx`: "Business Contact Info" section with phone, address, email fields per business; saved immediately on change.
- `mergeBrandingWithOverrides` updated to merge `bizContact` overrides on top of `BRANDING`.
- Backup ZIP v2.2 includes `bizContact`; restore path handles `settings.bizContact`.
- `BIZ_CONTACT_KEY` added to `STORAGE_SCAN_KEYS` in `src/storageHealth.js`.

---

## Epics (own planning cycle)

Large items that need their own kick-off before breaking into slices.

| ID | Epic | Key decision needed | Est. size |
|----|------|--------------------|-----------| 
| **Epic A** (BL-17) | **Multi-business data namespace** | Shared catalog intentional? Invoices per-business? `_lastBiz` filter vs. scoped keys? | Large if scoped keys chosen |
| **Epic B** (BL-18 full) | **Payroll ↔ Scan DB integration** | Are they the same system or separate? Auto-link scanned payroll PDFs to invoice entries? | Medium |
| **Epic C** (BL-07) | **App.jsx extraction** — all major tabs extracted to `src/tabs/`; shared utilities in `src/utils/` and `src/ui/BrandMark.jsx`; App.jsx is now shell-only | **Done** — see Slice 16 below | Large mechanical |
| **Epic D** (BL-01/02) | **COGS / Recipe costing** — recipe yields, waste %, period COGS reports, supplier price alerts | Per-business or global recipe catalog? Tax incl/excl for margins? | Very large |

---

## Deferred / done index

| ID | Item | Status |
|----|------|--------|
| BL-03 | Import merge wizard | Deferred — Slice 5 follow-up |
| BL-04 | IndexedDB + sync | Deferred — only if quota issues recur |
| BL-05 | Admin error telemetry dashboard | Deferred — post Slice 2 |
| BL-08 | Per-key corrupt repair (Help) | **Done** |
| BL-10 | Vitest suite | **In progress** — apiErrors, constants, storageHealth, formatters, browserCaps covered |
| BL-11 | Logo URL overrides + file upload (Settings) | **Done** — Slice 11 |
| BL-12 | React Error Boundary + DMG-E003 | **Done** — Slice 7 |
| BL-13 | `_logoOverrides` in STORAGE_SCAN_KEYS | **Done** |
| BL-14 | `uid()` → `crypto.randomUUID()` | **Done** |
| BL-15 | Backend tab offline degradation | **Done** — Slice 8 |
| BL-16 | Invoice archive pagination | **Done** — Slice 9 |
| BL-19 | Password hash hardening (username salt) | **Done** — Slice 10 |
| BL-20 | Document `_seq` key | **Done** — Slice 10 |
| BL-21 | QR code self-hosting (remove api.qrserver.com) | Done → Slice 12 |
| BL-22 | Backup version migration warning (v2.0 ZIPs) | Done → Slice 13 |
| BL-23 | Business contact info on invoices (phone/address/email) | **Done** — Slice 14 |
| BL-24 | Per-business invoice filtering (UI) | **Done** — Slice 14 |
| BL-25 | Invoice tabs admin-only auth restriction | **Done** — Slice 14 |
| BL-26 | Manual payroll invoice creation + edit (PayrollInvoices tab) | **Done** — Slice 14 |
| BL-27 | Editable BRANDING contact info in Settings | **Done** — Slice 15 |
| BL-28 | Customer address field on catering invoices | **Done** — Slice 14 |
| BL-29 | DMG codes on form validation toasts | **Done** — Slice 17 |
| BL-30 | Vitest coverage for `src/utils/` modules | **Done** — Slice 17 |
| BL-31 | Item quantity tracking + low-stock alerts | Queued — Slice 18 |
| BL-32 | Invoice duplicate/copy | Queued — Slice 18 |
| BL-33 | Customer invoice history panel | **Done** — already in CustomerManagement |
| BL-34 | Date range shortcuts in Archive + Daily Finance | Queued — Slice 18 |
| BL-35 | Items bulk import from CSV/Excel | Queued — Slice 18 |

---

## Slice 14 — Business identity, auth hardening, payroll manual entry

---

## Slice 16 — Epic C: App.jsx full tab extraction + shared utility modules (BL-07)

**Status:** Done — all major tab components extracted from App.jsx to `src/tabs/`; shared utility modules created in `src/utils/` and `src/ui/`; large UI components (`SettingsModal`, `LoginScreen`, `FirstRunSetup`, `AdminResetPortal`) extracted to `src/ui/`.

**What was implemented:**

- **Shared utility modules:** `src/utils/storage.js` (`load`, `save`, `uid`, `today`), `src/utils/activity.js` (`logActivity`), `src/utils/print.js` (`printHtmlDocument`, `printInvoiceById`, `documentBaseHref`, `rewriteImgSrcsForPrint`), `src/utils/invoiceIds.js` (`nextId`, `nextTransferId`, `normalizeTransferInvoice`), `src/ui/BrandMark.jsx` (`BrandMark` component).
- **Tab extractions (16 total):** ActivityLog, ScanDatabaseBeta, CustomerManagement, DailyIncomeExpense, PayrollInvoices, CheckInOutPage, MenuMarginsLab, ItemDatabase, ShoppingList, PurchaseInvoices, CateringInvoices, TransferInvoices, InvoiceArchive, Analytics, PriceHistory, PriceUpdater — all in `src/tabs/`.
- **UI component extractions:** `SettingsModal`, `LoginScreen`, `FirstRunSetup`, `AdminResetPortal` extracted to `src/ui/`; shared module-level auth/backend helpers extracted to `src/authHelpers.js`.
- **App.jsx reduced:** from ~5900 lines to ~700 lines (shell only: routing, `getInvoiceBranding`, `SetupQuickActions`, `ProfileModal`, and `App` component).
- **`getInvoiceBranding` stays in App.jsx** and is passed as a prop to invoice tabs (depends on imported `BRANDING` + `mergeBrandingWithOverrides` from `authHelpers.js`).
- **85 Vitest tests passing** after extraction.

---

**Status:** Done — multi-feature slice addressing business contact info on invoices, per-business filtering, admin-only access, and standalone payroll invoice management.

**What was implemented:**

- **BRANDING expanded:** `phone`, `address`, `email` fields added to all four brand entries in `App.jsx`; all invoice view/print modals (Purchase, Catering, Transfer, Archive) now show full business header.
- **Customer address:** `customerAddress` field added to catering invoice form, save paths, and view display (BL-28).
- **Per-business filtering:** Purchase and Catering invoice tabs now default to the selected business with an "All businesses" checkbox toggle. Archive tab has a Business dropdown filter (defaults to selected business).
- **Auth hardening (BL-25):** `catering` and `archive` tabs now require `isAdmin`. Non-admin `ALL_USER_TABS` no longer includes any invoice tab — staff see only Check In/Out, Shopping, Items, Price Updater, Daily Finance, Help.
- **Payroll Invoices tab (BL-26):** New `src/tabs/PayrollInvoices.jsx` component — first tab extracted to `src/tabs/`. Features: list with business filter, create form (employee name, business, pay period type, start/end date, hourly rate, regular/overtime hours, live pay preview), view modal with business branding header, edit, mark paid, delete, print. Payroll records use `invoiceStandard: 'PAYROLL_MANUAL_V1'` to distinguish from auto-generated weekly records.
- **Transfer tab rename:** "P&P Transfer Inv." → "Transfer Inv." (BL-17 partial).
- **Tests:** constants.test.js expanded to 6 tests; 51 total passing.

---

## Slice 17 — Utility tests + DMG validation codes (BL-29, BL-30) ✅ Done

**Status:** Done.

**What was implemented:**

- **`src/utils/storage.test.js`** (11 tests): `load`, `save` (including quota/DMG-E011 and generic/DMG-E010 error paths), `uid` UUID v4 format, `today` YYYY-MM-DD format.
- **`src/utils/invoiceIds.test.js`** (16 tests): `nextId` sequential P-/C- IDs with 4-digit padding and localStorage persistence; `nextTransferId` PPH-ENG-{date}-{seq} format; `normalizeTransferInvoice` — defaults, from/to override, commission math, legacy `unitPrice` field, explicit commission preservation, empty lineItems, auto-ID generation.
- **DMG-E006 on form validation toasts (BL-29):** 13 validation toasts across ItemDatabase, PurchaseInvoices, CateringInvoices, CustomerManagement, TransferInvoices, DailyIncomeExpense, MenuMarginsLab, PayrollInvoices now append `[DMG-E006]` — completes Slice 2 optional item.
- **Total tests: 79** (up from 52 before Slice 17).

---

## Open design questions

1. **Support channel:** Single email vs in-app only? (Affects diagnostics copy format.)
2. **Admin reset:** When `DMG-E012` triggers, is backend reset always allowed or device-local only?
3. **COGS (Epic D / BL-01):** Per-business recipes vs global catalog? Tax inclusive/exclusive for margin?
4. **Multi-business (Epic A / BL-17):** Shared item/customer catalog is intentional. Invoice filtering is now UI-level (by `business` field on each record). Scoped localStorage keys remain deferred unless scale demands it.

---

## Slice 18 — Inventory & invoicing quality-of-life features

**Status:** Queued — pending design decisions on item quantity model.

### BL-31 — Item quantity tracking + low-stock alerts

**Problem:** Items have no quantity fields. Admins have no way to see current stock levels or get notified when stock is low.

**Scope:**
- Add `currentQty` (number, default `null` = not tracked) and `minQty` (number, default `null`) fields to the item schema.
- ItemDatabase form: two new optional numeric inputs ("Current Qty" and "Min Qty / Reorder Point").
- When `currentQty != null && minQty != null && currentQty <= minQty`, show a red ⚠ badge on the item row.
- ShoppingList: "Add low-stock items" button pre-fills the list with all items where `currentQty <= minQty`.
- PurchaseInvoices: "Receive stock" action updates item `currentQty` when invoice is marked received.
- Items table in AGENTS.md: add `currentQty`, `minQty` field descriptions.

**Files touched:** `src/tabs/ItemDatabase.jsx`, `src/tabs/ShoppingList.jsx`, `src/tabs/PurchaseInvoices.jsx`, `AGENTS.md`

**Acceptance:** After setting minQty=5 on an item with currentQty=2, a red badge appears; "Add low-stock items" populates ShoppingList with that item.

---

### BL-32 — Invoice duplicate/copy

**Problem:** Recurring catering events require re-entering the same invoice details every time.

**Scope:**
- Add a "Copy" button to all invoice view modals (Purchase, Catering, Transfer, Payroll).
- Opens the create form pre-filled with the invoice data; date resets to today; status resets to `unpaid`.
- A new ID is assigned on save (copy does not re-use the original ID).

**Files touched:** `src/tabs/CateringInvoices.jsx`, `src/tabs/PurchaseInvoices.jsx`, `src/tabs/TransferInvoices.jsx`, `src/tabs/PayrollInvoices.jsx`

**Acceptance:** "Copy" on a catering invoice opens the create form with all fields pre-filled except date and status; saving creates a new invoice with a new C-xxxx ID.

---

### BL-33 — Customer invoice history in CustomerManagement

**Problem:** Viewing all invoices for a specific customer requires filtering manually in the Archive tab.

**Scope:**
- In CustomerManagement, add a "View Invoices" link per customer.
- Clicking opens a read-only modal listing all catering invoices for that customer (by matching `customerName` or a future `customerId`), sorted by date descending.
- Show totals: count, sum paid, sum unpaid.

**Files touched:** `src/tabs/CustomerManagement.jsx`

**Acceptance:** Clicking "View Invoices" for a customer shows a list of their catering invoices with subtotals; "No invoices found" shown if none.

---

### BL-34 — Date range shortcuts in Archive and Daily Finance

**Problem:** Filtering by "last 30 days" or "this month" requires manually entering two dates each time.

**Scope:**
- Add preset buttons: "Last 7 days", "Last 30 days", "This month", "Last month", "Clear" next to date-from/date-to filters in InvoiceArchive and DailyIncomeExpense.
- Active preset highlighted; clearing either date field deactivates the preset.

**Files touched:** `src/tabs/InvoiceArchive.jsx`, `src/tabs/DailyIncomeExpense.jsx`

**Acceptance:** Clicking "Last 30 days" sets the date filters to today minus 30 days / today; the filter result updates immediately.

---

### BL-35 — Items bulk import from CSV

**Problem:** Initial setup of dozens of items is slow via the one-by-one form.

**Scope:**
- Import button in ItemDatabase opens a file picker for `.csv` or `.xlsx`.
- Expected columns: `name`, `category`, `unit`, `upc` (optional), `seller`, `price` (optional).
- Rows with a matching name update the existing item's sellers list; new names create new items.
- Preview step shows parsed rows with "Add X items, update Y" before committing.
- Errors (missing name, bad price) shown per-row; partial import allowed.

**Files touched:** `src/tabs/ItemDatabase.jsx`

**Acceptance:** Uploading a CSV with 5 new items and 2 updates: preview shows "Add 5, update 2"; confirming creates/updates them; activity log records the import.

---

### BL-36 — Export item database as CSV/Excel ← DONE Slice 20

**Problem:** No way to back up or share the item catalog outside the app.

**Scope:**
- "⬇ Export CSV" button in ItemDatabase header (admin-only).
- Exports all items: name, category, unit, upc, seller (first), price (first), per-location qty/min columns, notes.
- Round-trip compatible with BL-35 import format.

**Files touched:** `src/tabs/ItemDatabase.jsx`

---

### BL-37 — Purchase invoice → update stock levels ← DONE Slice 20

**Problem:** Receiving a purchase order doesn't automatically increment stock.

**Scope:**
- "📦 Stock" button on each purchase invoice row (admin-only).
- Opens a modal: select location (Englewood/Hackensack), shows matched items with qty increment preview.
- Matched by line item description = item name (case-insensitive).
- Unmatched items shown as warning; partial match allowed.
- On confirm, increments `locQty[location]` for each matched item.

**Files touched:** `src/tabs/PurchaseInvoices.jsx`, `src/App.jsx` (`setItems` prop added)

---

### BL-38 — Custom categories ← DONE Slice 21

**Problem:** `CATEGORIES` is hardcoded; users can't add industry-specific categories without a code change.

**Scope:**
- Admin can add/remove custom categories in Settings → "🏷️ Item Categories" section.
- Built-in categories shown as read-only chips; custom categories shown with × remove button.
- Persisted as `_customCategories` in localStorage; merged with CATEGORIES at runtime via `useMemo`.
- ItemDatabase category dropdown, filter, and import validation all use the merged list.

**Files touched:** `src/constants.js` (CUSTOM_CATEGORIES_KEY), `src/ui/SettingsModal.jsx`, `src/tabs/ItemDatabase.jsx`

---

### BL-42 — Quick inline stock adjustment (+/−) per location ← DONE Slice 21

**Problem:** Updating stock required opening the full item edit form, even for simple +1/−1 adjustments.

**Scope:**
- ItemDatabase table Stock column shows + and − buttons beside each location's qty (admin-only).
- Clicking instantly increments/decrements locQty, saves to localStorage, and logs activity.
- Non-admin users see qty read-only as before.
- Also added category filter dropdown beside the search bar (all users).

**Files touched:** `src/tabs/ItemDatabase.jsx`

---

### BL-39 — Inventory adjustment log ← DONE Slice 22

**Problem:** No audit trail for manual stock changes (receiving, waste, corrections).

**Scope:**
- New "📝 Inv. Log" tab (admin-only) in the Stock nav group.
- Form: item (searchable datalist), location (Englewood/Hackensack), qty delta (+/-), reason (Received/Used/Waste/Correction/Transfer/Other), optional notes, date.
- On save: creates adjustment record in `_inventoryAdjustments`, updates `item.locQty[location]` immediately.
- Table view: all adjustments sorted newest-first with filters for item, location, reason.
- Delete: removes log entry only (does NOT reverse the stock change — audit trail integrity).

**Files touched:** new `src/tabs/InventoryAdjustments.jsx`, `src/App.jsx`, `src/constants.js` (INVENTORY_ADJUSTMENTS_KEY, TABS_ADMIN, NAV_GROUPS_ADMIN)

---

### BL-40 — Location-aware inventory (Englewood + Hackensack) ← DONE Slice 19

**Problem:** Items had a single global quantity; business operates across two locations.

**Scope:**
- `LOCATIONS = ['Englewood', 'Hackensack']` constant added.
- Item form: per-location Qty + Min fields in "Stock by Location" section.
- Low-stock detection checks both per-location and legacy scalar fields.
- Shopping list "Low Stock" button includes location-based low items.
- Legacy `currentQty`/`minQty` retained as fallback (shown under `<details>`).

**Files touched:** `src/constants.js`, `src/tabs/ItemDatabase.jsx`, `src/tabs/ShoppingList.jsx`

---

### BL-41 — Price memory (auto-fill last purchase price) ← DONE Slice 19

**Problem:** Creating a purchase invoice required re-entering prices for every line, even for frequently purchased items.

**Scope:**
- When description field matches an item name (case-insensitive), auto-fills unit price from item's sellers data.
- Supplier name matched first; falls back to first seller.
- Also fixes missing `Confirm` import in PurchaseInvoices (was a runtime bug).

**Files touched:** `src/tabs/PurchaseInvoices.jsx`

---

### BL-45 — Reorder point auto-suggest ← DONE Slice 23

When editing an item that has ≥2 purchase invoice line matches, the edit form shows a green banner: "Based on N purchases (avg X unit/order) — suggested reorder point: Y unit" with a "Use suggestion" button. Clicking fills all per-location min-qty fields with the suggested value (50% of average purchase qty).

**Files:** `src/tabs/ItemDatabase.jsx`, `src/App.jsx` (passes `purchaseInvoices` prop)

---

### BL-46 — Inter-location stock transfer ← DONE Slice 23

"Transfer Stock Between Locations" card in the Inventory Adjustment Log tab. Creates two atomic adjustment records (debit from source, credit to destination). Notes on each record show direction ("Transfer to Hackensack" / "Transfer from Englewood"). Logs `transfer_stock` activity.

**Files:** `src/tabs/InventoryAdjustments.jsx`

---

### BL-47 — Shopping list notes column ← DONE Slice 23

Notes text input added as a column in the shopping list table. Notes are persisted to localStorage and exported in CSV output.

**Files:** `src/tabs/ShoppingList.jsx`

---

### BL-48 — Dashboard / inventory overview tab ← DONE Slice 24

New "🏠 Dashboard" tab (admin-only), first in Stock nav group. Stat cards: total items (clickable → Items tab), low stock count (red when > 0), inventory value estimate (sum locQty × first seller price), outstanding catering balance. Low-stock items table with item/location/qty/min columns. Recent activity feed (last 10 log entries). Purchases-this-month summary. "➕ Add all to Shopping List" button in low-stock section (Slice 26).

**Files:** `src/tabs/Dashboard.jsx` (new), `src/App.jsx`, `src/constants.js`

---

| BL-31 | Item quantity tracking + low-stock alerts | **Done** — Slice 18 |
| BL-32 | Invoice duplicate/copy | **Done** — Slice 18 |
| BL-33 | Customer invoice history panel | **Done** — already in CustomerManagement |
| BL-34 | Date range shortcuts in Archive + Daily Finance | **Done** — Slice 18 |
| BL-35 | Items bulk import from CSV/Excel | **Done** — Slice 19 |
| BL-36 | Export item database as CSV/Excel | **Done** — Slice 20 |
| BL-37 | Purchase invoice → update stock levels on receipt | **Done** — Slice 20 |
| BL-38 | Custom categories management in Settings | **Done** — Slice 21 |
| BL-39 | Inventory adjustment log (received/waste/correction) | **Done** — Slice 22 |
| BL-42 | Quick inline stock +/− adjustment per location in ItemDatabase | **Done** — Slice 21 |
| BL-43 | Shopping list: location context filter (which location am I buying for?) | **Done** — Slice 22 |
| BL-44 | Item search by seller name in ItemDatabase | **Done** — hotfix |
| BL-45 | Reorder point auto-suggest from purchase history | **Done** — Slice 23 |
| BL-46 | Inter-location stock transfer (atomic debit/credit) in Inv. Log | **Done** — Slice 23 |
| BL-40 | Location-aware inventory: Englewood + Hackensack per-location qty | **Done** — Slice 19 |
| BL-41 | Price memory: auto-fill last purchase price in invoices + shopping | **Done** — Slice 19 |
| BL-47 | Shopping list notes column | **Done** — Slice 23 |
| BL-48 | Dashboard / inventory overview tab | **Done** — Slice 24 |
| BL-49 | Mark invoice lines as received (partial receipt tracking) | **Done** — Slice 30 |
| BL-50 | Item purchase + adjustment history modal in ItemDatabase | **Done** — Slice 26 |
| BL-51 | Purchase invoices Excel export | **Done** — Slice 27 |
| BL-52 | Catering invoice price memory (same as purchase invoices) | **Done** — Slice 26 |
| BL-53 | Activity log CSV export | **Done** — Slice 26 |
| BL-54 | Price back-propagation: mark-paid updates item seller prices | **Done** — Slice 25 |
| BL-55 | Pricer tab accessible to admins (was missing from TABS_ADMIN) | **Done** — Slice 25 |
| BL-56 | Reorder auto-suggest "Use suggestion" button fills all locations | **Done** — Slice 23 |
| BL-57 | Vitest coverage for safePrice, safeQty, sellerKey, isLowStock, uid | **Done** — Slice 27 |
| BL-58 | Purchase invoice status filter (All/Unpaid/Paid) | **Done** — Slice 30 |
| BL-59 | Dashboard low-stock CSV export button | **Done** — Slice 30 |
| BL-60 | Purchase invoices outstanding balance banner | **Done** — Slice 30 |
| BL-61 | ItemDatabase sortable columns (Name, Category, Unit, Stock, Price) | **Done** — Slice 31 |
| BL-62 | Shopping list: mark-as-bought checkbox (session-only, struck-through style) | **Done** — Slice 31 |
| BL-63 | Catering invoice CSV export | **Done** — Slice 32 |
| BL-64 | Monthly spending chart in Dashboard (purchase totals by month) | **Done** — Slice 32 |
| BL-65 | Catering revenue monthly chart in Dashboard | **Done** — Slice 32 |
| BL-66 | Purchase invoice CSV export (complement to existing Excel) | **Done** — Slice 32 |
| BL-67 | Payroll invoices: CSV export + status filter + outstanding banner | **Done** — Slice 32 |
| BL-68 | Vitest tests for Dashboard utility functions (10 new tests) | **Done** — Slice 32 |
| BL-69 | Catering invoices: status filter + outstanding balance banner | **Done** — Slice 32 |
| BL-70 | CustomerManagement: CSV export + sort by revenue/invoice count | **Done** — Slice 33 |
| BL-71 | Dashboard: Inventory value by category (inline bar chart) | **Done** — Slice 33 |
| BL-72 | InventoryAdjustments: log activity on save and delete | **Done** — Slice 33 |
| BL-73 | Analytics: gross profit + margin % stat cards + revenue by event type | **Done** — Slice 34 |
| BL-74 | Catering invoice view: estimated ingredient cost + margin % banner | **Done** — Slice 34 |
| BL-75 | Shopping list: per-seller subtotal breakdown in total card | **Done** — Slice 35 |
| BL-76 | Purchase invoices: supplier text filter + date range (from/to) filter | **Done** — Slice 35+37 |
| BL-77 | Catering invoices: customer name filter + date range filter | **Done** — Slice 37 |
| BL-78 | Transfer invoices: status filter + CSV export | **Done** — Slice 36 |
| BL-79 | ItemDatabase: Notes column in items table | **Done** — Slice 36 |
| BL-80 | MenuMarginsLab: CSV export of menu items | **Done** — Slice 36 |
| BL-81 | PriceHistory: CSV export of price history | **Done** — Slice 36 |
| BL-82 | PayrollInvoices: monthly payroll bar chart (last 6 months) | **Done** — Slice 36 |
| BL-83 | Purchase invoices: "Add to DB" from unmatched items in stock modal | **Done** — Slice 38 |
| BL-84 | DailyIncomeExpense: CSV export | **Done** — Slice 39 |
| BL-85 | ItemDatabase: batch selection + bulk category change | **Done** — Slice 40 |
| BL-86 | Analytics: top customers by revenue bar chart | **Done** — Slice 41 |
| BL-87 | PayrollInvoices: collapsible per-employee summary table | **Done** — Slice 41 |
| BL-88 | PurchaseInvoices: optional due date field + overdue indicator | **Done** — Slice 41 |
| BL-89 | DailyIncomeExpense: edit existing entries in-place | **Done** — Slice 41 |
| BL-90 | Analytics: global date-range filter applied to all charts + stats | **Done** — Slice 42 |
| BL-91 | CateringInvoices: bulk mark-paid (checkbox + batch action bar) | **Done** — Slice 42 |
| BL-92 | New analyticsUtils.test.js: 20 tests (eventType, topCustomers, dateFilter, margin) | **Done** — Slice 42 |
| BL-93 | New payrollUtils.test.js: 14 tests (calcPayroll edge cases, employeeSummary) | **Done** — Slice 42 |
| BL-94 | Analytics: monthly net profit bar chart (green/red bars, respects date filter) | **Done** — Slice 43 |
| BL-95 | Dashboard: upcoming & overdue purchase invoices card (within 14 days or past due) | **Done** — Slice 43 |
| BL-96 | ItemDatabase: unit dropdown (PURCHASE_UNITS) + caseSize field for cases/bags | **Done** — Slice 44 |
| BL-97 | Fix: seller price silently dropped when seller name blank — now saved + retrievable | **Done** — Slice 44 |
| BL-98 | PurchaseInvoices: unit dropdown + case-size auto-price hint; price auto-fill trim fix | **Done** — Slice 44 |
| BL-99 | ShoppingList: unit dropdown per row with auto case↔unit price conversion | **Done** — Slice 44 |
| BL-100 | CateringInvoices: price auto-fill trim fix + price>0 guard + caseSize awareness | **Done** — Slice 44 |
| BL-102 | CateringInvoices: multiple partial payments (`payments` array, Payment History block) | **Done** — Slice 46 |
| BL-103 | PurchaseInvoices: bulk mark-paid (checkboxes, select-all, blue action bar, price back-propagation batch) | **Done** — Slice 45 |
| BL-104 | Dashboard: daily `_inventorySnapshots` + 7-day sparkline in inventory value stat card | **Done** — Slice 45 (simplified: daily snapshots + sparkline) |
| BL-106 | CateringInvoices view modal: "By Category" subtotal breakdown of line items | **Done** — Slice 45 |
| BL-107 | ActivityLog: action-type filter + keyword search + pagination (50/page) | **Done** — Slice 45 |
| BL-108 | PriceHistory: fix missing Confirm import (delete crashed) | **Done** — Slice 45 |
| BL-109 | ShoppingList: current stock level column (green/red/grey) at selected location | **Done** — Slice 45 |
| BL-110 | ItemDatabase: low-stock filter toggle in search bar | **Done** — Slice 46 |
| BL-111 | TransferInvoices: date-range filter + price auto-fill from item DB + logActivity on paid | **Done** — Slice 46 |

---

### Backlog items (deferred)

**BL-101 — Unit conversion calculator**
Allow switching between weight units (lb↔kg, oz↔g) with automatic price conversion. E.g., item stored in lb, user entering in kg — show the kg-equivalent price.
Files: `src/constants.js`, `src/tabs/ItemDatabase.jsx`, `src/tabs/PurchaseInvoices.jsx`

**BL-105 — Item barcode/UPC scanner integration**
On mobile/tablet, use the device camera to scan a UPC barcode and look up or add the item. Currently UPC is a manual text field.
Files: new `src/ui/BarcodeScanner.jsx`, `src/tabs/ItemDatabase.jsx`

**BL-112 — PriceUpdater: category filter + save all changes**
Add category dropdown filter to the PriceUpdater tab. Add "Save All Changes" button to save all pending price edits in one click (currently requires saving per item).
Files: `src/tabs/PriceUpdater.jsx`

---

## Slice 30 — Partial receipt + purchase invoice enhancements (BL-49, BL-58–BL-60) ✅ Done

**Status:** Done.

- **BL-49**: Stock update modal ("📦 Stock") now shows an editable "Receive" qty column per line item. Defaults to the invoiced quantity; edit down to receive partial shipments, set to 0 to skip a line. Renamed modal to "Receive Stock from Invoice".
- **BL-58**: Purchase invoices list now has a status filter dropdown (All statuses / Unpaid only / Paid only) in the header row.
- **BL-59**: Dashboard low-stock card now has a "⬇ Export CSV" button that downloads a CSV of all low-stock item/location rows.
- **BL-60**: Yellow outstanding balance banner appears above the purchase invoice list when any invoices are unpaid, showing total amount and invoice count.

**Files:** `src/tabs/PurchaseInvoices.jsx`, `src/tabs/Dashboard.jsx`

---

## Maintenance

Update this file when:

- A new error code is added or retired.
- A slice ships (move to Done in Slices 7–11, or mark epic slice complete).
- Backlog items graduate into a slice or are cancelled.

**Ops note:** Invoice logos 404’d after Vite migration until JPGs lived under **`public/assets/logos/`** (same relative paths as `BRANDING.logo` in `App.jsx`). Updating art: overwrite those files and redeploy.

# Architecture — Catering Inventory Manager

Status: live with users. Last reviewed against codebase commit on branch
`claude/backend-setup-error-LSHpX`. This is the "what's actually here, end
to end" doc — for slice history see `docs/PRODUCT_BACKLOG.md`, for the
AI-agent quick reference see `AGENTS.md`.

## 1. What this app is

A browser-first inventory + invoicing + payroll + analytics app for three
catering businesses run by the same owner: **DeGrill Inc** (Spring Valley,
NY), **Parathas and Platters Inc** (Hackensack, NJ), and **Dera Masala
Grill Inc** (Clifton, NJ). All three share a single deployment; the active
business is a UI filter, not a tenant boundary.

It is deployed as a static React/Vite SPA on GitHub Pages, with an
**optional** Node/Express backend on Render (and the same backend can run
on-prem on a Windows PC for scan-DB + attendance features that need
filesystem or local-LAN access).

The day-to-day flow it supports:

- staff sign in, scan a kiosk QR, and check in/out for shift time
- admin manages items, suppliers, customers, purchase invoices, catering
  invoices, transfer invoices (inter-location), payroll invoices, and
  shopping lists
- admin runs reports: daily income/expense, analytics, menu margin
  costing, price history, an activity log
- admin can drop scanned PDFs into a watched folder; the backend
  classifies them (invoice/payroll/legal/tax/bank/credit) and files them
  into a `Year/Month/DocType` library

## 2. High-level topology

```
                         ┌───────────────────────────────┐
                         │     GitHub Pages (static)     │
                         │   index.html  +  Vite bundle  │
   browser ──────────────┤   src/main.jsx → App.jsx       │
                         │   localStorage = primary DB    │
                         └──────────────┬────────────────┘
                                        │ optional fetch
                                        ▼
                         ┌───────────────────────────────┐
                         │  Render free-tier "auth API"  │
                         │  backend/server.js (Express)  │
                         │  data/*.json on disk          │
                         │   - credentials.json          │
                         │   - used-reset-tokens.json    │
                         │   - attendance-db.json        │
                         │   - scan-db.json              │
                         └───────────────────────────────┘
                                        │
                            same code can run on
                                        │
                         ┌───────────────────────────────┐
                         │  on-prem Windows PC backend   │
                         │  scheduled task (SYSTEM)      │
                         │  scans local PDF folder        │
                         └───────────────────────────────┘
```

There is one frontend and one backend image. Cloud vs. on-prem is just
"where the same `server.js` is running". Render handles auth + admin
reset + attendance for everyone over HTTPS; the on-prem instance is
expected when the admin wants Scan DB folder-watching against their own
files.

## 3. The frontend (React + Vite)

Entry chain: `index.html` → `src/main.jsx` (wraps `<App/>` in
`<ToastProvider>` and `<ErrorBoundary>`) → `src/App.jsx`.

### 3.1 What `src/App.jsx` actually does

It's the shell — ~800 lines (the AGENTS.md claim of "~700" is roughly
right). Specifically it owns:

- **session state** (`currentUser`, `_session` in localStorage)
- **business switcher** (`biz`, `_lastBiz`)
- **branding map** (merges hardcoded `BRANDING` from `authHelpers.js`
  with localStorage logo + contact overrides)
- **all top-level domain state** as `useState`: items, shopping,
  purchaseInv, transferInv, payrollInvoices, cateringInv, customers,
  suppliers, dailyFinanceEntries, priceHist, userPerms, kioskLock,
  staffQrPhase, staffAttToken, staffSessionTimer, profile, ...
- **routing** via a `tab` string and a `navGroup` string, gated by role
  (TABS_ADMIN vs ALL_USER_TABS) and kiosk lock
- **the QR scan gate** for check-in-only staff (`staffQrPhase`)
- **storage health probes** (DMG-E010/E011/E012 banners + a corrupt-key
  repair flow)
- **admin reset deep-link entry point** (renders `AdminResetPortal`
  before login if `?adminResetToken=...` is present — handled inside
  `LoginScreen` and `App.jsx`)
- **diagnostics** wiring (failure log, copy-to-clipboard, email)
- a `SetupQuickActions` first-run checklist
- the `ProfileModal` (display name + emoji icon)
- the four shared `Confirm` dialogs (logout, enter-kiosk,
  clear-corrupt-keys, etc.)

Each tab is its own file under `src/tabs/`. App passes the slices of
state each tab needs as props, plus a couple of cross-cutting helpers
(`getInvoiceBranding`, `scanApiCall`, `attendanceApiCall`).

### 3.2 Tab inventory

Admin-only unless noted. Files live in `src/tabs/`.

| Tab | File | Owns / mutates |
|-----|------|----------------|
| Dashboard | `Dashboard.jsx` | low-stock cards, upcoming events, attendance summary, snapshots |
| Check In/Out (staff + admin) | `CheckInOutPage.jsx` | calls `/api/attendance/*`; local cache in `_attendanceCache` |
| Items (staff + admin) | `ItemDatabase.jsx` | `items` + per-location qty + `_customCategories` |
| Inv. Log | `InventoryAdjustments.jsx` | `_inventoryAdjustments`; mutates `item.locQty` |
| Shopping (staff + admin) | `ShoppingList.jsx` | `shoppingList` + `_shoppingLoc` |
| Price Updater (staff + admin) | `PriceUpdater.jsx` | bulk updates `items[].sellers[].price` + appends `priceHistory` |
| Purchase Inv. | `PurchaseInvoices.jsx` | `purchaseInvoices`; can write back to `items` (stock + price) |
| Transfer Inv. | `TransferInvoices.jsx` | `transferInvoices` |
| Catering Inv. | `CateringInvoices.jsx` | `cateringInvoices` (multi-payment), can auto-create `customers` |
| Payroll Inv. | `PayrollInvoices.jsx` | `payrollInvoices` (multi-employee, period auto-calc) |
| Customers | `CustomerManagement.jsx` | `customers` |
| Suppliers | `SupplierManagement.jsx` | `_suppliers` (with discover-from-items) |
| Analytics | `Analytics.jsx` | derived from catering + purchase + daily |
| Daily Finance (staff + admin) | `DailyIncomeExpense.jsx` | `_dailyFinanceEntries` + `_incomeTaxRate` |
| Archive | `InvoiceArchive.jsx` | cross-type read of all four invoice tabs |
| Price History | `PriceHistory.jsx` | `priceHistory` |
| Menu Margins | `MenuMarginsLab.jsx` | `_menuRecipes`, derived from `items` + sellers |
| Activity Log | `ActivityLog.jsx` | `_activityLog` |
| Scan DB (Beta) | `ScanDatabaseBeta.jsx` | calls `/api/scan/*`; assumes local backend |
| Help (staff + admin) | `HelpCenter.jsx` | diagnostics + corrupt-key repair |

### 3.3 Shared modules

| File | Role |
|------|------|
| `src/main.jsx` | bootstrap, mounts providers |
| `src/constants.js` | `BUSINESSES`, tab + nav lists, all storage key names, unit type sets, default permissions |
| `src/authHelpers.js` | `hashPwd`, all `*ApiCall` helpers, branding constants, diagnostics, failure log |
| `src/formatters.js` | currency/date/bytes, `migrateShoppingList`, URL helpers |
| `src/utils/storage.js` | `load`/`save`/`uid`/`today` (canonical) |
| `src/utils/activity.js` | `logActivity` → `_activityLog` |
| `src/utils/errors.js` | `logFailure` → `_failureLog` |
| `src/utils/print.js` | `printHtmlDocument`, `rewriteImgSrcsForPrint` |
| `src/utils/invoiceIds.js` | `nextId`, `nextTransferId`, `normalizeTransferInvoice` |
| `src/utils/secureStore.js` | AES-GCM wrapper over localStorage (key itself stored alongside ciphertext) |
| `src/tabUtils.js` | **compatibility shim** — re-exports for tabs extracted before utils existed; should not gain new dependents |
| `src/apiErrors.js` | maps fetch + HTTP status → DMG-Exxx codes |
| `src/errors.js` | `reportError` ring buffer for support diagnostics |
| `src/browserCaps.js` | boot-time check for `crypto.subtle` + `structuredClone` |
| `src/storageHealth.js` | probe, quota estimate, corrupt-key scan |
| `src/toastContext.jsx` | global `showToast`/`toastApiFailure` |
| `src/ErrorBoundary.jsx` | catches DMG-E003 mount errors |
| `src/ReliabilityBanners.jsx` | offline + browser-caps + backend-unavailable banners |
| `src/useOnlineStatus.js` | `navigator.onLine` hook |
| `src/boot-watchdog.js` | DMG-E001 watchdog if React never mounts |
| `src/ui/*` | `Modal`, `Confirm`, `BrandMark`, `LoginScreen`, `AdminResetPortal`, `QrScanGate`, `FirstRunSetup`, `SettingsModal` |
| `src/charts/*` | `React.lazy` Recharts panels (split into their own chunk) |

### 3.4 Data model in localStorage

The primary database is the user's browser. There's no server-side
authoritative copy of items, invoices, etc. — the backend only holds
auth + reset tokens + attendance + scan-doc metadata. Backup/restore is
a manual ZIP from Settings.

Single-business view, but data is shared across businesses except where
noted. Records carry a `business` field for filtering.

**Shared across businesses (intentional, per AGENTS.md):**
`items`, `customers`, `_suppliers`, `priceHistory`.

**Per-business via record field, shared key:**
`purchaseInvoices`, `cateringInvoices`, `transferInvoices`,
`payrollInvoices`, `_dailyFinanceEntries`.

**UI / device state:**
`_session`, `_lastBiz`, `_shoppingLoc`, `_kioskLock`, `_archivePageSize`,
`_attendanceCache`, `_inventorySnapshots`, `_rememberedCheckinLogin`.

**Auth + reset state:**
`credentials` (username → `{password: SHA-256 hex hash, role,
displayName, permissions}`), `_userPermissions`, `_profiles`,
`_adminResetCodeHash`, `_adminResetApiBase`, `_dmg_mk` (secureStore
master key).

**Settings overrides:**
`_logoOverrides`, `_bizContact`, `_customCategories`, `_menuRecipes`,
`_incomeTaxRate`, `_staffSessionTimeout`, `_inventoryAdjustments`.

**Diagnostics:**
`_failureLog` (capped 500), `_activityLog` (capped 2000).

**Invariants worth knowing:**

- entity IDs are `crypto.randomUUID()` (new) or legacy `_xxxx` strings
- invoices are append-only in terms of identity; updates mutate in place
- a single `_seq` counter generates `INV-0042` style display IDs across
  invoice types (collisions are avoided by always reading-then-writing)
- the shopping list has gone through migrations; `migrateShoppingList`
  in `formatters.js` upgrades older row shapes lazily on read

### 3.5 Auth flow on the frontend

There are three login modes the same `LoginScreen` handles:

1. **No backend reachable, local creds exist** → log in against
   `credentials` in localStorage. SHA-256 of `pwd + ':' + username` is
   compared to the stored hash. If the legacy unsalted hash matches
   instead, the stored hash is silently upgraded (and sync'd back to
   backend in the background).
2. **Backend reachable, central auth on** → `POST /api/auth/login` with
   `{username, passwordHash}`. The backend returns
   `{user, credentialsSnapshot}` — **the response includes every user's
   hash**, which the client then writes to `credentials` (see Security
   Review §A2).
3. **Admin reset deep-link** (`?adminResetToken=...&adminResetReq=...`)
   → `AdminResetPortal` validates against `/api/admin-reset/validate`,
   then on submit calls `/api/admin-reset/complete` and writes the new
   hash to local `credentials`.

The kiosk QR gate (`QrScanGate.jsx`) sits between login and the
check-in screen for staff whose only permission is `checkio`. It uses
the device camera + `jsqr` to read a kiosk QR encoded with a JWT issued
by `/api/attendance/qr/create`, then validates against
`/api/attendance/qr/validate`. The token is single-use on
`/api/attendance/check`. Default TTL is 60s.

The session ends in one of: explicit sign-out, staff session-timer
expiry (default 120s after QR pass), kiosk-mode logout, or browser
close. Staff sessions auto-logout after a successful check-in or
check-out.

The auth header used for subsequent API calls (scan + attendance) is
`x-auth-user: <username>` + `x-auth-hash: <SHA-256 hex hash>`. The hash
IS the credential — there is no derived session token. This is the
biggest single security issue (see Security Review §A1).

### 3.6 Where the frontend learns the backend URL

Resolution order in `resolveResetApiBase` (`authHelpers.js:128`):

1. `public/auth-api-config.json` → `apiBase` (the prod URL — currently
   `https://catering-inventory-manager.onrender.com`)
2. caller-provided override
3. `?apiBase=...` / `?authApi=...` URL param
4. `_adminResetApiBase` from localStorage
5. hard-coded `ADMIN_RESET_API_ENDPOINTS` (localhost + 127.0.0.1)

All candidates are probed in parallel via `/health`; first 200-OK wins
and is cached to localStorage. 20-second timeout to absorb Render's
free-tier cold start.

## 4. The backend (`backend/server.js`)

Single file, ~754 lines, ES modules. Boots on `PORT` (default 8787),
default Render port from `render.yaml` is 10000. Refuses to start if
`ADMIN_RESET_JWT_SECRET` is missing or < 24 chars.

### 4.1 Data files (`backend/data/`)

| File | Contents | Auto-created |
|------|----------|---|
| `credentials.json` | `{username: {password, role, displayName, permissions}}` | yes |
| `used-reset-tokens.json` | `{used: [{jti, requestId, approver, usedAt}]}` (cap 2000) | yes |
| `attendance-db.json` | `{sessions, active, payRates, qrUsed, createdAt, updatedAt}` | yes |
| `scan-db.json` | `{config:{enabled,inboxPath,libraryPath}, docs, failures, known, activity, updatedAt}` | yes |

All files are read/written via `fs.readFileSync` / `fs.writeFileSync`
in process. Single-process Express, so no concurrent-write locking.

### 4.2 CORS

`app.use(cors({ origin(o, cb){ if (!o) return cb(null,true); ... } }))`
— `ALLOWED_ORIGIN` + `ALLOWED_ORIGINS` + localhost:5500. No-origin
requests (curl, server-to-server) are allowed unconditionally; CORS
does not (and cannot) protect endpoints with no auth.

### 4.3 Auth model on the backend

There are three styles of "auth" depending on the endpoint:

- **None**: `/health`, `/api/auth/status`, `/api/auth/login`,
  `/api/auth/sync` (!!), `/api/admin-reset/validate`,
  `/api/admin-reset/complete`.
- **`authUser` middleware** (`server.js:135`): reads `x-auth-user` +
  `x-auth-hash` from headers (or falls back to `req.body.auth.*`),
  compares hash to `credentials.json`. Used by `/api/attendance/me`,
  `/api/attendance/check`, `/api/attendance/qr/validate`.
- **`adminOnly` middleware** (`server.js:294`): same as `authUser`
  plus role check `=== 'admin'`. Used by `/api/scan/*` and
  `/api/attendance/admin/*` and `/api/attendance/qr/create`.

The "token" used for `authUser`/`adminOnly` is **literally the stored
password hash**. There is no session token, no expiry, no rotation.

### 4.4 Route table

| Method + Path | Auth | Purpose |
|---|---|---|
| GET `/health` | none | liveness probe |
| GET `/api/auth/status` | none | `{hasUsers, userCount}` |
| POST `/api/auth/login` | none | login; **returns full credentialsSnapshot** (§A2) |
| POST `/api/auth/sync` | **none (!)** | overwrites the whole users file (§A0) |
| POST `/api/attendance/qr/create` | adminOnly | mints attendance JWT, returns scan URL |
| GET `/api/attendance/qr/validate` | authUser | validates a scanned token |
| GET `/api/attendance/me` | authUser | own status + weekly hours |
| POST `/api/attendance/check` | authUser | check in / check out (single-use QR for self, admin can target others) |
| GET `/api/attendance/admin/summary` | adminOnly | weekly hours + pay per user |
| POST `/api/attendance/admin/pay-rate` | adminOnly | set hourly rate |
| POST `/api/attendance/admin/force-out` | adminOnly | force close an open session |
| GET `/api/scan/status` | adminOnly | scan job status + recent activity |
| POST `/api/scan/config` | adminOnly | set inboxPath + libraryPath + enabled |
| POST `/api/scan/scan-now` | adminOnly | trigger one scan pass |
| GET `/api/scan/search` | adminOnly | filter/search scan-db docs |
| POST `/api/scan/update/:id` | adminOnly | edit one doc's metadata |
| POST `/api/scan/bulk-tag` | adminOnly | bulk-update many docs |
| GET `/api/scan/export` | adminOnly | dump scan-db |
| POST `/api/scan/import` | adminOnly | restore scan-db from dump |
| POST `/api/admin-reset/validate` | none (token-bound) | check a reset JWT |
| POST `/api/admin-reset/complete` | none (token-bound) | mark reset jti used (does NOT write the new hash) |

### 4.5 Reset-link flow

`backend/tools/create-reset-link.js` is run manually on the box that
has the JWT secret. It mints a JWT with `{jti, requestId, source}` and
the configured TTL, then prints
`<FRONTEND_URL>?adminResetToken=<jwt>&adminResetReq=<reqId>`.

The recipient opens that link, lands on `AdminResetPortal`, which
calls `/validate` (server checks `jti` not in `used-reset-tokens.json`)
and then `/complete` (server marks `jti` used). The new password hash
is written into the **client's localStorage `credentials` only**. The
backend does NOT update `credentials.json` from this flow. The next
time admin logs in via central auth, the client's local `credentials`
get sync'd up to the backend through `/api/auth/sync` (which is itself
unauthenticated, see §A0).

This means a reset only sticks if (a) you reset on the device that's
already trusted, and (b) the post-reset auth/sync writes the new hash
to the server. There's no path that updates the server-side hash
directly from the reset link.

### 4.6 Scan job

`processScanOnce()` (`server.js:302`) walks the configured `inboxPath`
for `*.pdf`, skips files modified < `SCAN_MIN_FILE_AGE_MS`, computes
SHA-256, dedupes against known hashes, runs `pdf-parse` for ~50k
chars of text, classifies (`detectDocType` regex scoring), guesses
sender, slugifies a target name, and renames the file into
`libraryPath/<year>/<month>/<docType>/<...>.pdf`. A `setInterval`
timer is set up at `SCAN_POLL_MS` (default 8s) when `config.enabled` is
true.

`inboxPath` and `libraryPath` are admin-controlled strings with **no
validation, no allowlist, no chroot**. On Render this is moot (FS is
ephemeral, no PDFs in it). On the on-prem Windows install this is
admin-equivalent privilege, which is by design.

## 5. Windows on-prem deployment

`backend/windows/` contains the one-click installer and its
PowerShell helpers, plus the new `.cmd` wrappers added on this branch.
The installer:

1. resolves `backendDir` by walking up from `$PSScriptRoot`
2. downloads portable Node v22.14.0 zip from `nodejs.org` over HTTPS
   (no SHA verification) into `backend/runtime/node/`
3. creates `backend/.env` from `.env.example` if missing
4. generates a 48-byte base64url `ADMIN_RESET_JWT_SECRET` if the env
   value is still the placeholder
5. runs `npm install` in `backend/`
6. registers **two** Windows scheduled tasks:
   - `CateringAdminResetBackend-AtLogon` — `Interactive` /
     `Limited`-runlevel (current user)
   - `CateringAdminResetBackend-AtStartup` — `ServiceAccount` /
     `Highest`-runlevel (**SYSTEM**)

Both tasks run `start-backend.ps1` which starts `node server.js`. The
SYSTEM-level task is the source of a serious local-privilege-escalation
issue if the backend folder ends up in any user-writable path (which
it does by default when copied to a user profile — see Security Review
§A4).

## 6. Build, CI, and deploy

- Vite, React 18, Recharts (chunked separately), xlsx, JSZip.
- `vite.config.js` uses `base: './'` so hashed assets resolve under
  the GitHub Pages project subpath.
- `.github/workflows/deploy-pages.yml` deploys `dist/` to Pages on
  push to `master`; `ci.yml` runs Vitest + build on push/PR.
- `render.yaml` provisions the backend as a free-tier web service
  with `ADMIN_RESET_JWT_SECRET: generateValue: true`, so the Render
  instance and the on-prem instance have **different** JWT secrets.
  Reset links minted on one cannot be validated by the other.
- Vitest currently has 307+ unit tests across `*.test.js` files. No
  integration or end-to-end tests. No backend tests at all.

## 7. Intentional design vs. accidental shape

Per AGENTS.md and visible-in-code intent:

- shared `items` + `customers` across businesses — intentional, the
  same vendors and clients serve all three locations
- invoice keys all-in-one with a `business` filter field — intentional
- multi-payment `payments[]` array on catering invoices, with legacy
  `deposit` fallback — intentional backward compat
- per-location `locQty`/`locMinQty` overlaid on legacy scalar fields —
  intentional, scalars stay as fallback
- ID generators (`nextId`, `nextTransferId`) read then write the `_seq`
  counter every time — intentional but not atomic; works because the
  primary DB is local-only single-user

Likely accidental / grown-over-time:

- `src/tabUtils.js` is a compatibility shim still in use; tabs were
  extracted before the canonical utils existed and never fully
  migrated
- two copies of `auth-api-config.json` (`/auth-api-config.json` and
  `/public/auth-api-config.json`) — Vite copies `public/`, so the root
  copy is only needed if someone serves from the root statically. In
  practice they always have to match; nothing enforces that.
- `BRANDING` lives in `src/authHelpers.js` but per AGENTS.md historic
  text it lived in `App.jsx` for a long time; the helper file is now
  carrying domain constants it didn't originally
- `src/utils/errors.js` and `src/errors.js` coexist; `errors.js`
  (root) is the ring-buffer for diagnostics, `utils/errors.js` is the
  failure-log writer — different concerns, similar names
- the SYSTEM-level Windows scheduled task was added as a defensive
  measure but the privilege model wasn't reasoned through
- `_seq` and the `INV-0042` display ID are global across all invoice
  types; the per-type ID + display ID story isn't documented
- the `sanitizeCredentials` shape on `/api/auth/sync` accepts any
  caller because the auth check was missing — likely a forgotten TODO

## 8. What's clearly half-finished

Pulled from `docs/PRODUCT_BACKLOG.md` and code annotations. Most-cited
deferred work:

- **BL-18** auto-link Scan DB PDFs to existing invoice records —
  scanned payroll PDFs and `payrollInvoices` records are not connected;
  the link is a manual user mental step. AGENTS.md explicitly says
  "do NOT attempt to merge or auto-sync without explicit design work".
- **`pdf-parse` 1.1.1** classification heuristics — confidence
  thresholds are hardcoded, sender detection is best-effort, no
  feedback loop from corrections.
- **Scan DB UI in `ScanDatabaseBeta.jsx`** is labelled "Beta" / "WIP"
  in the status endpoint. There's no real failure-replay UI; failures
  pile up in `scan-db.json`.
- **Attendance**: weekly hours rollup uses local `getDay()` then
  emits UTC `toISOString().slice(0,10)`, which silently misclassifies
  Sunday-evening shifts in NY timezone (off-by-one). No timezone is
  configured anywhere.
- **QR gate UX edge cases**: 3-attempt lockout has no per-device or
  per-user reset; "locked" sends them back to login.
- **`render.yaml`** generates a fresh JWT secret on each new Render
  service, breaking any in-flight reset links if the service is
  rebuilt.
- **Admin reset on the server side never updates `credentials.json`.**
  The new hash only lands server-side via the subsequent sync.
- **No backend tests** anywhere.
- **`secureStore`** stores its own AES master key in the same
  localStorage it's "protecting" — it itself acknowledges this is
  "security in depth against casual inspection".
- **`auth-api-config.json` is duplicated** at repo root and in
  `public/`; nothing keeps them in sync.

## 9. Known scaling cliffs

The system was built for one owner, three locations, a handful of
staff, and an expected order of magnitude of "thousands of invoices,
hundreds of items, dozens of customers".

It will start breaking down when:

- a single localStorage payload approaches 5–10 MB (Chrome's per-origin
  cap is ~5 MB depending on version); the backup ZIP will hit this
  long before the storage cap, and `save()` will fall through to a
  `DMG-E011` toast
- multiple admins start editing concurrently — there's no merge
  strategy, last-writer-wins on a per-key basis on whatever device
  syncs to the backend last
- the scan-db `docs` array reaches the 20,000 cap and silently starts
  rotating
- a session token actually needs to be rotated — there's nowhere to
  rotate it
- a fourth business is added — `BUSINESSES`, the brand map, nav
  groups, and `mergeBrandingWithOverrides` all hard-code three keys

## 10. The shortest correct mental model

If you only remember five things:

1. **The browser is the database.** The backend exists for auth, reset
   tokens, attendance, and scan metadata. Everything else lives in
   localStorage and is backed up to a ZIP from the Settings panel.
2. **There is one tenant.** Three "businesses" are a filter on a
   `business` field; nothing isolates them at the storage layer.
3. **The password hash is the session token.** There is no derived
   credential, no expiry. Anyone holding the hash holds the account.
4. **Reset doesn't touch the server.** The reset link lets the client
   write a new local hash; the server only learns about it on the
   next unauthenticated `/api/auth/sync`.
5. **The on-prem backend runs as SYSTEM at startup.** Anywhere the
   backend folder is writable by a non-admin OS user is a local
   privilege-escalation primitive.

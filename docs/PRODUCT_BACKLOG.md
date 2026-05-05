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

**Status:** Partial — `src/errors.js`; Help tab diagnostics; **`ToastProvider`** + **`showToast`** (no `alert`). **`src/ui/Confirm.jsx`** for destructive choices (replaces **`window.confirm`**): staff delete, full backup restore, shopping list clear, activity log clear, menu item delete, sign out, kiosk mode, corrupt-key removal, **and tab delete flows** (items, invoices, customers, archive, transfer, price history) with **DMG-E012** on confirm where relevant. Optional: DMG codes on every validation toast. **DMG-E003 not yet wired** — see BL-12.

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

**Status:** Partial — `src/apiErrors.js` classifies fetch/HTTP failures; auth and scan/attendance APIs report **DMG-E020–E031**. **Offline banner** (`navigator.onLine` via `useOnlineStatus`). Settings backup **ZIP export/import** failures → toast + **DMG-E041** (no blocking `alert`). Attendance and Scan DB tabs still show raw error toasts when backend is unavailable — no graceful degraded state; see BL-15. Scan DB backup gap (data on backend not in main ZIP) — see BL-18.

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

### Slice 8 — Backend resilience

**Status:** Queued

**Scope (BL-15 + BL-18 partial)**
- When `useOnlineStatus()` is false **or** a backend fetch returns DMG-E021/E030, the **Attendance** (Check In/Out) and **Scan DB** tab bodies render a `BackendUnavailableBanner` (`src/ReliabilityBanners.jsx`) instead of a raw error toast. Kiosk lock state + local scan summary still visible.
- Add a **”Download Scan DB backup”** link in Help (or Settings) that calls `GET /api/scan/export` — guards against backend scan history being orphaned when the server resets.

**Acceptance**
- With backend URL misconfigured: both tabs show a banner citing DMG-E021; no orphan toasts.
- Admin opens Help → can download scan-db.json even while otherwise offline from the main UI.

---

### Slice 9 — Archive pagination

**Status:** Queued

**Scope (BL-16)**
- Extract `usePagination(items, pageSize)` hook (`src/hooks/usePagination.js`).
- Apply to Archive tab: page controls (← Prev / page X of N / Next →), keyboard-accessible.
- Page size selector (10 / 25 / 50); choice persisted in `settings` localStorage key.
- Filter/sort changes reset page to 1.

**Acceptance**
- With 100+ invoices: Archive tab renders instantly (first page only); navigation works.
- Page size survives page reload.

---

### Slice 10 — Security hardening

**Status:** Queued

**Scope (BL-19 + BL-20)**

**BL-19 — Password hash with username salt**
- `hashPwd(pwd, username)`: `SHA-256(pwd + ‘:’ + username.toLowerCase())` (deterministic, no stored-salt migration needed).
- Transition: on login attempt the old no-salt hash is tried first; on success, re-hash with salt and overwrite the stored credential.
- Update `backend/server.js` login check accordingly (backend receives the hash from the frontend — transparent).
- Document scheme in `AGENTS.md`.

**BL-20 — Document `_seq` key**
- Locate all `_seq` reads/writes in `App.jsx`; add a one-line comment on first write.
- Add `_seq` row to `AGENTS.md` storage key reference table (already done).

**Acceptance**
- Existing admin still logs in after deploy (old hash accepted, new hash re-stored).
- New password set after deploy uses salted hash.
- `grep ‘_seq’ src/App.jsx` shows an annotated usage.

---

### Slice 11 — Logo file upload (complete BL-11)

**Status:** Queued

**Scope**
- Add file input (or drag-drop zone) in the Settings “Invoice logos” section.
- On select: read file as data-URL; store in `_logoOverrides` alongside existing HTTPS URL fields.
- Cap file size at 500 KB; show DMG-E040 toast if exceeded.
- Round-trip: file data-URLs already survive ZIP backup/restore (embedded in `settings.json`).

**Acceptance**
- Admin uploads a JPG → logo appears on next invoice print without a redeploy.
- File > 500 KB → DMG-E040 toast, no crash.
- ZIP export then import → logo survives.

---

## Epics (own planning cycle)

Large items that need their own kick-off before breaking into slices.

| ID | Epic | Key decision needed | Est. size |
|----|------|--------------------|-----------| 
| **Epic A** (BL-17) | **Multi-business data namespace** | Shared catalog intentional? Invoices per-business? `_lastBiz` filter vs. scoped keys? | Large if scoped keys chosen |
| **Epic B** (BL-18 full) | **Payroll ↔ Scan DB integration** | Are they the same system or separate? Auto-link scanned payroll PDFs to invoice entries? | Medium |
| **Epic C** (BL-07) | **App.jsx extraction** — continued tab-by-tab extraction into `src/tabs/*.jsx` | Which tab extracts next? | Large mechanical (ongoing) |
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
| BL-11 | Logo URL overrides (Settings) | **Partial** — URL done; file upload → Slice 11 |
| BL-12 | React Error Boundary + DMG-E003 | **Done** — Slice 7 |
| BL-13 | `_logoOverrides` in STORAGE_SCAN_KEYS | **Done** |
| BL-14 | `uid()` → `crypto.randomUUID()` | **Done** |

---

## Open design questions

1. **Support channel:** Single email vs in-app only? (Affects diagnostics copy format.)
2. **Admin reset:** When `DMG-E012` triggers, is backend reset always allowed or device-local only?
3. **COGS (Epic D / BL-01):** Per-business recipes vs global catalog? Tax inclusive/exclusive for margin?
4. **Multi-business (Epic A / BL-17):** Is the shared item/customer catalog intentional across all three locations, or should DeGrill, Parathas, and Dera have isolated data stores?

---

## Maintenance

Update this file when:

- A new error code is added or retired.
- A slice ships (move to Done in Slices 7–11, or mark epic slice complete).
- Backlog items graduate into a slice or are cancelled.

**Ops note:** Invoice logos 404’d after Vite migration until JPGs lived under **`public/assets/logos/`** (same relative paths as `BRANDING.logo` in `App.jsx`). Updating art: overwrite those files and redeploy.

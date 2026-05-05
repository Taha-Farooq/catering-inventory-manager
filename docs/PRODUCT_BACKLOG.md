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

**Status:** Partial — `src/errors.js`; Help tab diagnostics; **`ToastProvider`** + **`showToast`** for user messages (including **`save()`** failures DMG-E010/E011 — no `alert`). Form validation and API toasts use the same stack. **Remaining:** `window.confirm` for destructive actions; optional DMG codes on every validation string.

**Objective:** Centralize errors; every categorized failure shows `DMG-Exxx` and structured detail for support.

**Scope**

- Small `reportError(code, context)` helper; optional ring buffer in sessionStorage for last N errors (privacy: no passwords).
- Replace scattered `alert()` on critical paths with modal/banner + code (keep `alert` only where unavoidable).
- “Copy diagnostics” includes: codes, app version/build hash, browser, storage available flag.

**Acceptance**

- Manual test matrix: trigger `DMG-E010` (simulate disabled storage in DevTools) → correct code.
- Help tab links to “Understanding error codes” section.

**Design gaps to close**

- **Tone:** Staff-friendly one-liners; technical detail collapsed under “Details”.
- **Admin vs staff:** Staff see recovery steps; admin sees config hints (`DMG-E031`) without exposing secrets.

---

### Slice 3 — Storage resilience

**Status:** Partial — probes, quota warn, corrupt-key detection; **Help** can paste JSON to repair one corrupt key (**BL-08** done); remove-all-keys still available from banner.

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

**Status:** Partial — `src/apiErrors.js` classifies fetch/HTTP failures; auth and scan/attendance APIs report **DMG-E020–E031**. **Offline banner** (`navigator.onLine` via `useOnlineStatus`). Settings backup **ZIP export/import** failures → toast + **DMG-E041** (no blocking `alert`).

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

## Remaining work — technical scope (not calendar estimates)

Rough **surface area / coupling** only:

| Area | What’s left | Scope |
|------|-------------|--------|
| **Slice 2** | Replace `window.confirm` with coded confirm modal; optional DMG on validation toasts | Medium |
| **Slice 3 defer** | IndexedDB migration | Large |
| **Slice 5** | Richer API response bodies; remaining alerts → toast | Medium–small |
| **Slice 6** | Optional extra probes (e.g. StorageManager) | Small |
| **BL-01 COGS** | Recipes, yields, reporting | Very large |
| **BL-02–BL-05** | Alerts, merge, telemetry | Medium each |
| **BL-07** | Split tab components from `App.jsx` | Large mechanical |
| **BL-10** | Optional Playwright smoke; more utils if extracted | Small increments |

**Summary:** Slices **1, 4** largely complete; **2, 3, 5, 6** partial. Largest remaining **product** lift: **BL-01**. Largest **refactor** lift: **BL-07** + Slice 2 alert cleanup.

---

## Backlog — product and functionality (beyond current slices)

Items intentionally **not** in slices 1–6; pull into planning when capacity allows.

| ID | Item | Rationale / pairing | Suggested slice |
|----|------|---------------------|-----------------|
| **BL-01** | **COGS / recipe costing** | Natural fit with existing **shopping list + item prices + categories**; needs recipe yields, waste %, and period reporting | Own epic after Slice 3 |
| **BL-02** | Cost pairs / supplier price history alerts | Complements price history tab; requires notification UX | After BL-01 or parallel |
| **BL-03** | Import merge wizard | Resolves multi-device edit conflicts | Slice 5 follow-up |
| **BL-04** | IndexedDB + sync | If storage quota issues recur at scale | After Slice 3 metrics |
| **BL-05** | Admin dashboard for error telemetry | Optional privacy-preserving counts—needs consent copy | Post Slice 2 |
| **BL-07** | Split `App.jsx` further (`src/constants.js` done; next: tab pages) | `HelpCenter` + constants extracted | Ongoing |
| **BL-08** | ~~Per-key repair for DMG-E012~~ **Done** — Help → paste JSON for one key | Safer than wipe-all | — |
| **BL-10** | Vitest: `apiErrors`, `constants`, `storageHealth`, **`formatters`** (`src/formatters.js`); optional Playwright smoke later | Regression safety | In progress |

---

## Ordering recommendation

1. **Slice 1** (build) — unlocks everything else; reduces `DMG-E001`/`E002` frequency.
2. **Slice 2** (error UX) — makes remaining failures legible.
3. **Slice 3** (storage) — addresses `DMG-E010`–`E012` which dominate real-world “it ate my data” fear.
4. Slices **4–6** in parallel only after 1–3 are stable.

---

## Open design questions (fill before Slice 2–3)

1. **Support channel:** Single email vs in-app only? (Affects diagnostics copy.)
2. **Admin reset:** When `DMG-E012` triggers, is backend reset always allowed or device-local only?
3. **COGS (BL-01):** Per-business recipes vs global catalog? Tax inclusive/exclusive for margin?

---

## Maintenance

Update this file when:

- A new error code is added or retired.
- A slice ships (check acceptance boxes in PR description).
- Backlog items graduate into a slice or are cancelled.

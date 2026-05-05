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
| `src/App.jsx` | Main React shell + tab implementations (large; BL-07 — extract more from here over time) |
| `src/toastContext.jsx` | **`ToastProvider`** wraps `<App />` in `main.jsx`; **`showToast`** / **`toastApiFailure`** (global, works on login + modals) |
| `src/errors.js` | `reportError`, diagnostics ring buffer, `copyDiagnostics`; wired from Help tab |
| `src/apiErrors.js` | DMG-E020–E031 mapping for auth/scan/attendance `fetch` + HTTP |
| `src/storageHealth.js` | localStorage probe, quota estimate, corrupt key scan, save-failure notify |
| `src/charts/` | Lazy `React.lazy` chart panels (Recharts only loads when chart UI mounts) |
| `src/HelpCenter.jsx` | Help tab: diagnostics, supported browsers, DMG codes, **repair one corrupt storage key** (paste JSON) |
| `src/styles.css` | Global styles (extracted from legacy HTML) |
| `public/` | Static copies served at site root (e.g. `auth-api-config.json`) |
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

## Conventions for agents

- Prefer **small, focused PRs** matching backlog slices.
- Do not revert **additive** `localStorage` keys without migration notes (see comments in `App.jsx` about compatibility).
- After editing `src/App.jsx`, `src/ui/*`, or shared modules, run **`npm run build`**; run **`npm test`** when changing `apiErrors.js`, `constants.js`, `storageHealth.js`, `formatters.js`, `browserCaps.js`, or adding `*.test.js`.
- **COGS / costing** and heavy analytics belong in backlog (`BL-01`); pair with existing items + shopping list when implemented.

## Known technical debt

- `src/App.jsx` is monolithic (~5k lines); **`src/ui/Confirm.jsx`** is the first shared UI extract — continue with `Modal` / `FI` / tab pages (`BL-07`).
- Recharts (~565KB min) loads **on demand** via `src/charts/*` lazy imports; initial shell avoids it until a chart tab renders charts.

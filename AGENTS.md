# Agent context — Catering Inventory Manager

## Purpose

Browser-first catering inventory and invoicing app for multiple businesses. Primary UX target is **GitHub Pages** static hosting (`index.html` + hashed JS/CSS). Optional **Node backend** in `backend/` for admin password reset and central auth (`render.yaml`).

## Repository layout (after Vite migration)

| Path | Role |
|------|------|
| `index.html` | Vite entry shell (lightweight); boots `/src/main.jsx` |
| `src/App.jsx` | Entire React application (large single file today) |
| `src/main.jsx` | `createRoot`, `StrictMode`, boot integration |
| `src/errors.js` | `reportError`, diagnostics ring buffer, `copyDiagnostics` |
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
```

Backend (optional): see `backend/README.md`.

## Deployment (GitHub Pages)

The live site must serve **built assets**, not raw dev sources:

1. Run `npm run build`.
2. Publish **`dist/` contents** to the branch/path Pages uses (often `gh-pages` branch root or `/docs` depending on repo settings).
3. Ensure `auth-api-config.json` is present at site root (copied from `public/` during build).

**Roadblock for automation:** If Actions secrets (`GITHUB_TOKEN`) are unavailable in this environment, CI cannot be validated here—workflow YAML can still be added for maintainers to enable in repo Settings → Actions.

## Error codes

Stable catalog lives in `docs/PRODUCT_BACKLOG.md`. Boot-related strings:

- **`DMG-E001`** — Bundle/scripts failed to load or hung before mount (watchdog).
- **`DMG-E002`** — Mount threw or compile/runtime failure during startup.

## Conventions for agents

- Prefer **small, focused PRs** matching backlog slices.
- Do not revert **additive** `localStorage` keys without migration notes (see comments in `App.jsx` about compatibility).
- After editing `src/App.jsx`, run **`npm run build`** before declaring done.
- **COGS / costing** and heavy analytics belong in backlog (`BL-01`); pair with existing items + shopping list when implemented.

## Known technical debt

- `src/App.jsx` is monolithic (~5k lines); splitting by tab/feature is backlog-worthy but avoid drive-by refactors unless slice-scoped.
- Recharts chunk is large; lazy-loading analytics-only charts is a future optimization (`PRODUCT_BACKLOG` Slice 4).

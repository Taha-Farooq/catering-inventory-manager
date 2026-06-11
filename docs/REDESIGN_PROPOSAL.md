# Redesign Proposal — Catering Inventory Manager

This document answers a single question: **does this app need a
restructure, and if so, how big?** It's deliberately opinionated. The
recommendation comes first, the reasoning follows.

## TL;DR recommendation

**Targeted refactor — NOT a rewrite. NOT a redesign-first stop-the-world.**

The frontend is in much better shape than the owner's "hodgepodge"
self-assessment suggests. The backend has a small but serious set of
security bugs that need to be fixed before anything else (see
`docs/SECURITY_REVIEW.md`). After the security work, the system needs
three focused refactors over the next 1–3 months. None of them require
breaking the live experience for users. None of them require a port.

Don't rewrite. Don't redesign. Patch the security holes this week,
then plan three small refactors against the existing code.

## Phase 0 — this week: security fixes (mandatory before anything else)

Pick from `docs/SECURITY_REVIEW.md`. The non-negotiables before the
restructure question is even worth discussing:

- A0: gate `/api/auth/sync` (one line)
- A2: stop returning `credentialsSnapshot` on login
- A4: remove the SYSTEM-level Windows scheduled task

These three close the "anyone with a curl command can hijack the
whole app" gap. Without them, every other improvement is theatre.

A1 + A6 (bearer tokens + bcrypt) can come right after; they're a
half-day of work and they upgrade the entire auth posture from
"interesting" to "boringly defensible".

## Phase 1 — next month: three focused refactors

### Refactor 1 — Backend: one auth model, one storage model, atomic writes

**Why:** the backend is the smallest part of the system and the one
most overdue for a cleanup. It carries the security debt. It also
uses three different storage primitives (`writeFileSync` of JSON,
in-memory arrays, JWT for one specific case) for what is conceptually
one job.

**What:** keep `backend/server.js` as the boundary, but extract:

- a `backend/store/` module that wraps a single SQLite file
  (`better-sqlite3` — zero-network, file-backed, atomic, locked, no
  ops overhead) with one schema per entity (`users`, `sessions`,
  `used_reset_tokens`, `scan_docs`, `attendance_sessions`,
  `attendance_active`). The store is the only thing that writes to
  disk. JSON `data/*.json` files can still be read for one release
  cycle of migration.
- a `backend/auth/` module that owns: bcrypt hashing, session JWT
  minting + verification, rate limiting, lockout, and the
  `req.user` injection. Both `authUser` and `adminOnly` resolve
  through this module.
- the route handlers stay in `server.js` but become thin: parse,
  call store/auth, format response.

**Why not a full rewrite of the backend?** Because the route surface
is tiny (~20 endpoints, ~750 lines including comments) and the
business logic is already correct. The pain is concentrated in three
files; surgery is faster than transplant.

**Risk:** zero to user-facing behaviour. Migration of
`credentials.json` → `users` table is one read + one write. The
biggest risk is forgetting to drop the JSON read fallback after a
release.

### Refactor 2 — Frontend: untangle `App.jsx` state

**Why:** `src/App.jsx` is ~800 lines and owns 25+ pieces of state
that overlap conceptually (auth, kiosk, QR gate, business switcher,
storage health, modals, every domain entity). It is not "god
component"-bad — there are tabs that each own their own state, and
this is mostly threading. But the threading IS the problem when you
need to change one thing.

**What:** introduce two contexts and one custom hook. No state
manager — Redux/Zustand are overkill here.

- `AuthContext` (provider near root) owns: `currentUser`,
  `userPerms`, `kioskLock`, `staffQrPhase`, `staffAttToken`,
  `staffSessionTimer`. Exposes: `login`, `logout`, `enterKiosk`,
  `passQrGate`, `failQrGate`, `onAttendanceComplete`. Removes ~150
  lines from `App.jsx`.
- `BusinessContext` owns: `biz`, `BUSINESSES`, branding map,
  `logoOverrides`, `bizContact`. Exposes: `setBiz`, `getBranding(inv)`.
  Removes ~40 lines from `App.jsx`.
- a `useDomainSlice(key, defaultValue)` hook replaces the dozen
  duplicate `useState(() => load(...))` calls. Behind the scenes
  it's still `localStorage`, but the call sites collapse from 12 to
  1 declaration per entity.

After this, `App.jsx` is ~300 lines and is almost entirely routing
and shell layout. The cognitive load drops sharply.

**Why not Zustand/Redux/Jotai?** They'd be reaching for an axe to
hang a picture. The state lives in localStorage; React state is
just a cache. Context + custom hooks express that exactly.

**Risk:** all per-tab state stays where it is. The contexts only
absorb truly app-wide state. Each refactor PR can move one piece at
a time; no big-bang.

### Refactor 3 — Storage layer: one schema authority, one migrate path

**Why:** the current "every tab knows the localStorage key it owns"
model has produced:

- silent schema drift (e.g., catering invoices have
  `payments[]` AND legacy `deposit`, items have `currentQty` AND
  `locQty.englewood`, transfer invoices have a `normalizeTransferInvoice`
  migration that runs on every boot)
- a `src/tabUtils.js` compatibility shim that doesn't go away
- inconsistent storage I/O (most tabs use `load`/`save`, some still
  reach for `localStorage` directly, some use the shim)
- a backup ZIP version that has to be bumped manually whenever a
  new key is added (`v2.0` → `v2.6`)

**What:** introduce a single `src/data/` module that:

- holds the **canonical schema** for each entity (TypeScript types
  via JSDoc if you don't want a build step, or a single `schemas.js`
  with shape constants)
- exposes `read<Entity>()` / `write<Entity>()` per entity. No tab
  touches `localStorage` directly anymore. `tabUtils.js` is deleted.
- owns the migration ladder. `migrations.js` is an array of
  `{from, to, run}` entries. On boot, the data module reads the
  stored version and runs migrations forward. The transfer-invoice
  normaliser and shopping-list migrator both move here.
- owns the backup-version contract. Adding an entity to the system
  bumps the version automatically based on what's in the schema.

**Why not move to IndexedDB?** Because the data sizes don't require
it yet, and IndexedDB's async surface would touch every tab. The
right time for IndexedDB is when a single key crosses ~1 MB or you
need range queries. Today, neither.

**Risk:** moderate. The refactor touches almost every tab, but only
to replace the import line. Each tab can be migrated in its own PR
since `load`/`save` and `read<Entity>`/`write<Entity>` can coexist
during transition.

## Phase 2 — months 2–3: opportunistic cleanup

These are worth doing but the value-per-hour drops sharply, so they
should be opportunistic (done while the area is touched anyway), not
campaigned.

- Move `BRANDING` out of `authHelpers.js` and into its own
  `src/branding.js`. The fact that it lives next to login helpers is
  a fossil of an old extraction.
- Reconcile `src/errors.js` + `src/utils/errors.js`. Same word,
  different concern. Pick one: `src/diagnostics.js` for the ring
  buffer and `src/data/failureLog.js` for the persistent log.
- Delete `src/tabUtils.js` once Refactor 3 lands.
- Remove the duplicate `auth-api-config.json` from repo root; keep
  only `public/auth-api-config.json` and document that Vite copies
  `public/` to `dist/`.
- Backend tests. Write them. Even one Vitest file that boots the app
  in-process and hits each endpoint with supertest catches 80% of
  regressions for the next two years.
- Replace the hardcoded `BUSINESSES` constant with a list-of-objects
  so adding a fourth business is "edit one object" instead of "edit
  six places".

## What NOT to do

This list is as important as what to do.

- **Don't rewrite the frontend.** It's not as bad as it feels. 307+
  passing unit tests, a clear ErrorBoundary, structured DMG-Exxx
  error codes, a working diagnostics flow, lazy chart bundles — this
  is the work of someone who cared. The shell needs slimming, not
  replacement.
- **Don't move to TypeScript yet.** The marginal value at this
  codebase size is small; the cost is several weeks. If you do it,
  do it after Refactor 3 (a schema layer is the right place to start
  adding types).
- **Don't move to Next.js / SSR.** This is a static SPA running on
  GitHub Pages for $0 with no server-side rendering needed. Moving
  to Next adds an entire deployment dimension and gives you nothing
  back except a build complexity bump.
- **Don't replace localStorage with a "real" database** until the
  product needs multi-device sync. The localStorage model is part
  of why backups are simple and offline-first works. The day you
  need real sync, the project is essentially a new product —
  charge for it.
- **Don't try to "fix" sharing customers across businesses.**
  AGENTS.md explicitly calls it intentional. The owner runs three
  shops that overlap by clientele. Forcing partition would break
  the workflow.
- **Don't deploy "Scan DB" to Render.** It assumes a local
  filesystem with the operator's PDFs in it. Render gets you a
  cosmetic Scan DB that doesn't work. Leave it admin-device-only
  per AGENTS.md.

## Restructure dial — table of judgments

| Layer | Verdict | Why |
|---|---|---|
| Auth (backend) | **Refactor** | Three Critical findings; pattern is recoverable, not broken. |
| Auth (frontend) | **Refactor** | LoginScreen logic is correct but tangled; bearer tokens land cleanly here. |
| Backend storage | **Refactor (to SQLite)** | JSON-as-DB is the source of the atomicity bugs (§A9). |
| Backend route surface | **Keep** | 20 routes, ~750 lines, intent is clear. |
| Frontend state in App.jsx | **Refactor** | Split into 2 contexts + 1 hook. ~500 lines come out. |
| Frontend tabs | **Keep** | Each tab is self-contained and tested. |
| Frontend utils | **Refactor (light)** | Reconcile errors.js + utils/errors.js; delete tabUtils.js. |
| Build / deploy (Vite + Pages) | **Keep** | Working, fast, free. No change. |
| Windows installer | **Refactor (drop SYSTEM task)** | One-line fix for the EOP path; keep the rest. |
| Documentation | **Add** | This file + ARCHITECTURE.md + SECURITY_REVIEW.md are the new floor; AGENTS.md and PRODUCT_BACKLOG.md stay as is. |
| Tests | **Add (backend)** | Frontend tests are excellent; backend has none. |
| Product backlog | **Keep** | The slice cadence is genuinely good. |

## Sequencing summary

```
Week 1   ─────  Security: A0, A2, A4. Branch from master, ship same week.
Week 2-3 ─────  Auth refactor: A1 + A6 (bearer tokens + bcrypt).
Week 4   ─────  Rate limit + lockout (A5). Atomic writes (A9).
Month 2  ─────  Refactor 1 (backend store + auth module + SQLite).
Month 2  ─────  Refactor 2 (App.jsx contexts) — can run in parallel.
Month 3  ─────  Refactor 3 (src/data/ canonical store).
Month 3+ ─────  Opportunistic cleanup. Backend tests.
```

The order matters: doing Refactor 1 before A0/A2/A4 means you're
refactoring on top of bugs. Doing the security fixes inline against
the current code is faster and lower-risk.

## How to know you've succeeded

After Phase 1 you should be able to give a new contributor:

- `docs/ARCHITECTURE.md`
- a 30-min code tour
- the test suite green

…and have them ship a real feature in their first week. If they get
stuck on "which file owns this?" or "how do I store something new?",
the refactor is incomplete.

## One last thing

The owner's instinct that this is hodgepodge isn't wrong, but it's
mostly the *backend* and the *App.jsx shell* that feel that way, not
the system as a whole. The product itself — three businesses, one
admin, simple invoicing, attendance, payroll, analytics — is
appropriately scoped, and the slice-based delivery in
`PRODUCT_BACKLOG.md` has been remarkably disciplined. Don't burn that
down. Trim it.

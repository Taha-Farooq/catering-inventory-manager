# Security Review — Catering Inventory Manager

> **⚠ TREAT THIS DOCUMENT AS SENSITIVE.** The repo is public. The
> highest-severity findings below describe issues that are exploitable
> against the live production backend at
> `https://catering-inventory-manager.onrender.com` as of the review
> date. Several of them only need a `curl` command. Read §A0 first and
> mitigate before doing anything else with this branch.

Review target: branch `claude/backend-setup-error-LSHpX`, files current
at the time of writing. This is a code-read review, no live testing
performed against the production service.

Reviewer's scope: backend Express server (`backend/server.js`), the
reset-link tool, the React frontend's auth + reset surfaces
(`src/authHelpers.js`, `src/ui/LoginScreen.jsx`,
`src/ui/AdminResetPortal.jsx`, `src/ui/QrScanGate.jsx`,
`src/ui/FirstRunSetup.jsx`, `src/utils/secureStore.js`,
`src/utils/storage.js`, `src/utils/print.js`), the Render deploy
config (`render.yaml`), and the Windows on-prem installer
(`backend/windows/one-click-setup.ps1`, `start-backend.ps1`).
Dependencies were reviewed at the manifest level.

Severity scale: **Critical** (exploitable now, low effort, large
blast radius) → **High** (exploitable now, requires conditions) →
**Medium** (exploitable with auth or with a separate primitive) →
**Low** (defense-in-depth gap) → **Info** (worth knowing).

---

## A0 — Critical: `/api/auth/sync` overwrites the users file with no auth

- **Status:** **Fixed on this branch.** `backend/server.js` now requires
  `adminOnly`-style auth, with a single-shot exception when
  `credentials.json` is empty (first-run starter ZIP bootstrap). The
  bootstrap window only exists between deploy and the first valid sync;
  on the live Render service it's already closed because users exist.
- **Severity:** Critical
- **Location:** `backend/server.js:423-429`
- **What it is:** The endpoint accepts a `credentials` object body and
  calls `writeUsers(cleaned)`, replacing `backend/data/credentials.json`
  in full. There is no middleware in front of it — no `authUser`, no
  `adminOnly`. CORS does not gate `curl`/server-to-server callers
  regardless of origin.

  ```js
  app.post('/api/auth/sync', (req, res) => {
    const { credentials } = req.body || {};
    const cleaned = sanitizeCredentials(credentials);
    if (!Object.keys(cleaned).length) return res.status(400)...;
    writeUsers(cleaned);  // wipes + replaces credentials.json
    return res.json({ ok: true, userCount: Object.keys(cleaned).length });
  });
  ```

- **Attack scenario:**
  1. Attacker fetches `public/auth-api-config.json` from the public
     GitHub Pages site → learns the Render backend URL.
  2. Attacker computes `SHA-256('attacker_password:admin')` on any
     laptop (it's not slow).
  3. Attacker runs:
     ```
     curl -X POST https://<render-url>/api/auth/sync \
       -H 'Content-Type: application/json' \
       -d '{"credentials":{"admin":{"password":"<hash>","role":"admin","displayName":"Administrator"}}}'
     ```
  4. The next time anyone tries to sign in, the only valid account is
     the attacker's. The legitimate admin is locked out until the
     `credentials.json` file is restored from a backup. The attacker is
     now able to log in as admin to the live website and use every
     admin API + every UI tab.
- **Fix sketch:** require `adminOnly` on `/api/auth/sync`. The
  bootstrap-from-starter-ZIP case (which is the reason this endpoint
  exists) needs a different path: either accept an admin password hash
  in the body to bind the call, or require that the file is uploaded
  while logged in, or expose a separate one-shot "initialize empty
  user file" endpoint that only succeeds when `userCount === 0`. Until
  the fix is shipped, rate-limit or firewall the endpoint at the
  reverse proxy level.

## A1 — Critical: the password hash IS the session token (no derived auth)

- **Severity:** Critical
- **Location:** `backend/server.js:124-140` (`verifyAnyUserFromRequest`,
  `authUser`); `src/authHelpers.js:252-285` (`scanApiCall`);
  `src/authHelpers.js:287-318` (`attendanceApiCall`)
- **What it is:** Every authenticated endpoint takes the raw stored
  password hash as the per-request credential, sent in the
  `x-auth-hash` header (or `body.auth.passwordHash`). There is no
  derived session token, no expiry, no rotation. The hash IS the
  credential, and the credential never changes until the user changes
  their password.

  This means anyone who captures the hash once — over a Render edge
  failure, in a browser extension, via a misconfigured proxy, in a
  shoulder-surfed devtools session, in a backup ZIP that gets emailed
  to the wrong address — has indefinite, undetectable access. The
  hash also propagates into `localStorage.credentials` on every device
  via `/api/auth/login`'s response (§A2), so it lives in many places
  at once.

- **Attack scenario:**
  1. Attacker gets one snapshot of `credentials.json` (via §A0, via a
     leaked backup ZIP, via filesystem access to the Render container,
     or via §A2 from any user login).
  2. Attacker submits any admin-gated API call with
     `x-auth-user: admin` + `x-auth-hash: <hash from snapshot>`.
  3. Auth passes for as long as the admin's password is unchanged.
     Password changes are rare in this product; nothing forces or
     prompts rotation.
- **Fix sketch:** the password hash should be used **only** at
  `/api/auth/login` to mint a short-lived signed session token (JWT
  with `mode: 'session'`, ~30 min TTL, refresh on activity). All other
  endpoints should accept `Authorization: Bearer <session jwt>` and
  reject `x-auth-hash` entirely. Server-side, store the password as
  `bcrypt`/`argon2` of `(salt || pwd)`, not raw SHA-256 (see §A6).

## A2 — Critical: `/api/auth/login` returns every user's password hash

- **Severity:** Critical
- **Location:** `backend/server.js:411-420`
- **What it is:** A successful login returns
  `{ user, credentialsSnapshot: users }`. `users` is the entire
  `credentials.json` — every username, role, displayName, and password
  hash for every account, including admin. The frontend deliberately
  writes this into `localStorage.credentials` on login
  (`src/authHelpers.js:220`).

- **Attack scenario:**
  1. A staff account is compromised (phishing, shared password, etc.).
  2. The attacker logs into the app as that staff member.
  3. The login response body contains the admin password hash.
  4. The attacker either replays the admin hash directly to admin
     endpoints (§A1) or cracks it offline. SHA-256 with a per-user
     salt of just the username runs at billions/sec on a single GPU;
     a non-passphrase admin password is recovered within minutes to
     hours.
  5. Lateral movement to full admin.
- **Fix sketch:** `/api/auth/login` should return only the
  authenticated user's record, never the global snapshot. The
  bootstrap-onto-a-new-device case that this snapshot was trying to
  serve should be handled by an admin-only export (admin user
  explicitly downloads a starter ZIP). Once a session-token model is
  in place, a staff login also doesn't need to learn anything about
  other users.

## A3 — High: admin reset link doesn't actually reset the server password

- **Severity:** High
- **Location:** `backend/server.js:725-745`
  (`/api/admin-reset/complete`), `src/ui/AdminResetPortal.jsx:80-101`
- **What it is:** `/api/admin-reset/complete` only marks the JWT `jti`
  as used and returns an audit ID. It does **not** write the new
  password hash to `credentials.json`. The new hash is written into
  the **client's** `localStorage.credentials` (`AdminResetPortal.jsx`
  L97-100). The server-side `credentials.json` only catches up when
  the client subsequently calls `/api/auth/sync` (which is itself
  unauthenticated — see §A0).
- **Consequence:** there are two ways this goes wrong:
  - If a legitimate admin is on a brand-new device, the reset
    "succeeds" client-side but the next time the central-auth login
    runs, the server still has the **old** hash and rejects them.
    They are pushed back through the reset cycle.
  - More importantly: an attacker who possesses any reset link (e.g.
    intercepts a forwarded email) can complete the reset against
    `/api/admin-reset/complete`, which silently consumes the JTI on
    the server, and write any password they want into **their own
    client's** localStorage. They then call `/api/auth/sync`
    (unauthenticated) and overwrite the server users file. End state
    identical to §A0, with one more layer of indirection but with no
    additional checks along the way.
- **Fix sketch:** reset completion must:
  1. Require the new password hash to land in `credentials.json`
     server-side, atomically, inside `/api/admin-reset/complete`.
  2. Require the request to identify which `username` is being reset
     (the create-link tool doesn't currently bind the JWT to a
     username — see also §A8).
  3. Reset links must be delivered out-of-band and bound to the
     target email (the link generator's `source: 'fatim-manual'`
     suggests this is a manual chat-paste; that's actually OK so long
     as the link is only useful once and only by the holder of the
     pre-arranged username binding).

## A4 — High: Windows installer creates a SYSTEM-level task whose script path is user-writable

- **Severity:** High (local privilege escalation, on-prem only)
- **Location:** `backend/windows/one-click-setup.ps1:123-137`
  (`Ensure-Task`); `Resolve-BackendDir` (same file, L5-16)
- **What it is:** `Register-ScheduledTask` is called twice: once at
  logon as the current user (`Limited` runlevel — fine), and once at
  startup as `SYSTEM` with `Highest` runlevel. The task's action is
  `powershell.exe -File "$startScript"` where `$startScript =
  "$backendDir\windows\start-backend.ps1"`.

  `$backendDir` is wherever the user unpacked the repo — typically
  somewhere under their user profile (e.g. OneDrive\Desktop\... as in
  the recent setup transcript). That location is writable by the
  current user. Anything running with the user's permissions —
  including a malicious browser extension, a sibling user's account
  on a shared machine, malware caught in a normal user-mode infection,
  or just an over-permissive antivirus quarantine — can replace
  `start-backend.ps1` with arbitrary code.

  At next reboot, that code runs as SYSTEM. Game over for the device.
- **Attack scenario:** any local non-admin foothold writes to
  `<backendDir>\windows\start-backend.ps1`. Wait for reboot or trigger
  one. Receive SYSTEM execution.
- **Fix sketch:** drop the SYSTEM `AtStartup` task entirely; the
  AtLogon task already covers the realistic uptime window. If
  startup-without-logon is truly needed, move the backend folder to
  `C:\ProgramData\CateringInventory\` (admin-writable only) before
  registering the task, set strict ACLs that deny write to non-admin
  users, and verify the script's authenticode signature in the task
  action wrapper. Document this clearly in `backend/README.md` so
  re-installers don't undo it.

## A5 — High: no rate limiting or lockout on auth/reset endpoints

- **Severity:** High
- **Location:** `backend/server.js:403-421` (`/api/auth/login`),
  `:705-745` (admin-reset endpoints)
- **What it is:** there is no `express-rate-limit`, no lockout, no
  exponential backoff, no audit log of failed attempts. Online
  brute-force against `/api/auth/login` is unlimited. Online
  brute-force against `/api/admin-reset/validate` (forging JWTs) is
  unlimited but futile if the JWT secret is strong; it does, however,
  let an attacker enumerate request IDs cheaply if any other path
  leaks them.
- **Attack scenario:** with a list of likely admin passwords, hash
  each with `:admin` salt, POST against `/api/auth/login`. With no
  rate cap, the practical bound is the network round-trip — ~10/sec
  per source IP, billions of guesses per botnet day.
- **Fix sketch:** apply `express-rate-limit` to all auth endpoints
  (e.g., 10 attempts / 5 min / IP). Add per-username sliding lockout
  (e.g., lock the account for 15 minutes after 5 failed attempts).
  Log failures with timestamp + IP to a small file or stderr so
  attempts are observable.

## A6 — High: password hashing is fast (SHA-256), not a KDF

- **Severity:** High
- **Location:** `src/authHelpers.js:41-48` (`hashPwd`),
  `backend/server.js:131,289` (compare)
- **What it is:** the stored hash is `SHA-256(pwd + ':' + username)`.
  SHA-256 is designed to be fast; on commodity GPUs you do tens of
  billions of guesses per second. Combined with §A2 leaking every
  hash on login and §A0 letting anyone read the whole file, a
  realistic admin password (even 10+ chars but not a passphrase) is
  recovered offline in minutes.
- **Fix sketch:** the only good fix is server-side: store
  `bcrypt(pwd, cost=12)` or `argon2id(pwd)`. The client should keep
  sending the SHA-256 (so the plaintext doesn't reach the server),
  but the server should hash THAT again with bcrypt/argon2 and store
  the bcrypt result. Compare with the same construction. Migration
  is a one-time double-rehash on next successful login.

## A7 — High: localStorage `credentials` is reachable by any other taha-farooq.github.io project

- **Severity:** High (depends on whether the user owns any other Pages
  project; even if not today, the structural risk persists)
- **Location:** `src/utils/storage.js`, `src/utils/secureStore.js`,
  GitHub Pages hosting model
- **What it is:** GitHub Pages "project pages" live at
  `https://<user>.github.io/<project-name>/`. The same-origin policy
  ignores the path; everything under `https://taha-farooq.github.io/`
  is one origin. Any other project page on the same GitHub account
  can read every localStorage key set by this app — including
  `credentials`, `_session`, `_dmg_mk` (the secureStore master key),
  `_adminPasswordHash`, etc.
- **Attack scenario:** the owner spins up any other GitHub Pages
  project (now or in the future). Anyone who can land JavaScript on
  any of those pages — including a benign contributor accidentally
  pulling in a malicious npm package — can exfiltrate the catering
  app's stored credentials with a one-line `Object.fromEntries(...
  Object.keys(localStorage).map(...))`. There is no warning when
  another Pages project is added.
- **Fix sketch:** the only structural fix is moving the deployed site
  to its own origin (a custom domain such as `app.catering.<owner>.com`
  or a separate GitHub user/org). Until that happens, treat any
  taha-farooq.github.io site as part of the trust boundary, and
  never create another Pages project under that user.

## A8 — High: reset link is not bound to a specific user

- **Severity:** High
- **Location:** `backend/tools/create-reset-link.js:22-31`,
  `backend/server.js:705-745`
- **What it is:** the JWT in the reset link encodes `{jti, requestId,
  source}`. There is no `username` claim. The reset portal lets the
  holder set "a password" but the server has no opinion about which
  user that password is for. The frontend hard-codes the target as
  `admin` (`AdminResetPortal.jsx:98-100`).

  This is fine if the only user that ever has a password worth
  resetting is `admin`, but it's brittle: a malicious frontend can
  point this at any username. Worse: see §A3 — the server itself
  doesn't write the new hash at all, so the binding only matters for
  the eventual sync.
- **Fix sketch:** the reset JWT should include the username claim,
  and the server should require it on `/complete` and use it when it
  writes the new hash (after §A3 is fixed).

## A9 — Medium: `attendance-db` and `scan-db` and `credentials.json` writes are not atomic

- **Severity:** Medium
- **Location:** `backend/server.js:62-64, 87, 121-122, 169-171`
- **What it is:** every write is `fs.writeFileSync(file, JSON.stringify(...))`.
  If the process dies mid-write (Render restart, SIGKILL, disk full),
  the file is truncated. The reader's `try/catch` returns an empty
  default, which on `credentials.json` means **every user is logged
  out and a fresh admin-less file is recreated** (§A0 is now even
  easier — the attacker can repopulate the empty file with no race).
  On `used-reset-tokens.json`, a partial write erases the "this token
  was used" memory; reset link replay becomes possible until the file
  is re-written.
- **Fix sketch:** write to `*.tmp` then `fs.renameSync` over the
  target; this is atomic on the same filesystem. Optionally `fsync`
  the temp file first. Better: move to SQLite (the dependency is
  vendored on every Node install via `better-sqlite3` or similar) and
  let it handle durability.

## A10 — Medium: CORS allows requests with no `Origin` header

- **Severity:** Medium
- **Location:** `backend/server.js:385-392`
- **What it is:** `if (!origin) return cb(null, true);` — this is the
  recommended workaround for same-origin and Postman/curl, but it
  does mean every non-browser caller bypasses the origin allowlist.
  Browsers send `Origin` on every cross-origin request including
  preflights, but pages on the **same origin** as the backend don't
  send `Origin` for same-origin XHRs (rare for this app's topology,
  but worth knowing).

  Combined with §A0/A2/A1, the `if (!origin)` allowance means the
  origin check is effectively decorative — anyone with curl reaches
  every endpoint. CORS is not the right defense layer anyway, but
  this should be tightened so the intent is clear.
- **Fix sketch:** keep the no-origin allowance for `/health` only;
  reject non-browser callers on all other endpoints by requiring a
  valid `Origin` header (and rejecting if it's missing). This
  doesn't defeat a determined attacker (they can spoof `Origin`),
  but it makes the auth gap visible to passive monitoring.

## A11 — Medium: scan job has no path validation (admin-only, but worth flagging)

- **Severity:** Medium (post-auth)
- **Location:** `backend/server.js:604-614` (`/api/scan/config`),
  `:302-371` (`processScanOnce`)
- **What it is:** an authenticated admin can set `inboxPath` and
  `libraryPath` to any absolute path. `collectPdfFiles` recursively
  walks. `moveFileSafe` renames PDFs across directories. On Render
  this is mostly inert because the filesystem doesn't contain
  interesting PDFs, but on the on-prem Windows install this lets a
  compromised admin session read and relocate PDFs from anywhere
  readable by the Windows user (or SYSTEM, via §A4) — including
  `%USERPROFILE%`, `Documents`, `Desktop`, mapped network drives,
  etc.
- **Fix sketch:** require both paths to live under a configured
  allowlist root (e.g. a single `BACKEND_SCAN_ROOT` env var). Refuse
  paths that escape via `..` or that resolve outside the root.
  Acceptable for admin to opt-in to a broader root by editing the env
  file directly; not acceptable for an authenticated HTTP call to
  set it.

## A12 — Medium: `pdf-parse` 1.1.1 is unmaintained and parses untrusted PDFs

- **Severity:** Medium
- **Location:** `backend/package.json` (`pdf-parse: ^1.1.1`),
  `backend/server.js:247-255` (`extractPdfTextSafe`)
- **What it is:** `pdf-parse@1.1.1` was last published in 2018. The
  underlying `pdf.js-extract`/`pdf2json` family has had a stream of
  parser bugs over the years. Maliciously-crafted PDFs are a known
  DoS / heap-exhaustion / occasional RCE vector. `extractPdfTextSafe`
  catches errors but not OOM. On Render free-tier the process gets
  killed and restarts. Worse, if the SCAN_POLL_MS timer keeps trying
  the same file, the process can be in a restart loop.
- **Fix sketch:** swap to a maintained extractor (`pdf-parse-fork`,
  `pdfjs-dist`, or `unpdf`). Cap PDF file size in `processScanOnce`
  before parsing (e.g., skip > 50 MB). Add a per-file timeout (e.g.,
  Promise.race vs 30 s). Add the file's hash to a
  "parse-failed-repeatedly" deny list after N attempts.

## A13 — Medium: JWT secret on Render rotates on every redeploy (`generateValue: true`)

- **Severity:** Medium (operational, not exploit)
- **Location:** `render.yaml:20-21`
- **What it is:** `ADMIN_RESET_JWT_SECRET: generateValue: true` makes
  Render generate a fresh value the first time the service is
  created. On subsequent redeploys Render keeps the existing value
  **unless the service is recreated**. If anyone clicks "create from
  blueprint" again, the secret rotates and:
  1. all outstanding reset links are invalid
  2. all outstanding attendance QR codes are invalid
  3. anyone with an open kiosk QR fails their next scan with a
     confusing error
- **Fix sketch:** set the secret manually once (via Render dashboard)
  and remove `generateValue` so the value is persisted across blueprint
  applies. Document the rotation procedure.

## A14 — Medium: backup ZIP exports all of localStorage (including credentials)

- **Severity:** Medium
- **Location:** `src/ui/SettingsModal.jsx` (backup export);
  `src/ui/LoginScreen.jsx:146-181`, `src/ui/FirstRunSetup.jsx:15-45`
  (import path enumerates `credentials` as one of the importable keys)
- **What it is:** the Settings → Backup ZIP includes
  `credentials.json` containing all stored password hashes (per
  AGENTS.md and the importer's key list). Anyone who can trigger an
  export from a signed-in session gets every hash. Anyone with the
  ZIP, given §A6, can crack the hashes offline.
- **Attack scenario:** an attacker who briefly takes over an admin
  session (e.g., short physical access to an unlocked browser, an
  XSS payload that triggers the export button via DOM events) walks
  away with offline-crackable hashes for every account.
- **Fix sketch:** treat `credentials` as a separate, opt-in export
  that requires the admin to re-enter their password as a confirm
  step. Encrypt the ZIP with the admin's password (PBKDF2 +
  AES-GCM). At minimum, omit the `password` field from the export
  by default and require an explicit toggle to include it.

## A15 — Medium: `/api/admin-reset/complete` requires a sha256 hex hash but doesn't bind it

- **Severity:** Medium
- **Location:** `backend/server.js:725-745`
- **What it is:** the server validates that `newPasswordHash` is 64
  hex chars and consumes the JTI. It then trusts that the requester
  is going to put that hash somewhere useful (see §A3). An attacker
  who got their hands on a reset link can submit any 64-hex string —
  they don't have to know the target user, and they don't have to
  do anything with the response, because the consumed JTI is the
  attacker's goal (it locks the legitimate user out of completing
  the same reset).
- **Fix sketch:** combined with §A3 and §A8, the server should
  reject any complete-reset that doesn't include the bound username
  and the actual new hash to write.

## A16 — Low: secureStore master key lives next to the ciphertext

- **Severity:** Low (the doc-comment already acknowledges this)
- **Location:** `src/utils/secureStore.js:8-21`
- **What it is:** AES-GCM ciphertext is stored under whatever key
  was passed in; the master key is in `localStorage['_dmg_mk']`. An
  attacker with localStorage read access (XSS, malicious extension,
  same-origin Pages project per §A7) has both. The encryption only
  defends against an attacker who can read the file containing the
  ciphertext but not the file containing the key — which on the same
  origin doesn't happen.
- **Fix sketch:** if the goal is to defend against same-origin
  attackers, the master key needs a hardware-bound store
  (WebAuthn-protected, IndexedDB with a non-extractable
  `CryptoKey`). Wrapping with `crypto.subtle.generateKey({
  extractable: false })` and storing the (non-extractable) key in
  IndexedDB is the most realistic upgrade. Standalone, this won't
  fix §A7.

## A17 — Low: `BackendUnavailableBanner` accepts redirect-style probing without rate limit

- **Severity:** Low
- **Location:** `src/authHelpers.js:113-158` (`probeResetApi`,
  `resolveResetApiBase`)
- **What it is:** the frontend will probe every URL in
  `[sharedConfigBase, preferredBase, ?apiBase, localStorage,
  ADMIN_RESET_API_ENDPOINTS]` in parallel and cache the winner. The
  `?apiBase` URL param means a user-clickable link can rebind which
  backend the client trusts. If an attacker can get a target user to
  click a link with `?apiBase=https://evil.example/`, the next
  login attempt's password hash is sent to `evil.example`.
- **Fix sketch:** restrict `?apiBase=` to an allowlist (e.g., the
  bundled `auth-api-config.json` value and `localhost`/`127.0.0.1`).
  Reject any URL that's not in the allowlist; show a clear warning
  banner. Don't persist `?apiBase` to localStorage unless the user
  explicitly confirmed in a modal.

## A18 — Low: portable Node download has no SHA verification

- **Severity:** Low (HTTPS is the only line of defense)
- **Location:** `backend/windows/one-click-setup.ps1:47-63`
- **What it is:** `Invoke-WebRequest` over HTTPS to nodejs.org with no
  SHA-256 check. If a future TLS issue / corporate root cert /
  compromised Node mirror lands a tampered zip, the installer
  silently uses it.
- **Fix sketch:** add the published SHASUMS verification step that
  the official Node docs describe. The hashes are at
  `https://nodejs.org/dist/<version>/SHASUMS256.txt`; verify the
  download against the entry for the win-x64 zip.

## A19 — Low: weekly-hours rollup is timezone-confused

- **Severity:** Low (a correctness bug, not a security bug, but it
  affects payroll which is sensitive)
- **Location:** `backend/server.js:141-148` (`weekStartISO`)
- **What it is:** `weekStartISO` uses local `getDay()` and
  `setHours(0,0,0,0)`, then `toISOString().slice(0,10)`. The
  ISO string is UTC. For NY (UTC-5 / -4 DST) timestamps near
  Sunday/Monday midnight, the date slice rolls back a day, so a
  Sunday-night shift's `weekStart` is computed for the previous
  Monday. Weekly totals subtly drift.
- **Fix sketch:** decide and document the timezone; do all date math
  in that timezone (e.g., `date-fns-tz` with `America/New_York`).
  Better: store wall-clock + zone separately.

## A20 — Info: no Content-Security-Policy, no SRI, no X-Frame-Options

- **Severity:** Info
- **Location:** `index.html`, GitHub Pages
- **What it is:** no CSP header is set. There's no inline-script
  policy. Vite bundles are loaded with hashed filenames but no SRI.
  If an attacker ever gets even a small foothold on the Pages branch
  (PR with a stealthy build script, compromised GH token, a typo in
  a workflow), they can quietly inject script that exfiltrates
  `localStorage`. Adding CSP wouldn't fix §A7 but would harden the
  rest.
- **Fix sketch:** Pages can serve `_headers` (Netlify-style is no,
  but you can include a `<meta http-equiv="Content-Security-Policy">`
  in `index.html`). Start with a report-only policy to avoid
  breaking Recharts / xlsx / Vite's HMR-related blobs in dev.
  Long-term: serve from a Cloudflare or Netlify front so a real CSP
  header can be added.

## A21 — Info: print pop-ups use `document.write` with template-string interpolation

- **Severity:** Info (no XSS today; defense-in-depth)
- **Location:** `src/utils/print.js:34-56`,
  `src/tabs/CustomerManagement.jsx:240`,
  `src/tabs/PayrollInvoices.jsx:686`,
  `src/tabs/ShoppingList.jsx:284`
- **What it is:** the print pop-up is opened via `window.open('')` and
  then `w.document.write(<template>)`. The HTML interpolated in comes
  from React-rendered output (`el.outerHTML`), so user-controlled
  fields like customer names and item descriptions are already
  HTML-escaped. There is no XSS *today*. But:
  - the `<title>${title}</title>` interpolation in `printHtmlDocument`
    is not escaped; an attacker who can supply the title (none of
    the current call sites do, but future ones might) could inject
    arbitrary HTML before `</title>`
  - `documentBaseHref()` is interpolated into a `<base href>` and the
    only sanitisation is `.replace(/"/g, '&quot;')` — that's fine for
    the current source (URL), but it doesn't validate the URL itself
- **Fix sketch:** sanitize/escape the title, or use
  `document.createElement('html')` + DOM API instead of `document.write`.
  Long-term, render the print view inside a `<dialog>` in the
  current document and use the browser's print stylesheet.

---

## What we checked and did NOT find

- **No `dangerouslySetInnerHTML` anywhere** in `src/` — searched via
  Grep with no matches. React's default escaping is doing its job.
- **No `eval` / `new Function`** in `src/`.
- **No path traversal in scan upload** beyond the admin-controlled
  config — files are listed from disk, not uploaded by HTTP.
- **`jsonwebtoken`** is v9.0.2, past CVE-2022-23529 (HS256 secret
  confusion).
- **`express`** is v4.21.2, current (no known critical CVEs at this
  patch level).
- **Vite** v6, React 18, `qrcode` and `jsqr` are all current.
- **No `req.body?.auth` injection bypass** because `express.json()`
  only parses `application/json`, which triggers preflight; a
  malicious cross-origin form cannot post JSON.
- **Attendance QR token replay** is prevented by `qrUsed` being
  appended on `/api/attendance/check`. (Note: `/qr/validate` does
  NOT consume the JTI, which is correct — that endpoint is just a
  readiness check.)
- **JWT secret confusion between attendance-mode and reset-mode
  tokens**: both routes verify against the same secret, but
  `/api/attendance/*` checks `decoded.mode === 'attendance'`, and
  `/api/admin-reset/*` checks for `requestId`. An attendance token
  cannot be used as a reset token (no `requestId`) and vice versa.

## Mitigation priority order (recommended)

If you can only fix three things before tomorrow:

1. **A0** — gate `/api/auth/sync` behind `adminOnly` (one-line fix
   plus a careful test that the starter-ZIP bootstrap still works).
2. **A2** — stop returning `credentialsSnapshot` from
   `/api/auth/login`; have the frontend persist only the
   authenticated user's record. Verify the offline-fallback path
   still works.
3. **A4** — remove the SYSTEM-level `AtStartup` scheduled task from
   `one-click-setup.ps1` (the AtLogon task is sufficient for the
   intended uptime model).

After that, in priority order:

4. **A1 + A6** together — move to bearer session tokens and bcrypt
   on the server.
5. **A3 + A8 + A15** — make admin-reset actually reset on the
   server, bound to a username.
6. **A5** — add `express-rate-limit` and a per-user lockout.
7. **A7** — plan migration to a separate origin (custom domain or
   a Cloudflare front). Do not start any new GitHub Pages projects
   under `taha-farooq` until that's done.
8. Everything else in the order it shows up in a normal week.

If you can only fix one thing today: **A0**. It is the cheapest
attack and the highest blast radius.

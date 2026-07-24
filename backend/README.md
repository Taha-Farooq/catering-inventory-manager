# Auth + Admin Reset Backend

Secure companion API for centralized login and admin password reset approval when frontend is hosted on GitHub Pages.

## 1) Setup

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env`:

- `ADMIN_RESET_JWT_SECRET` - long random secret (required)
- `ALLOWED_ORIGIN` - frontend origin (`https://taha-farooq.github.io` by default)
- `ALLOWED_ORIGINS` - optional comma-separated extra origins (useful for local testing)
- `ADMIN_RESET_TTL_MIN` - link expiry minutes

## 2) Run backend

```bash
npm run dev
```

Backend starts on `http://localhost:8787`.

API includes:

- `GET /health`
- `GET /api/auth/status`
- `POST /api/auth/login`
- `POST /api/auth/sync`
- `POST /api/admin-reset/validate`
- `POST /api/admin-reset/complete`

For low-tech reliability, keep it running as a background service on the same machine where resets are performed.

## 3) Generate secure reset link (for Fatim)

```bash
npm run create-link
```

This prints a one-time reset link payload (time-limited JWT) to send privately.

## Windows One-Click Setup (Best for low-tech reliability)

Double-click:

- `backend\windows\ONE-CLICK-SETUP.cmd`

This requires no preinstalled tools and will:
- download portable Node runtime into `backend\runtime\node`
- create `.env` if missing
- auto-generate `ADMIN_RESET_JWT_SECRET` if missing/placeholder
- install dependencies
- register/start Windows auto-start task for backend service
- run backend health check automatically

Auto-start tasks created:
- `CateringAdminResetBackend-AtStartup` (runs at device boot)
- `CateringAdminResetBackend-AtLogon` (runs at user sign-in)

Then test:
- `backend\windows\health-check.ps1`

## Windows Auto-Start (alternative entry points)

If you already ran `ONE-CLICK-SETUP.cmd`, auto-start is already installed — you do
not need to run anything else. To verify, open PowerShell and run:

```powershell
Get-ScheduledTask -TaskName CateringAdminResetBackend*
```

For convenience, additional double-click entry points live in `backend\windows`:

- `INSTALL-AUTOSTART.cmd` — re-runs the one-click setup (installs deps + registers tasks).
- `REMOVE-AUTOSTART.cmd` — removes the scheduled tasks.
- `HEALTH-CHECK.cmd` — confirms the backend is responding on port 8787.

These `.cmd` wrappers launch their PowerShell counterparts with
`-ExecutionPolicy Bypass`, so you do **not** need to change your system
execution policy. If you prefer running the `.ps1` files directly from a
PowerShell window and get *"running scripts is disabled on this system"*,
either use the `.cmd` wrapper, or run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1
```

Logs are written to:

- `backend/logs/backend.log`

## 4) Frontend integration

The app is configured to call:

- centralized auth endpoints (`/api/auth/*`)
- admin reset endpoints (`/api/admin-reset/*`)

at `http://localhost:8787`.

If you deploy this backend, set `auth-api-config.json` in the project root:

```json
{
  "apiBase": "https://your-hosted-backend-url"
}
```

The frontend also supports temporary override via URL query:

- `?apiBase=https://your-hosted-backend-url`

## Notes

- Token reuse is blocked using `backend/data/used-reset-tokens.json`.
- Password hash write remains in browser local data by design (static app architecture).

## Free Render Deploy (Automated)

This repo includes a root `render.yaml` for one-click free-tier deploy.

In Render:

1. New Web Service -> connect GitHub repo.
2. Keep defaults from blueprint (`render.yaml`).
3. Deploy.
4. Copy service URL and set it in root `auth-api-config.json`.

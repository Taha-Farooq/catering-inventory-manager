# Admin Reset Backend

Secure companion API for admin password reset approval when frontend is hosted on GitHub Pages.

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

For low-tech reliability, keep it running as a background service on the same machine where resets are performed.

## 3) Generate secure reset link (for Fatim)

```bash
npm run create-link
```

This prints a one-time reset link payload (time-limited JWT) to send privately.

## 4) Frontend integration

The app is configured to call:

- `POST /api/admin-reset/validate`
- `POST /api/admin-reset/complete`

at `http://localhost:8787`.

If you deploy this backend, update `ADMIN_RESET_API_BASE` in `index.html` to your hosted API URL.

## Notes

- Token reuse is blocked using `backend/data/used-reset-tokens.json`.
- Password hash write remains in browser local data by design (static app architecture).

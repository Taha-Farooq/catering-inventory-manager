# Catering Inventory Manager

Standalone catering inventory manager for three businesses:
- inventory items
- invoices
- shopping list
- analytics

## Developers — build and deploy

The browser app is built with **Vite** (React). Source lives under `src/`; production output is **`dist/`**.

```bash
npm install
npm test           # optional but recommended before push
npm run build      # writes hashed bundles to dist/
```

### GitHub Pages

1. **One-time:** In the repo, go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions** (not “Deploy from a branch”).

2. Pushes to **`master`** run `.github/workflows/deploy-pages.yml` (`npm ci` + `npm run build`) and publish **`dist/`**. The first run may require approving the **github-pages** environment if your org enforces that.

3. **Re-deploy without a code change:** **Actions** → **Deploy GitHub Pages** → **Run workflow** (only available after the workflow file exists on the default branch).

4. The site is a project page at `https://<user>.github.io/<repo>/`. `vite.config.js` uses `base: './'` so asset paths work under that subpath.

5. `public/.nojekyll` is copied into `dist/` so GitHub Pages does not run Jekyll on assets starting with `_`.

For a manual deploy without Actions: build locally, then upload **only the contents of `dist/`** to your Pages branch or hosting root.

### Configuration at runtime

`public/auth-api-config.json` is copied into `dist/` by Vite. Edit it before `npm run build` if the central auth API URL changes.

End users can open **Help → Copy diagnostics** to share build/browser/error-code info with support (no passwords).

## Open App (No Install Needed)

Use the live website:

[https://taha-farooq.github.io/catering-inventory-manager/](https://taha-farooq.github.io/catering-inventory-manager/)

This app runs directly in your browser. No installation is required.

**Browsers:** Use current **Chrome**, **Edge**, or **Firefox** on desktop. The live site must be served over **HTTPS** (GitHub Pages is fine) so password hashing works; avoid extremely strict private modes if saves fail.

## Best Way To Use

- Open the link on a desktop browser (Chrome, Edge, or Firefox recommended)
- Bookmark the page for quick access
- Sign in with credentials from your admin

## Quick Start For Staff

1. Open the website link above.
2. If your manager gave you a starter ZIP file, use the on-screen **Import Starter File** button on first launch.
3. Sign in with the username and password your admin gave you.

## Data Note

This is a static browser app hosted on GitHub Pages. If you clear browser storage, local app data may be removed.

## Secure Admin Reset (Optional Backend)

For backend-gated admin password resets, use the `backend` folder:

- `backend/server.js` - validates and completes reset tokens
- `backend/tools/create-reset-link.js` - generates private reset links for approved requests

See `backend/README.md` for setup and run steps.

For easiest Windows reliability, use:

- `backend/windows/ONE-CLICK-SETUP.cmd`

This installs and auto-starts the backend reset service on login.

## Free Hosted Central Login (Recommended)

You can keep the website on GitHub Pages and host the auth backend for free on Render.

1. Push this repo to GitHub.
2. In Render, create a new Web Service from this repo.
3. Render will auto-detect `render.yaml` in this project and provision the backend service.
4. After deploy, copy the backend URL (for example `https://catering-inventory-auth.onrender.com`).
5. Set `auth-api-config.json`:

```json
{
  "apiBase": "https://your-backend-url.onrender.com"
}
```

6. Commit and publish to GitHub Pages.

Result:
- first-time setup screen appears only when no central users exist
- once admin imports users, all devices become login-only
- admin credentials open admin features; staff credentials open only allowed tabs
- invalid credentials show a generic login error

## License

MIT

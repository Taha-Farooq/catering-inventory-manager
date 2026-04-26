# Catering Inventory Manager

Standalone catering inventory manager for three businesses:
- inventory items
- invoices
- shopping list
- analytics

## Open App (No Install Needed)

Use the live website:

[https://taha-farooq.github.io/catering-inventory-manager/](https://taha-farooq.github.io/catering-inventory-manager/)

This app runs directly in your browser. No installation is required.

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

- `backend/windows/install-autostart.ps1`

This installs and auto-starts the backend reset service on login.

## License

MIT

# Properties Table Explorer

Angular frontend + Node backend that automatically scrapes Unblu internal docs with Playwright and loads rows into the table on every page load/reload.

## Architecture

- `src/`: Angular app and table UI.
- `server/`: Express API + Playwright scraper.
- `GET /api/properties`: Scrapes both docs pages and returns merged rows in table-ready JSON.
- Session state is saved to `server/.auth/storage-state.json` and reused for subsequent scrapes.

## Scraped sources

- `https://udocs.unblu.com/latest-internal/reference/configuration-properties.html`
- `https://udocs.unblu.com/latest-internal/reference/text-properties.html`

## Authentication behavior

- First scrape (or expired session) triggers interactive Google login in a real Playwright browser window.
- After successful login, storage state is persisted and reused automatically.
- If session expires later, the backend opens login again and refreshes the saved state.
- You can force a fresh login from the UI (`Re-login + reload`) or by calling:

```bash
curl -X POST http://localhost:3000/api/auth/relogin
```

## Local development

1. Install frontend dependencies:

```bash
npm install
```

2. Install backend dependencies:

```bash
npm --prefix server install
```

3. Install Playwright Chromium (one-time per machine/user):

```bash
npm --prefix server exec playwright install chromium
```

4. Run frontend + backend together:

```bash
npm run start:dev
```

- Angular: `http://localhost:4200`
- Backend: `http://localhost:3000`

The Angular dev server proxies `/api/*` to the backend via `proxy.conf.json`.

## Build

Build frontend + backend:

```bash
npm run build:all
```

Frontend only:

```bash
npm run build
```

Backend only:

```bash
npm run build:backend
```

## Troubleshooting

- **`Invalid IAP credentials: empty token`**
  - Your authenticated session is missing or expired.
  - Re-run a scrape and complete login in the Playwright browser window.
  - If needed, force reset session:
    - UI: `Re-login + reload`
    - API: `POST /api/auth/relogin`
    - Manual: delete `server/.auth/storage-state.json`

- **Browser login window does not appear**
  - Ensure backend process is running.
  - Ensure your environment allows headed browser windows.

- **No rows returned**
  - Verify you can open both target docs pages in a normal browser with your current account.
  - Check backend logs for selector/auth failures.

## Table features

- Sort on every column
- Per-column filters (all filters can be combined in parallel)
- Global case-insensitive contains filter across all columns
- Text filters (`label`, `key`, `default value`, `description`) as case-insensitive contains
- Select filters for non-text columns with unique values from loaded rows
- Multi-select list filters for `allowed scopes` and `editable by` with OR/AND behavior
- Hide/show columns
- Reorder visible columns with drag-and-drop
- Table settings persistence (filters, list modes, visible columns) in local storage

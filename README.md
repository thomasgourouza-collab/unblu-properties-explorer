# Properties Table Explorer

Angular frontend + Node backend that automatically scrapes Unblu internal docs with Playwright and serves cached rows to the table.

## Architecture

- `src/`: Angular app and table UI.
- `server/`: Express API + Playwright scraper.
- `GET /api/properties`: Returns cached rows; triggers scrape only when cache is empty (or after re-login).
- `POST /api/account/connect`: Proxies Unblu `getCurrentAccount?expand=configuration,text` with Basic auth.
- Session state is saved to `server/.auth/storage-state.json` and reused for subsequent scrapes.

## Scraped sources

- `https://udocs.unblu.com/latest-internal/reference/configuration-properties.html`
- `https://udocs.unblu.com/latest-internal/reference/text-properties.html`

## Authentication behavior

- First scrape (or expired session) triggers interactive Google login in a real Playwright browser window.
- After successful login, storage state is persisted and reused automatically.
- Scraped rows are cached in memory and reused across page reloads.
- Re-scraping happens only when the cache is empty or after explicit re-login.
- You can force a fresh login from the UI (`Re-login`) or by calling:

```bash
curl -X POST http://localhost:3000/api/auth/relogin
```

## Connect account import

- Use **Import config → From account** in the table toolbar to open the credential dialog.
- The form asks for:
  - base Unblu URL
  - username
  - password
- On submit, the frontend calls `POST /api/account/connect` and the backend fetches:
  - `<baseUrl>/app/rest/v4/accounts/getCurrentAccount?expand=configuration,text`
  - with Basic auth from submitted credentials.
- Import mapping:
  - `configuration` is imported as-is.
  - `text` is imported by taking each key's `en` value (`key: { en: value }` → `key: value`).
- The full account response is retained in component memory for future features and the merged config is applied through the existing `Import config` pipeline.

## Local development

1. Install frontend dependencies:

```bash
npm install
```

1. Install backend dependencies:

```bash
npm --prefix server install
```

1. Install Playwright Chromium (one-time per machine/user):

```bash
npm --prefix server exec playwright install chromium
```

1. Run frontend + backend together:

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
    - UI: `Re-login`
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

# Properties Table Explorer

Angular frontend + Node backend that scrape Unblu internal docs, cache rows in memory, and provide import/export tools (file + account).

## What is in this repository

- `src/`: Angular UI and table logic.
- `server/`: Express API + Playwright scraper.
- `Dockerfile`: frontend image (Angular build served by Nginx).
- `server/Dockerfile`: backend image (Node + Playwright runtime).
- `docker-compose.yml`: multi-container runtime (`frontend` + `backend`).

## Runtime architecture

### Frontend

- Served by Angular dev server in local dev (`http://localhost:4200`), or Nginx in Docker (`http://localhost:8080`).
- Calls backend APIs under `/api/*`.

### Backend

- Express API on port `3000`.
- Main endpoints:
  - `GET /api/health`
  - `GET /api/properties`
  - `POST /api/auth/relogin`
  - `POST /api/account/connect`
  - `POST /api/account/update`
- Scraper uses Playwright and persists auth state at:
  - `server/.auth/storage-state.json` (host)
  - `/app/.auth/storage-state.json` (container)

### Scraped sources

- `https://udocs.unblu.com/latest-internal/reference/configuration-properties.html`
- `https://udocs.unblu.com/latest-internal/reference/text-properties.html`

## Functional behavior

### Scrape and cache

- First successful scrape is cached in memory.
- Reopening/reloading the frontend reuses cached rows (no re-scrape) until cache is cleared.
- Re-scrape happens when:
  - cache is empty, or
  - `Re-login` is triggered.

### Authentication

- If auth is missing/expired, scraper performs interactive login flow and saves storage state.
- `POST /api/auth/relogin` clears saved auth and forces fresh login + scrape.

### Import from account

- UI path: `Import config -> From account`.
- Frontend calls `POST /api/account/connect` with base URL + credentials.
- Backend fetches:
  - `<baseUrl>/app/rest/v4/accounts/getCurrentAccount?expand=configuration,text`
- Merged data (`configuration` + `text[*].en`) is applied through existing import pipeline.

### Export to account

- UI path: `Export config -> To account`.
- Selected rows are patched into connected account payload based on `Source`:
  - contains `configuration` -> `configuration[key] = value`
  - contains `text` -> `text[key].en = value`
- Frontend calls `POST /api/account/update`.
- Backend proxies to:
  - `<baseUrl>/app/rest/v4/accounts/update?expand=configuration,text`

## Local development

### Prerequisites

- Node.js 22+
- npm 11+

### Install

```bash
npm install
npm --prefix server install
npm --prefix server exec playwright install chromium
```

### Run frontend + backend

```bash
npm run start:dev
```

- Frontend: `http://localhost:4200`
- Backend: `http://localhost:3000`

Angular dev proxy routes `/api/*` to backend using `proxy.conf.json`.

## Docker

This project uses **two images** and runs best with **Docker Compose**:

- `frontend` image from root `Dockerfile` (Nginx + Angular static build)
- `backend` image from `server/Dockerfile` (Express + Playwright)

### Build and run

```bash
docker compose up --build
```

Services:

- Frontend: `http://localhost:8080`
- Backend: `http://localhost:3000`

Nginx proxies `/api/*` to backend service (`http://backend:3000`) via `nginx.conf`.

### Stop and remove containers

```bash
docker compose down
```

### Docker without GUI: container cannot open Google login window

Use this workflow once, then Docker will work with saved auth state:

1. **Stop compose**

```bash
docker compose down
```

2. **Run backend locally** (non-container) so login window can open:

```bash
npm --prefix server install
npm run start:backend
```

3. **Trigger relogin** from the UI (`http://localhost:4200` if running the frontend locally) or via API:

```bash
curl -X POST http://localhost:3000/api/auth/relogin
```

4. **Complete Google login** in the opened browser window.

This creates or updates: `server/.auth/storage-state.json`

5. **Stop the local backend**, then run Docker again:

```bash
docker compose up --build
```

Because compose mounts `./server/.auth:/app/.auth`, the backend container reuses that saved auth state and can scrape without interactive login.

If the session expires later, repeat the same bootstrap flow.

### Notes for Playwright auth in container

- Compose mounts `./server/.auth` into the backend container (`/app/.auth`) to persist session state.
- Interactive/headed login needs a display; see **Docker without GUI** above for the host bootstrap workflow.

## Build commands (without Docker)

```bash
npm run build
npm run build:backend
npm run build:all
```

## Troubleshooting

### Invalid IAP credentials / auth errors

- Session is missing/expired.
- Trigger `Re-login` in UI, or:

```bash
curl -X POST http://localhost:3000/api/auth/relogin
```

- If needed, delete saved state: `server/.auth/storage-state.json`.

### Backend cannot scrape in Docker

- Check backend logs: `docker compose logs backend`.
- Confirm container can reach Unblu domains and your auth flow is compatible with container runtime.
- If you see a Playwright executable mismatch ("current image" vs "required"), rebuild with matching versions:

```bash
docker compose build --no-cache backend
docker compose up
```

- Backend image and server dependency are pinned to Playwright `1.59.1` and must stay aligned.
- If you see "headed browser without XServer" / "$DISPLAY missing":
  - container cannot run interactive login UI;
  - bootstrap auth on host backend once (creates `server/.auth/storage-state.json`);
  - then run Docker Compose so backend reuses that mounted auth state.

### Frontend loads but API fails in Docker

- Ensure backend service is healthy in compose.
- Ensure Nginx proxy config is present (`location /api/` in `nginx.conf`).

## Table features

- Sorting on all columns
- Per-column filters (combinable)
- Global filter with expression/regex options
- Hide/show and reorder columns
- Selection-aware export
- Import config from file or account
- Export config to file or account
- Table settings persistence in local storage

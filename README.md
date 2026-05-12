# Properties Table Explorer

Frontend-only Angular app that displays a table of Unblu properties (configuration + text) loaded from a static JSON snapshot. The snapshot is regenerated on demand by a standalone Node script that scrapes the Unblu internal docs with Playwright.

## What is in this repository

- `src/`: Angular UI and table logic.
- `src/assets/properties-snapshot.json`: bundled properties snapshot loaded at startup.
- `scripts/`: standalone Node + Playwright scraper that writes the snapshot file.
- `.github/workflows/deploy.yml`: GitHub Actions workflow that builds and publishes the app to GitHub Pages.

## Runtime architecture

Static SPA. At startup the app does:

```
fetch('assets/properties-snapshot.json')
```

No backend, no `/api/*` routes. Connecting to Unblu instances (account import/export, API keys, global config) has been removed; configuration import/export is file-only (CSV, JSON, YAML, .properties).

## Local development

### Prerequisites

- Node.js 22+
- npm 11+

### Install and run

```bash
npm install
npm start
```

App: `http://localhost:4200`

The bundled snapshot ships empty by default. Regenerate it (next section) to populate the table.

## Regenerating the properties snapshot

The scraper is a one-shot Node script that uses Playwright to read the Unblu internal docs and writes the result to `src/assets/properties-snapshot.json`.

### One-time setup

```bash
npm install
npx playwright install chromium
```

### Run the scraper

```bash
npm run scrape:snapshot
```

First run opens a headed Chromium window for Google IAP login. After login, the script saves auth state to `scripts/.auth/storage-state.json` (gitignored) and scrapes. Subsequent runs reuse the saved auth until it expires.

To force a re-login (e.g. after auth expiry):

```bash
npm run scrape:snapshot:force
```

Sources scraped:

- `https://udocs.unblu.com/latest-internal/reference/configuration-properties.html`
- `https://udocs.unblu.com/latest-internal/reference/text-properties.html`

## Build

```bash
npm run build
```

Output lands in `dist/csv-table-app/browser/` as a static bundle that can be served by any static-file host.

## Deploy to GitHub Pages

The repo ships with [.github/workflows/deploy.yml](.github/workflows/deploy.yml), which builds with the right base-href and publishes to GitHub Pages on every push to `main`.

One-time setup: in **Settings → Pages → Source**, select **GitHub Actions**.

The deployed site bakes in whatever snapshot is committed at `src/assets/properties-snapshot.json` at build time. To ship a fresh snapshot, run `npm run scrape:snapshot` locally, commit the result, and push.

To build locally with the GH Pages base-href:

```bash
npm run build:gh-pages
```

## Table features

- Sorting on all columns
- Per-column filters (combinable)
- Global filter with expression/regex options
- Hide/show and reorder columns
- Selection-aware export
- Import configuration from file (CSV, JSON, YAML, .properties)
- Export selection to file (CSV, JSON, YAML, .properties)
- Table settings persistence in local storage

# Properties Table Explorer

Frontend-only Angular app that displays a table of Unblu properties (configuration + text) loaded from a `mergedConfigurationSchema_en.json` file exported from Unblu.

## What is in this repository

- `src/`: Angular UI and table logic.
- `src/assets/mergedConfigurationSchema_en.json`: bundled schema loaded at startup.
- `.github/workflows/deploy.yml`: GitHub Actions workflow that builds and publishes the app to GitHub Pages.

## Runtime architecture

Static SPA. At startup the app does:

```
fetch('assets/mergedConfigurationSchema_en.json')
```

If the bundled file is absent, the empty state becomes a drop zone where any `mergedConfigurationSchema_en.json` can be uploaded. The "Upload schema" header button does the same thing at any time and replaces the current dataset.

No backend, no `/api/*` routes. Configuration import/export is file-only (CSV, JSON, YAML, .properties).

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

## Updating the schema

The schema file lives at `src/assets/mergedConfigurationSchema_en.json`. To ship a new version:

1. Drop a fresh export into `src/assets/`, overwriting the existing file.
2. Commit and push — the GitHub Pages workflow will redeploy automatically.

Or, at runtime, click **Upload schema** in the app header (or drop the file onto the empty-state zone) to load a schema without rebuilding. This is per-browser-session and does not persist.

## Build

```bash
npm run build
```

Output lands in `dist/csv-table-app/browser/` as a static bundle that can be served by any static-file host.

## Deploy to GitHub Pages

The repo ships with [.github/workflows/deploy.yml](.github/workflows/deploy.yml), which builds with the right base-href and publishes to GitHub Pages on every push to `main`.

One-time setup: in **Settings → Pages → Source**, select **GitHub Actions**.

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

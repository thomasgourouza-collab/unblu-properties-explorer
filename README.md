# Properties Table Explorer

Interactive Angular app to upload a CSV file and explore it with sorting, filtering, and customizable columns.

## Stack

- Angular (latest stable CLI at generation time)
- PrimeNG table components
- Bootstrap + SCSS
- PapaParse for CSV parsing

## Run locally

```bash
npm install
npm start
```

Open [http://localhost:4200](http://localhost:4200).

## Docker

Build a production image (multi-stage: `npm run build`, then serve static files with nginx):

```bash
docker build -t unblu-properties-explorer .
```

Run the app (maps container port 80 to **3000** on your machine):

```bash
docker run -d --name unblu-properties-explorer -p 3000:80 unblu-properties-explorer:latest
```

Open [http://localhost:3000](http://localhost:3000).

To stop, use:

```bash
docker stop unblu-properties-explorer
```

To start use:

```bash
docker start unblu-properties-explorer
```

## Build

```bash
npm run build
```

## CSV format contract

The upload expects a header row with these columns (case-insensitive):

1. `group title`
2. `label`
3. `key`
4. `default value`
5. `type`
6. `allowed scopes`
7. `visibility`
8. `editable by`
9. `description`

## Table features

- Sort on every column
- Per-column filters (all filters can be combined in parallel)
- Global case-insensitive contains filter across all columns
- Text filters (`label`, `key`, `default value`, `description`) as case-insensitive contains
- Select filters for non-text columns with unique values from the loaded file
- Multi-select list filters for `allowed scopes` and `editable by` with OR/AND behavior:
  - OR: any selected value matches any token in row list
  - AND: all selected values must be present in row list
- Hide/show columns
- Reorder visible columns with drag-and-drop
- Table settings persistence (filters, list modes, visible columns) in local storage

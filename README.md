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

## Build

```bash
npm run build
```

## CSV format contract

The upload expects a header row with these columns (case-insensitive):

1. `category`
2. `property title`
3. `property`
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
- Text filters (`property title`, `property`, `default value`, `description`) as case-insensitive contains
- Select filters for non-text columns with unique values from the loaded file
- Multi-select list filters for `allowed scopes` and `editable by` with OR/AND behavior:
  - OR: any selected value matches any token in row list
  - AND: all selected values must be present in row list
- Hide/show columns
- Reorder visible columns with drag-and-drop
- Table settings persistence (filters, list modes, visible columns) in local storage

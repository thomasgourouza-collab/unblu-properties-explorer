import type { ColumnDefinition, ConfigRow } from '../../../models/config-row.model';

export interface ActiveFilterChip {
  id: string;
  label: string;
  kind: 'global' | 'text' | 'value';
  columnKey?: string;
  value?: string;
}

export function buildActiveFilterChips(
  columns: ColumnDefinition[],
  globalFilter: string,
  textFilters: Partial<Record<string, string>>,
  valueFilters: Partial<Record<string, string[]>>,
  formatValueLabel: (value: string) => string
): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];

  if (globalFilter.trim()) {
    chips.push({
      id: 'global',
      label: `Global: ${globalFilter.trim()}`,
      kind: 'global'
    });
  }

  for (const column of columns) {
    const textValue = textFilters[column.key]?.trim();
    if (textValue) {
      chips.push({
        id: `text:${column.key}`,
        label: `${column.label}: ${textValue}`,
        kind: 'text',
        columnKey: column.key
      });
    }

    const selectedValues = valueFilters[column.key] ?? [];
    for (const value of selectedValues) {
      chips.push({
        id: `value:${column.key}:${value}`,
        label: `${column.label}: ${formatValueLabel(value)}`,
        kind: 'value',
        columnKey: column.key,
        value
      });
    }
  }

  return chips;
}

export function buildDisplayedRows(
  filteredRows: ConfigRow[],
  options: {
    showSelectedRowsOnly: boolean;
    showConfigRowsOnly: boolean;
    selectedRowKeys: Set<string>;
    configImportRowKeys: Set<string>;
  }
): ConfigRow[] {
  let rows = filteredRows;
  if (options.showSelectedRowsOnly) {
    rows = rows.filter((row) => options.selectedRowKeys.has(row.rowKey));
  }
  if (options.showConfigRowsOnly) {
    rows = rows.filter((row) => options.configImportRowKeys.has(row.rowKey));
  }
  return rows;
}

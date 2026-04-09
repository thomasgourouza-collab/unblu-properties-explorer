import type { ConfigRow } from '../../../models/config-row.model';

export function countSelectedDatasetRows(rows: ConfigRow[], selectedRowKeys: Set<string>): number {
  return rows.filter((row) => selectedRowKeys.has(row.rowKey)).length;
}

export function countSelectedFilteredRows(filteredRows: ConfigRow[], selectedRowKeys: Set<string>): number {
  return filteredRows.filter((row) => selectedRowKeys.has(row.rowKey)).length;
}

export function buildSelectionHeaderAriaLabel(selectedFilteredCount: number, selectedDatasetCount: number): string {
  if (selectedDatasetCount === 0) {
    return '0 rows selected';
  }
  if (selectedFilteredCount === selectedDatasetCount) {
    return `${selectedDatasetCount} rows selected`;
  }
  return `${selectedFilteredCount} selected in current filter, ${selectedDatasetCount} selected in loaded dataset`;
}

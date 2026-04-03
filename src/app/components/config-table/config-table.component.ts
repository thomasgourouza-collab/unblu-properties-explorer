import { CommonModule } from '@angular/common';
import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MultiSelectModule } from 'primeng/multiselect';
import { TableColumnReorderEvent, TableModule } from 'primeng/table';

import { ColumnDefinition, ConfigColumnKey, ConfigRow, FilterMode } from '../../models/config-row.model';

interface SelectOption {
  label: string;
  value: string;
}

interface ActiveFilterChip {
  id: string;
  label: string;
  kind: 'global' | 'text' | 'value' | 'listMode';
  columnKey?: ConfigColumnKey;
  value?: string;
}

type ListColumnKey = 'allowedScopes' | 'editableBy';

interface TableState {
  globalFilter: string;
  textFilters: Partial<Record<ConfigColumnKey, string>>;
  valueFilters: Partial<Record<ConfigColumnKey, string[]>>;
  listModes: Record<ListColumnKey, FilterMode>;
  visibleColumnKeys: ConfigColumnKey[];
}

@Component({
  selector: 'app-config-table',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, MultiSelectModule],
  templateUrl: './config-table.component.html',
  styleUrl: './config-table.component.scss'
})
export class ConfigTableComponent implements OnChanges {
  @Input({ required: true }) rows: ConfigRow[] = [];
  rowsPerPage = 25;
  readonly rowsPerPageOptions = [10, 25, 50, 100];

  readonly columns: ColumnDefinition[] = [
    { key: 'category', label: 'Category', filterType: 'select' },
    { key: 'propertyTitle', label: 'Property title', filterType: 'text' },
    { key: 'property', label: 'Property', filterType: 'text' },
    { key: 'defaultValue', label: 'Default value', filterType: 'text' },
    { key: 'type', label: 'Type', filterType: 'select' },
    { key: 'allowedScopes', label: 'Allowed scopes', filterType: 'list' },
    { key: 'visibility', label: 'Visibility', filterType: 'select' },
    { key: 'editableBy', label: 'Editable by', filterType: 'list' },
    { key: 'description', label: 'Description', filterType: 'text' }
  ];

  filteredRows: ConfigRow[] = [];
  globalFilter = '';
  textFilters: Partial<Record<ConfigColumnKey, string>> = {};
  valueFilters: Partial<Record<ConfigColumnKey, string[]>> = {};
  listModes: Record<ListColumnKey, FilterMode> = {
    allowedScopes: 'or',
    editableBy: 'or'
  };
  visibleColumnKeys: ConfigColumnKey[] = this.columns.map((column) => column.key);
  filterOptions: Partial<Record<ConfigColumnKey, SelectOption[]>> = {};

  private readonly stateStorageKey = 'csv-explorer-table-state-v1';
  private restoredState = false;
  private readonly textFilterColumns = new Set<ConfigColumnKey>([
    'propertyTitle',
    'property',
    'defaultValue',
    'description'
  ]);

  get visibleColumns(): ColumnDefinition[] {
    return this.visibleColumnKeys
      .map((key) => this.columns.find((column) => column.key === key))
      .filter((column): column is ColumnDefinition => Boolean(column));
  }

  get columnVisibilityOptions(): SelectOption[] {
    return this.columns.map((column) => ({
      label: column.label,
      value: column.key
    }));
  }

  get activeFilterChips(): ActiveFilterChip[] {
    const chips: ActiveFilterChip[] = [];

    if (this.globalFilter.trim()) {
      chips.push({
        id: 'global',
        label: `Global: ${this.globalFilter.trim()}`,
        kind: 'global'
      });
    }

    for (const column of this.columns) {
      const textValue = this.textFilters[column.key]?.trim();
      if (textValue) {
        chips.push({
          id: `text:${column.key}`,
          label: `${column.label}: ${textValue}`,
          kind: 'text',
          columnKey: column.key
        });
      }

      const selectedValues = this.valueFilters[column.key] ?? [];
      for (const value of selectedValues) {
        chips.push({
          id: `value:${column.key}:${value}`,
          label: `${column.label}: ${value}`,
          kind: 'value',
          columnKey: column.key,
          value
        });
      }

      if (column.filterType === 'list' && selectedValues.length > 0) {
        const mode = this.getListMode(column.key).toUpperCase();
        chips.push({
          id: `listMode:${column.key}`,
          label: `${column.label} mode: ${mode}`,
          kind: 'listMode',
          columnKey: column.key
        });
      }
    }

    return chips;
  }

  get hasActiveFilters(): boolean {
    return this.activeFilterChips.length > 0;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['rows']) {
      return;
    }

    if (!this.restoredState) {
      this.restoreState();
      this.restoredState = true;
    }

    this.filterOptions = this.buildFilterOptions(this.rows);
    this.sanitizeFilters();
    this.applyFilters();
  }

  onColumnVisibilityChange(): void {
    if (this.visibleColumnKeys.length === 0) {
      this.visibleColumnKeys = [this.columns[0].key];
    }

    this.persistState();
  }

  onColumnReorder(event: TableColumnReorderEvent): void {
    if (!event.columns) {
      return;
    }

    this.visibleColumnKeys = event.columns
      .map((column) => column.key)
      .filter((key: unknown): key is ConfigColumnKey =>
        this.columns.some((column) => column.key === key)
      );
    this.persistState();
  }

  onFiltersChanged(): void {
    this.applyFilters();
    this.persistState();
  }

  getTextFilter(key: ConfigColumnKey): string {
    return this.textFilters[key] ?? '';
  }

  setTextFilter(key: ConfigColumnKey, value: string): void {
    this.textFilters[key] = value;
    this.onFiltersChanged();
  }

  getValueFilter(key: ConfigColumnKey): string[] {
    return this.valueFilters[key] ?? [];
  }

  setValueFilter(key: ConfigColumnKey, values: string[] | undefined): void {
    this.valueFilters[key] = values ?? [];
    this.onFiltersChanged();
  }

  getFilterOptions(key: ConfigColumnKey): SelectOption[] {
    return this.filterOptions[key] ?? [];
  }

  getListMode(key: ConfigColumnKey): FilterMode {
    return this.listModes[this.toListColumnKey(key)];
  }

  setListMode(key: ConfigColumnKey, mode: string): void {
    this.listModes[this.toListColumnKey(key)] = mode === 'and' ? 'and' : 'or';
    this.onFiltersChanged();
  }

  onRowsPerPageChange(value: string | number): void {
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && parsed > 0) {
      this.rowsPerPage = parsed;
    }
  }

  clearFilters(): void {
    this.globalFilter = '';
    this.textFilters = {};
    this.valueFilters = {};
    this.listModes = {
      allowedScopes: 'or',
      editableBy: 'or'
    };
    this.applyFilters();
    this.persistState();
  }

  clearAllFilters(): void {
    this.clearFilters();
  }

  removeFilterChip(chip: ActiveFilterChip): void {
    if (chip.kind === 'global') {
      this.globalFilter = '';
      this.onFiltersChanged();
      return;
    }

    if (!chip.columnKey) {
      return;
    }

    if (chip.kind === 'text') {
      this.textFilters[chip.columnKey] = '';
      this.onFiltersChanged();
      return;
    }

    if (chip.kind === 'value' && chip.value !== undefined) {
      const values = this.valueFilters[chip.columnKey] ?? [];
      this.valueFilters[chip.columnKey] = values.filter((value) => value !== chip.value);
      this.onFiltersChanged();
      return;
    }

    if (chip.kind === 'listMode') {
      const listKey = this.toListColumnKey(chip.columnKey);
      this.listModes[listKey] = 'or';
      this.onFiltersChanged();
    }
  }

  private applyFilters(): void {
    const globalFilter = this.normalize(this.globalFilter);

    this.filteredRows = this.rows.filter((row) => {
      if (globalFilter && !this.rowMatchesGlobalFilter(row, globalFilter)) {
        return false;
      }

      for (const column of this.columns) {
        if (!this.rowMatchesColumnFilter(row, column)) {
          return false;
        }
      }

      return true;
    });
  }

  private rowMatchesGlobalFilter(row: ConfigRow, globalFilter: string): boolean {
    return this.columns.some((column) => this.normalize(this.getCellValue(row, column.key)).includes(globalFilter));
  }

  private rowMatchesColumnFilter(row: ConfigRow, column: ColumnDefinition): boolean {
    const textFilter = this.normalize(this.textFilters[column.key] ?? '');
    if (textFilter) {
      const value = this.normalize(this.getCellValue(row, column.key));
      if (!value.includes(textFilter)) {
        return false;
      }
    }

    const selectedValues = this.valueFilters[column.key] ?? [];
    if (selectedValues.length === 0) {
      return true;
    }

    if (column.filterType === 'list') {
        const listKey = this.toListColumnKey(column.key);
      const selectedNormalized = selectedValues.map((value) => this.normalize(value));
      const tokens = new Set((listKey === 'allowedScopes' ? row.allowedScopesTokens : row.editableByTokens).map((value) =>
        this.normalize(value)
      ));

        if (this.listModes[listKey] === 'and') {
        return selectedNormalized.every((selected) => tokens.has(selected));
      }

      return selectedNormalized.some((selected) => tokens.has(selected));
    }

    if (this.textFilterColumns.has(column.key)) {
      return true;
    }

    const rowValue = this.normalize(this.getCellValue(row, column.key));
    return selectedValues.map((value) => this.normalize(value)).includes(rowValue);
  }

  private sanitizeFilters(): void {
    for (const column of this.columns) {
      if (column.filterType === 'text') {
        continue;
      }

      const availableValues = new Set((this.filterOptions[column.key] ?? []).map((option) => option.value));
      const selectedValues = this.valueFilters[column.key] ?? [];
      this.valueFilters[column.key] = selectedValues.filter((value) => availableValues.has(value));
    }
  }

  private buildFilterOptions(rows: ConfigRow[]): Partial<Record<ConfigColumnKey, SelectOption[]>> {
    const optionsMap: Partial<Record<ConfigColumnKey, SelectOption[]>> = {};

    for (const column of this.columns) {
      if (column.filterType === 'text') {
        continue;
      }

      const values = new Set<string>();

      for (const row of rows) {
        if (column.filterType === 'list') {
          const listValues = column.key === 'allowedScopes' ? row.allowedScopesTokens : row.editableByTokens;
          for (const listValue of listValues) {
            if (listValue) {
              values.add(listValue);
            }
          }
        } else {
          const value = this.getCellValue(row, column.key);
          if (value) {
            values.add(value);
          }
        }
      }

      optionsMap[column.key] = [...values]
        .sort((left, right) => left.localeCompare(right))
        .map((value) => ({ label: value, value }));
    }

    return optionsMap;
  }

  private getCellValue(row: ConfigRow, key: ConfigColumnKey): string {
    return row[key] ?? '';
  }

  getRgbaColor(value: string): string | null {
    const rgbaWithAlphaPattern =
      /rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|1|0?\.\d+)\s*\)/i;
    const rgbaWithAlphaMatch = rgbaWithAlphaPattern.exec(value);
    if (rgbaWithAlphaMatch) {
      return rgbaWithAlphaMatch[0];
    }

    const rgbLikePattern = /(rgba?)\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/i;
    const rgbLikeMatch = rgbLikePattern.exec(value);
    if (!rgbLikeMatch) {
      return null;
    }

    const fn = rgbLikeMatch[1].toLowerCase();
    const r = rgbLikeMatch[2];
    const g = rgbLikeMatch[3];
    const b = rgbLikeMatch[4];

    return fn === 'rgba' ? `rgb(${r},${g},${b})` : rgbLikeMatch[0];
  }

  private normalize(value: string): string {
    return value.toLowerCase().trim();
  }

  private toListColumnKey(key: ConfigColumnKey): ListColumnKey {
    return key === 'allowedScopes' ? 'allowedScopes' : 'editableBy';
  }

  private restoreState(): void {
    try {
      const rawState = localStorage.getItem(this.stateStorageKey);
      if (!rawState) {
        return;
      }

      const parsedState = JSON.parse(rawState) as TableState;
      this.globalFilter = parsedState.globalFilter ?? '';
      this.textFilters = parsedState.textFilters ?? {};
      this.valueFilters = parsedState.valueFilters ?? {};
      this.listModes = {
        allowedScopes: parsedState.listModes?.allowedScopes === 'and' ? 'and' : 'or',
        editableBy: parsedState.listModes?.editableBy === 'and' ? 'and' : 'or'
      };

      const validColumns = (parsedState.visibleColumnKeys ?? []).filter((key) =>
        this.columns.some((column) => column.key === key)
      );
      this.visibleColumnKeys = validColumns.length > 0 ? validColumns : this.columns.map((column) => column.key);
    } catch {
      this.visibleColumnKeys = this.columns.map((column) => column.key);
    }
  }

  private persistState(): void {
    const state: TableState = {
      globalFilter: this.globalFilter,
      textFilters: this.textFilters,
      valueFilters: this.valueFilters,
      listModes: this.listModes,
      visibleColumnKeys: this.visibleColumnKeys
    };

    localStorage.setItem(this.stateStorageKey, JSON.stringify(state));
  }
}

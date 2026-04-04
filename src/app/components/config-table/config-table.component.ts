import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, ElementRef, HostListener, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MultiSelectModule } from 'primeng/multiselect';
import { TableColumnReorderEvent, TableModule } from 'primeng/table';

import { ColumnDefinition, ConfigColumnKey, ConfigRow, FilterMode } from '../../models/config-row.model';

interface SelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

interface HighlightPart {
  text: string;
  kind: 'none' | 'global' | 'column';
}

interface ActiveFilterChip {
  id: string;
  label: string;
  kind: 'global' | 'text' | 'value' | 'listMode';
  columnKey?: ConfigColumnKey;
  value?: string;
}

type ListColumnKey = 'allowedScopes' | 'editableBy';
type GlobalFilterScope = 'all' | 'visible';
type TextMatchMode = 'or' | 'and' | 'regex';

interface TableState {
  globalFilter: string;
  globalFilterMode?: TextMatchMode;
  globalFilterScope?: GlobalFilterScope;
  textFilters: Partial<Record<ConfigColumnKey, string>>;
  textModes?: Partial<Record<ConfigColumnKey, TextMatchMode>>;
  valueFilters: Partial<Record<ConfigColumnKey, string[]>>;
  listModes: Record<ListColumnKey, FilterMode>;
  visibleColumnKeys: ConfigColumnKey[];
  columnOrderKeys?: ConfigColumnKey[];
}

@Component({
  selector: 'app-config-table',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, MultiSelectModule],
  templateUrl: './config-table.component.html',
  styleUrl: './config-table.component.scss'
})
export class ConfigTableComponent implements OnChanges, OnDestroy {
  constructor(private readonly cdr: ChangeDetectorRef) {}

  @Input({ required: true }) rows: ConfigRow[] = [];
  @ViewChild('globalFilterInputRef') globalFilterInputRef?: ElementRef<HTMLInputElement>;
  rowsPerPage = 25;
  readonly rowsPerPageOptions = [10, 25, 50, 100];

  readonly columns: ColumnDefinition[] = [
    { key: 'category', label: 'Category', filterType: 'select' },
    { key: 'propertyTitle', label: 'Property title', filterType: 'text' },
    { key: 'property', label: 'Property', filterType: 'text' },
    { key: 'defaultValue', label: 'Default value', filterType: 'text' },
    { key: 'type', label: 'Type', filterType: 'select' },
    { key: 'allowedValues', label: 'Allowed values', filterType: 'text' },
    { key: 'allowedScopes', label: 'Allowed scopes', filterType: 'list' },
    { key: 'visibility', label: 'Visibility', filterType: 'select' },
    { key: 'editableBy', label: 'Editable by', filterType: 'list' },
    { key: 'description', label: 'Description', filterType: 'text' }
  ];

  filteredRows: ConfigRow[] = [];
  globalFilter = '';
  globalFilterMode: TextMatchMode = 'or';
  globalFilterScope: GlobalFilterScope = 'all';
  textFilters: Partial<Record<ConfigColumnKey, string>> = {};
  textModes: Partial<Record<ConfigColumnKey, TextMatchMode>> = {};
  valueFilters: Partial<Record<ConfigColumnKey, string[]>> = {};
  listModes: Record<ListColumnKey, FilterMode> = {
    allowedScopes: 'or',
    editableBy: 'or'
  };
  visibleColumnKeys: ConfigColumnKey[] = this.columns.map((column) => column.key);
  columnOrderKeys: ConfigColumnKey[] = this.columns.map((column) => column.key);
  filterOptions: Partial<Record<ConfigColumnKey, SelectOption[]>> = {};
  private readonly emptyFilterValues: string[] = [];
  copiedPropertyValue: string | null = null;
  private copyResetTimerId?: ReturnType<typeof globalThis.setTimeout>;
  isCellHoverTooltipOpen = false;
  cellHoverTooltipText = '';
  cellHoverTooltipColumnKey: ConfigColumnKey | null = null;
  cellHoverTooltipLeft = 0;
  cellHoverTooltipTop = 0;

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
      .filter((column) => column?.key !== 'allowedValues' || this.hasAllowedValuesColumn)
      .filter((column): column is ColumnDefinition => Boolean(column));
  }

  get columnVisibilityOptions(): SelectOption[] {
    return this.columnOrderKeys
      .filter((key) => key !== 'allowedValues' || this.hasAllowedValuesColumn)
      .map((key) => {
      const column = this.columns.find((entry) => entry.key === key);
      return {
        label: column?.label ?? key,
        value: key,
        disabled: key === 'property'
      };
      });
  }

  get hasAllowedValuesColumn(): boolean {
    return this.rows.some((row) => row.hasAllowedValuesColumn);
  }

  get visibleDisplayableColumnsCount(): number {
    return this.visibleColumns.length;
  }

  get totalDisplayableColumnsCount(): number {
    return this.columns.filter((column) => column.key !== 'allowedValues' || this.hasAllowedValuesColumn).length;
  }

  get uniformColumnWidthPercent(): number {
    return 100 / Math.max(this.visibleColumns.length, 1);
  }

  getColumnWidthPercent(columnKey: ConfigColumnKey): number {
    const hasPropertyColumn = this.visibleColumns.some((column) => column.key === 'property');
    const propertyWidthUnits = 2.5;
    const totalUnits = this.visibleColumns.length + (hasPropertyColumn ? propertyWidthUnits - 1 : 0);
    if (totalUnits <= 0) {
      return 100;
    }

    const unit = 100 / totalUnits;
    return columnKey === 'property' && hasPropertyColumn ? unit * propertyWidthUnits : unit;
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

  ngOnDestroy(): void {
    if (this.copyResetTimerId !== undefined) {
      globalThis.clearTimeout(this.copyResetTimerId);
    }
  }

  onColumnVisibilityChange(): void {
    const selectedSet = new Set(this.ensurePropertyVisible(this.visibleColumnKeys));
    this.visibleColumnKeys = this.columnOrderKeys.filter((key) => selectedSet.has(key));

    if (this.visibleColumnKeys.length === 0 && this.columnOrderKeys.length > 0) {
      this.visibleColumnKeys = [this.columnOrderKeys[0]];
    }

    this.onFiltersChanged();
  }

  onColumnReorder(event: TableColumnReorderEvent): void {
    if (!event.columns) {
      return;
    }

    this.visibleColumnKeys = this.ensurePropertyVisible(
      event.columns
      .map((column) => column.key)
      .filter((key: unknown): key is ConfigColumnKey =>
        this.columns.some((column) => column.key === key)
      )
    );

    this.syncColumnOrderFromVisibleOrder(this.visibleColumnKeys);
    this.persistState();
  }

  onFiltersChanged(): void {
    this.applyFilters();
    this.persistState();
  }

  onGlobalFilterInputChange(value: string): void {
    this.globalFilter = value;
    this.onFiltersChanged();
  }

  getTextFilter(key: ConfigColumnKey): string {
    return this.textFilters[key] ?? '';
  }

  setTextFilter(key: ConfigColumnKey, value: string): void {
    this.textFilters[key] = value;
    this.onFiltersChanged();
  }

  getTextMode(key: ConfigColumnKey): TextMatchMode {
    const mode = this.textModes[key];
    return mode === 'and' || mode === 'regex' ? mode : 'or';
  }

  setTextMode(key: ConfigColumnKey, mode: string): void {
    this.textModes[key] = mode === 'and' || mode === 'regex' ? mode : 'or';
    this.onFiltersChanged();
  }

  setGlobalFilterMode(mode: string): void {
    this.globalFilterMode = mode === 'and' || mode === 'regex' ? mode : 'or';
    this.onFiltersChanged();
  }

  clearGlobalFilterInput(): void {
    if (!this.globalFilter) {
      return;
    }
    this.globalFilter = '';
    this.onFiltersChanged();
  }

  clearTextFilterInput(key: ConfigColumnKey): void {
    if (!this.textFilters[key]) {
      return;
    }
    this.textFilters[key] = '';
    this.onFiltersChanged();
  }

  setGlobalFilterScope(scope: string): void {
    this.globalFilterScope = scope === 'visible' ? 'visible' : 'all';
    this.onFiltersChanged();
  }

  onCellHoverEnter(event: MouseEvent, value: string, columnKey: ConfigColumnKey): void {
    if (!this.isHoverTooltipModifierPressed(event)) {
      this.onCellHoverLeave();
      return;
    }

    const text = value?.trim() ?? '';
    if (!text) {
      this.onCellHoverLeave();
      return;
    }
    this.cellHoverTooltipText = text;
    this.cellHoverTooltipColumnKey = columnKey;
    this.isCellHoverTooltipOpen = true;
    this.positionCellHoverTooltip(event);
  }

  onCellHoverMove(event: MouseEvent, value: string, columnKey: ConfigColumnKey): void {
    if (!this.isHoverTooltipModifierPressed(event)) {
      this.onCellHoverLeave();
      return;
    }

    if (!this.isCellHoverTooltipOpen) {
      this.onCellHoverEnter(event, value, columnKey);
      return;
    }

    this.positionCellHoverTooltip(event);
  }

  onCellHoverLeave(): void {
    this.isCellHoverTooltipOpen = false;
    this.cellHoverTooltipColumnKey = null;
  }

  getColumnLabel(columnKey: ConfigColumnKey | null): string {
    if (!columnKey) {
      return 'Value';
    }
    return this.columns.find((column) => column.key === columnKey)?.label ?? 'Value';
  }

  getValueFilter(key: ConfigColumnKey): string[] {
    return this.valueFilters[key] ?? this.emptyFilterValues;
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
    this.globalFilterMode = 'or';
    this.globalFilterScope = 'all';
    this.textFilters = {};
    this.textModes = {};
    this.valueFilters = {};
    this.listModes = {
      allowedScopes: 'or',
      editableBy: 'or'
    };
    this.onFiltersChanged();
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
    const globalTokens = this.splitFilterTokens(this.globalFilter, this.globalFilterMode);
    const globalRegex = this.globalFilterMode === 'regex' ? this.tryParseRegexInput(this.globalFilter) : null;

    this.filteredRows = this.rows.filter((row) => {
      if ((globalTokens.length > 0 || globalRegex) && !this.rowMatchesGlobalFilter(row, globalTokens, globalRegex)) {
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

  private rowMatchesGlobalFilter(row: ConfigRow, tokens: string[], regex: RegExp | null): boolean {
    const columnsToSearch = this.globalFilterScope === 'visible' ? this.visibleColumns : this.columns;
    const rawValues = columnsToSearch.map((column) => this.getCellValue(row, column.key));
    if (this.globalFilterMode === 'regex') {
      if (!regex) {
        return false;
      }
      return rawValues.some((value) => this.matchesRegex(value, regex));
    }

    const rowValues = rawValues.map((value) => this.normalize(value));
    if (this.globalFilterMode === 'and') {
      return tokens.every((token) => rowValues.some((value) => value.includes(token)));
    }
    return tokens.some((token) => rowValues.some((value) => value.includes(token)));
  }

  private rowMatchesColumnFilter(row: ConfigRow, column: ColumnDefinition): boolean {
    const textMode = this.getTextMode(column.key);
    const textTokens = this.splitFilterTokens(this.textFilters[column.key] ?? '', textMode);
    const textRegex = textMode === 'regex' ? this.tryParseRegexInput(this.textFilters[column.key] ?? '') : null;
    if (textTokens.length > 0 || textRegex) {
      const value = this.getCellValue(row, column.key);
      if (!this.matchesTokens(value, textTokens, textMode, textRegex)) {
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

  getDefaultValueParts(value = ''): string[] {
    const trimmed = value.trim();
    if (!trimmed) {
      return [''];
    }

    // Handle JSON-like color lists such as ["#c01160","#766554"].
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.map((entry) => String(entry ?? '').trim());
        }
      } catch {
        // Fall through to generic splitting when the value is not valid JSON.
      }
    }

    return this.splitTopLevelValues(trimmed);
  }

  private splitTopLevelValues(input: string): string[] {
    const parts: string[] = [];
    let current = '';
    let parenDepth = 0;
    let bracketDepth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (const char of input) {
      if (char === '\'' && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        current += char;
        continue;
      }
      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        current += char;
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote) {
        if (char === '(') {
          parenDepth += 1;
          current += char;
          continue;
        }
        if (char === ')' && parenDepth > 0) {
          parenDepth -= 1;
          current += char;
          continue;
        }
        if (char === '[') {
          bracketDepth += 1;
          current += char;
          continue;
        }
        if (char === ']' && bracketDepth > 0) {
          bracketDepth -= 1;
          current += char;
          continue;
        }
        if (char === ',' && parenDepth === 0 && bracketDepth === 0) {
          parts.push(current.trim());
          current = '';
          continue;
        }
      }

      current += char;
    }

    if (current.trim() || input.endsWith(',')) {
      parts.push(current.trim());
    }

    return parts.length > 0 ? parts : [''];
  }

  isColorType(typeValue: string): boolean {
    const normalized = typeValue.toLowerCase();
    return normalized.includes('color') || normalized.includes('colors');
  }

  getColorSwatchForPart(row: ConfigRow, valuePart: string): string | null {
    if (!this.isColorType(row.type)) {
      return null;
    }
    return this.getColorSwatchColor(valuePart);
  }

  getHighlightedParts(value = '', columnKey?: ConfigColumnKey): HighlightPart[] {
    const source = value;
    if (!source) {
      return [{ text: '', kind: 'none' }];
    }

    const globalTokens = this.splitFilterTokens(this.globalFilter, this.globalFilterMode);
    const globalRegex = this.globalFilterMode === 'regex' ? this.tryParseRegexInput(this.globalFilter) : null;
    const columnTokens =
      columnKey && this.columns.some((column) => column.key === columnKey && column.filterType === 'text')
        ? this.splitFilterTokens(this.textFilters[columnKey] ?? '', this.getTextMode(columnKey))
        : [];
    const columnRegex =
      columnKey &&
      this.columns.some((column) => column.key === columnKey && column.filterType === 'text') &&
      this.getTextMode(columnKey) === 'regex'
        ? this.tryParseRegexInput(this.textFilters[columnKey] ?? '')
        : null;

    if (globalTokens.length === 0 && columnTokens.length === 0 && !globalRegex && !columnRegex) {
      return [{ text: source, kind: 'none' }];
    }

    const sourceLower = source.toLowerCase();
    const levels = new Array<number>(source.length).fill(0);

    this.applyTokenHighlights(source, sourceLower, globalTokens, globalRegex, levels, 1);
    this.applyTokenHighlights(source, sourceLower, columnTokens, columnRegex, levels, 2);

    const parts: HighlightPart[] = [];
    let buffer = '';
    let currentLevel = levels[0] ?? 0;

    for (let index = 0; index < source.length; index += 1) {
      const level = levels[index] ?? 0;
      if (level !== currentLevel) {
        parts.push({ text: buffer, kind: this.getHighlightKind(currentLevel) });
        buffer = '';
        currentLevel = level;
      }
      buffer += source[index];
    }

    if (buffer) {
      parts.push({ text: buffer, kind: this.getHighlightKind(currentLevel) });
    }

    return parts.length > 0 ? parts : [{ text: source, kind: 'none' }];
  }

  private applyTokenHighlights(
    source: string,
    sourceLower: string,
    tokens: string[],
    regex: RegExp | null,
    levels: number[],
    level: number
  ): void {
    if (regex) {
      const workingRegex = this.toGlobalRegex(regex);
      if (workingRegex) {
        let match = workingRegex.exec(source);
        while (match) {
          const start = match.index;
          const length = match[0]?.length ?? 0;
          const end = start + length;
          if (end > start) {
            for (let index = start; index < end && index < levels.length; index += 1) {
              levels[index] = Math.max(levels[index], level);
            }
          }
          if (length === 0) {
            workingRegex.lastIndex += 1;
          }
          match = workingRegex.exec(source);
        }
      }
    }

    for (const token of tokens) {
      if (!token) {
        continue;
      }
      let cursor = 0;
      while (cursor < sourceLower.length) {
        const matchIndex = sourceLower.indexOf(token, cursor);
        if (matchIndex < 0) {
          break;
        }
        const matchEnd = matchIndex + token.length;
        for (let index = matchIndex; index < matchEnd && index < levels.length; index += 1) {
          levels[index] = Math.max(levels[index], level);
        }
        cursor = matchIndex + 1;
      }
    }
  }

  private getHighlightKind(level: number): HighlightPart['kind'] {
    if (level >= 2) {
      return 'column';
    }
    if (level === 1) {
      return 'global';
    }
    return 'none';
  }

  private unwrapColorToken(value: string): string {
    let unwrapped = value.trim();
    const wrappers: Array<[string, string]> = [
      ['`', '`'],
      ['"', '"'],
      ["'", "'"]
    ];
    for (const [start, end] of wrappers) {
      if (unwrapped.startsWith(start) && unwrapped.endsWith(end) && unwrapped.length >= 2) {
        unwrapped = unwrapped.slice(1, -1).trim();
      }
    }
    return unwrapped;
  }

  getColorSwatchColor(value: string): string | null {
    const trimmedValue = this.unwrapColorToken(value);

    const hexPattern = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
    if (hexPattern.test(trimmedValue)) {
      return trimmedValue;
    }

    const rgbaWithAlphaPattern =
      /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|1|0?\.\d+)\s*\)$/i;
    const rgbaWithAlphaMatch = rgbaWithAlphaPattern.exec(trimmedValue);
    if (rgbaWithAlphaMatch) {
      return rgbaWithAlphaMatch[0];
    }

    const rgbLikePattern = /^(rgba?)\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;
    const rgbLikeMatch = rgbLikePattern.exec(trimmedValue);
    if (!rgbLikeMatch) {
      return null;
    }

    const fn = rgbLikeMatch[1].toLowerCase();
    const r = rgbLikeMatch[2];
    const g = rgbLikeMatch[3];
    const b = rgbLikeMatch[4];

    return fn === 'rgba' ? `rgb(${r},${g},${b})` : rgbLikeMatch[0];
  }

  isCopiedProperty(value: string): boolean {
    return this.copiedPropertyValue === value.trim();
  }

  async copyPropertyValue(value: string): Promise<void> {
    const text = value.trim();
    if (!text) {
      return;
    }

    const copied = await this.tryCopyToClipboard(text);
    if (!copied) {
      return;
    }

    this.copiedPropertyValue = text;
    this.safeMarkForCheck();
    if (this.copyResetTimerId !== undefined) {
      globalThis.clearTimeout(this.copyResetTimerId);
    }
    this.copyResetTimerId = globalThis.setTimeout(() => {
      this.copiedPropertyValue = null;
      this.copyResetTimerId = undefined;
      this.safeMarkForCheck();
    }, 700);
  }

  private async tryCopyToClipboard(text: string): Promise<boolean> {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  private normalize(value: string): string {
    return value.toLowerCase().trim();
  }

  private splitFilterTokens(input: string, mode: TextMatchMode): string[] {
    if (mode === 'regex') {
      return [];
    }
    return input
      .split(',')
      .map((token) => this.normalize(token))
      .filter((token) => token.length > 0);
  }

  private matchesTokens(value: string, tokens: string[], mode: TextMatchMode, regex: RegExp | null): boolean {
    if (mode === 'regex') {
      return this.matchesRegex(value, regex);
    }

    if (tokens.length === 0) {
      return true;
    }
    if (mode === 'and') {
      return tokens.every((token) => value.includes(token));
    }
    return tokens.some((token) => value.includes(token));
  }

  private tryParseRegexInput(input: string): RegExp | null {
    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }

    if (trimmed.startsWith('/')) {
      const lastSlash = trimmed.lastIndexOf('/');
      if (lastSlash > 0) {
        const pattern = trimmed.slice(1, lastSlash);
        const flags = trimmed.slice(lastSlash + 1);
        if (/^[dgimsuy]*$/.test(flags)) {
          try {
            return new RegExp(pattern, flags);
          } catch {
            return null;
          }
        }
      }
    }

    try {
      return new RegExp(trimmed, 'i');
    } catch {
      return null;
    }
  }

  private toGlobalRegex(regex: RegExp): RegExp | null {
    try {
      const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
      return new RegExp(regex.source, flags);
    } catch {
      return null;
    }
  }

  private matchesRegex(value: string, regex: RegExp | null): boolean {
    if (!regex) {
      return false;
    }
    try {
      const flags = regex.flags.replaceAll('g', '');
      return new RegExp(regex.source, flags).test(value);
    } catch {
      return false;
    }
  }

  private safeMarkForCheck(): void {
    try {
      this.cdr.markForCheck();
      this.cdr.detectChanges();
    } catch {
      // Ignore edge cases during view teardown.
    }
  }

  private toListColumnKey(key: ConfigColumnKey): ListColumnKey {
    return key === 'allowedScopes' ? 'allowedScopes' : 'editableBy';
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target && this.isEditableElement(target)) {
      return;
    }

    event.preventDefault();
    this.globalFilterInputRef?.nativeElement.focus();
  }

  private syncColumnOrderFromVisibleOrder(orderedVisibleKeys: ConfigColumnKey[]): void {
    const normalizedVisibleKeys = this.ensurePropertyVisible(orderedVisibleKeys);
    const visibleSet = new Set(normalizedVisibleKeys);
    const visibleSlotIndexes = this.columnOrderKeys
      .map((key, index) => (visibleSet.has(key) ? index : -1))
      .filter((index) => index >= 0);

    if (visibleSlotIndexes.length !== normalizedVisibleKeys.length) {
      return;
    }

    const nextOrder = [...this.columnOrderKeys];
    for (let index = 0; index < visibleSlotIndexes.length; index += 1) {
      nextOrder[visibleSlotIndexes[index]] = normalizedVisibleKeys[index];
    }

    this.columnOrderKeys = this.normalizeColumnOrderKeys(nextOrder);
    this.visibleColumnKeys = this.columnOrderKeys.filter((key) => visibleSet.has(key));
  }

  private normalizeColumnOrderKeys(keys: ConfigColumnKey[] | undefined): ConfigColumnKey[] {
    const defaultOrder = this.columns.map((column) => column.key);
    if (!keys || keys.length === 0) {
      return defaultOrder;
    }

    const validKeys = new Set(defaultOrder);
    const uniqueOrdered: ConfigColumnKey[] = [];
    for (const key of keys) {
      if (validKeys.has(key) && !uniqueOrdered.includes(key)) {
        uniqueOrdered.push(key);
      }
    }

    for (const key of defaultOrder) {
      if (!uniqueOrdered.includes(key)) {
        uniqueOrdered.push(key);
      }
    }

    return uniqueOrdered;
  }

  private restoreState(): void {
    try {
      const rawState = localStorage.getItem(this.stateStorageKey);
      if (!rawState) {
        return;
      }

      const parsedState = JSON.parse(rawState) as TableState;
      this.globalFilter = parsedState.globalFilter ?? '';
      this.globalFilterMode =
        parsedState.globalFilterMode === 'and' || parsedState.globalFilterMode === 'regex'
          ? parsedState.globalFilterMode
          : 'or';
      this.globalFilterScope = parsedState.globalFilterScope === 'visible' ? 'visible' : 'all';
      this.textFilters = parsedState.textFilters ?? {};
      this.textModes = Object.entries(parsedState.textModes ?? {}).reduce(
        (acc, [key, mode]) => {
          if (mode === 'and' || mode === 'regex') {
            acc[key as ConfigColumnKey] = mode;
          } else {
            acc[key as ConfigColumnKey] = 'or';
          }
          return acc;
        },
        {} as Partial<Record<ConfigColumnKey, TextMatchMode>>
      );
      this.valueFilters = parsedState.valueFilters ?? {};
      this.listModes = {
        allowedScopes: parsedState.listModes?.allowedScopes === 'and' ? 'and' : 'or',
        editableBy: parsedState.listModes?.editableBy === 'and' ? 'and' : 'or'
      };
      this.columnOrderKeys = this.normalizeColumnOrderKeys(parsedState.columnOrderKeys);

      const validColumns = (parsedState.visibleColumnKeys ?? []).filter((key) =>
        this.columns.some((column) => column.key === key)
      );
      const selectedSet = new Set(validColumns);
      this.visibleColumnKeys = this.columnOrderKeys.filter((key) => selectedSet.has(key));
      this.visibleColumnKeys = this.ensurePropertyVisible(this.visibleColumnKeys);
      if (this.visibleColumnKeys.length === 0) {
        this.visibleColumnKeys = [...this.columnOrderKeys];
        this.visibleColumnKeys = this.ensurePropertyVisible(this.visibleColumnKeys);
      }
    } catch {
      this.columnOrderKeys = this.columns.map((column) => column.key);
      this.visibleColumnKeys = [...this.columnOrderKeys];
    }
  }

  private persistState(): void {
    const state: TableState = {
      globalFilter: this.globalFilter,
      globalFilterScope: this.globalFilterScope,
      textFilters: this.textFilters,
      globalFilterMode: this.globalFilterMode,
      textModes: this.textModes,
      valueFilters: this.valueFilters,
      listModes: this.listModes,
      visibleColumnKeys: this.visibleColumnKeys,
      columnOrderKeys: this.columnOrderKeys
    };

    localStorage.setItem(this.stateStorageKey, JSON.stringify(state));
  }

  private ensurePropertyVisible(keys: ConfigColumnKey[]): ConfigColumnKey[] {
    if (keys.includes('property')) {
      return keys;
    }

    const propertyIndex = this.columnOrderKeys.indexOf('property');
    if (propertyIndex < 0) {
      return ['property', ...keys];
    }

    const current = [...keys];
    let insertAt = 0;
    for (let index = 0; index < current.length; index += 1) {
      const currentIndex = this.columnOrderKeys.indexOf(current[index]);
      if (currentIndex >= 0 && currentIndex < propertyIndex) {
        insertAt = index + 1;
      }
    }
    current.splice(insertAt, 0, 'property');
    return current;
  }

  private isEditableElement(target: HTMLElement): boolean {
    const tagName = target.tagName.toLowerCase();
    return tagName === 'input' || tagName === 'textarea' || target.isContentEditable;
  }

  private isHoverTooltipModifierPressed(event: MouseEvent): boolean {
    return event.ctrlKey || event.metaKey;
  }

  private positionCellHoverTooltip(event: MouseEvent): void {
    const offset = 14;
    const maxWidth = 420;
    const margin = 12;
    let left = event.clientX + offset;
    let top = event.clientY + offset;

    if (left + maxWidth > globalThis.innerWidth - margin) {
      left = Math.max(margin, event.clientX - maxWidth - offset);
    }
    const estimatedHeight = 120;
    if (top + estimatedHeight > globalThis.innerHeight - margin) {
      top = Math.max(margin, event.clientY - estimatedHeight - offset);
    }

    this.cellHoverTooltipLeft = left;
    this.cellHoverTooltipTop = top;
  }
}

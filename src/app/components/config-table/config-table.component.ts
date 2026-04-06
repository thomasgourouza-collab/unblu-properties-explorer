import { CommonModule } from '@angular/common';
import {
  AfterViewChecked,
  ChangeDetectorRef,
  Component,
  Directive,
  ElementRef,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  QueryList,
  SimpleChanges,
  ViewChild,
  ViewChildren
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MultiSelect, MultiSelectModule } from 'primeng/multiselect';
import { TableColumnReorderEvent, TableModule } from 'primeng/table';

import { ColumnDefinition, ConfigRow, EXTRA_COLUMN_PREFIX, FilterMode } from '../../models/config-row.model';

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
  columnKey?: string;
  value?: string;
}

interface MatchReason {
  label: string;
  detail: string;
}

type ListColumnKey = 'allowedScopes' | 'editableBy';
type GlobalFilterScope = 'all' | 'visible';
type TextMatchMode = 'or' | 'and' | 'regex';

interface TableState {
  globalFilter: string;
  globalFilterMode?: TextMatchMode;
  globalFilterScope?: GlobalFilterScope;
  textFilters: Partial<Record<string, string>>;
  textModes?: Partial<Record<string, TextMatchMode>>;
  valueFilters: Partial<Record<string, string[]>>;
  listModes: Record<ListColumnKey, FilterMode>;
  visibleColumnKeys: string[];
  columnOrderKeys?: string[];
}

const BASE_COLUMN_DEFINITIONS: ColumnDefinition[] = [
  { key: 'category', label: 'Category', filterType: 'select' },
  { key: 'propertyTitle', label: 'Property title', filterType: 'text' },
  { key: 'property', label: 'Property', filterType: 'text' },
  { key: 'source', label: 'Source', filterType: 'text' },
  { key: 'defaultValue', label: 'Default value', filterType: 'text' },
  { key: 'value', label: 'Value', filterType: 'text' },
  { key: 'type', label: 'Type', filterType: 'select' },
  { key: 'allowedValues', label: 'Allowed values', filterType: 'text' },
  { key: 'allowedScopes', label: 'Allowed scopes', filterType: 'list' },
  { key: 'visibility', label: 'Visibility', filterType: 'select' },
  { key: 'editableBy', label: 'Editable by', filterType: 'list' },
  { key: 'description', label: 'Description', filterType: 'text' }
];

/** Sets `HTMLInputElement.indeterminate` (not bindable in templates). */
@Directive({
  selector: '[appBindIndeterminate]',
  standalone: true
})
export class BindIndeterminateDirective implements AfterViewChecked {
  @Input() appBindIndeterminate = false;

  constructor(private readonly el: ElementRef<HTMLInputElement>) {}

  ngAfterViewChecked(): void {
    const input = this.el.nativeElement;
    if (input.indeterminate !== this.appBindIndeterminate) {
      input.indeterminate = this.appBindIndeterminate;
    }
  }
}

@Component({
  selector: 'app-config-table',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, MultiSelectModule, BindIndeterminateDirective],
  templateUrl: './config-table.component.html',
  styleUrl: './config-table.component.scss'
})
export class ConfigTableComponent implements OnChanges, OnDestroy {
  constructor(private readonly cdr: ChangeDetectorRef) {}

  @Input({ required: true }) rows: ConfigRow[] = [];
  @ViewChild('globalFilterInputRef') globalFilterInputRef?: ElementRef<HTMLInputElement>;
  @ViewChildren('valueCellMulti', { read: MultiSelect })
  private valueCellMultiselects?: QueryList<MultiSelect>;
  private chipsScrollHost: HTMLElement | null = null;
  private chipsScrollResizeObserver: ResizeObserver | null = null;
  /** Stable `ngModel` / `[options]` refs for Value-column multiselect (new arrays each CD freeze PrimeNG). */
  private readonly valueColumnMultiModelCache = new Map<string, { value: string; selected: string[] }>();
  private readonly valueColumnSelectOptionsCache = new Map<string, SelectOption[]>();
  rowsPerPage = 25;
  readonly rowsPerPageOptions = [10, 25, 50, 100];
  /** Bound to p-table [first]; kept in range when data length or page size changes. */
  tableFirst = 0;

  columns: ColumnDefinition[] = [...BASE_COLUMN_DEFINITIONS];

  filteredRows: ConfigRow[] = [];
  /** When true, the table lists only rows that are selected within the current filter. */
  showSelectedRowsOnly = false;
  /** Row identity for selection / CSV export (stable across duplicate property codes). */
  private readonly selectedRowKeys = new Set<string>();
  globalFilter = '';
  globalFilterMode: TextMatchMode = 'or';
  globalFilterScope: GlobalFilterScope = 'all';
  textFilters: Partial<Record<string, string>> = {};
  textModes: Partial<Record<string, TextMatchMode>> = {};
  valueFilters: Partial<Record<string, string[]>> = {};
  listModes: Record<ListColumnKey, FilterMode> = {
    allowedScopes: 'or',
    editableBy: 'or'
  };
  visibleColumnKeys: string[] = BASE_COLUMN_DEFINITIONS.map((column) => column.key);
  columnOrderKeys: string[] = BASE_COLUMN_DEFINITIONS.map((column) => column.key);
  filterOptions: Partial<Record<string, SelectOption[]>> = {};
  private readonly emptyFilterValues: string[] = [];
  /** Last successful clipboard copy id (property, default value, dialog lines, …). */
  lastCopiedClipboardId: string | null = null;
  private copyResetTimerId?: ReturnType<typeof globalThis.setTimeout>;

  @ViewChild('cellDetailDialog') private cellDetailDialogEl?: ElementRef<HTMLDialogElement>;
  cellDetailDialogRowKey: string | null = null;
  cellDetailDialogColumnKey: string | null = null;
  /** Row property key shown next to the dialog title (Cmd/Ctrl+click). */
  cellDetailDialogPropertyCode = '';
  cellDetailDialogPlainText = '';
  /** When set, dialog shows list + per-line copy (allowed values). */
  cellDetailDialogAllowedLines: string[] | null = null;
  isCellHoverTooltipOpen = false;
  cellHoverTooltipText = '';
  cellHoverTooltipColumnKey: string | null = null;
  cellHoverTooltipLeft = 0;
  cellHoverTooltipTop = 0;
  isMatchInspectorOpen = false;
  matchInspectorLeft = 0;
  matchInspectorTop = 0;
  matchInspectorReasons: MatchReason[] = [];
  private matchInspectorRow: ConfigRow | null = null;

  /** Shift+hover: some hosts omit `shiftKey` on mouse events; track Shift from keyboard too. */
  private matchInspectorShiftFromKeyboard = false;
  private pointerContextRow: ConfigRow | null = null;
  private pointerContextClientX = 0;
  private pointerContextClientY = 0;

  private readonly stateStorageKey = 'csv-explorer-table-state-v2';
  private restoredState = false;

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

  getColumnWidthPercent(columnKey: string): number {
    const totalWeight = this.visibleColumns.reduce(
      (sum, column) => sum + this.getColumnWidthWeight(column.key),
      0
    );
    if (totalWeight <= 0) {
      return 100;
    }
    return (100 * this.getColumnWidthWeight(columnKey)) / totalWeight;
  }

  /** Relative width units; redistributed so the table stays 100% wide. */
  private getColumnWidthWeight(columnKey: string): number {
    if (columnKey === 'property') {
      return 2;
    }
    if (columnKey === 'value') {
      return 1.2;
    }
    if (columnKey === 'visibility') {
      return 0.65;
    }
    if (columnKey === 'source') {
      return 1.1;
    }
    if (columnKey === 'description') {
      return 1.5;
    }
    if (columnKey.startsWith(EXTRA_COLUMN_PREFIX)) {
      return 0.95;
    }
    return 1;
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

  /** Selected rows that match the current column/global filters (visible in the table when not in “selected only” mode). */
  get selectedFilteredCount(): number {
    return this.filteredRows.filter((row) => this.selectedRowKeys.has(row.rowKey)).length;
  }

  /** All selected rows in the loaded dataset (persists across filters and pagination). */
  get selectedDatasetCount(): number {
    return this.rows.filter((row) => this.selectedRowKeys.has(row.rowKey)).length;
  }

  /** True when some selection is off the current filtered view (show dual count in header). */
  get selectionCountShowsSplit(): boolean {
    return this.selectedDatasetCount > 0 && this.selectedFilteredCount !== this.selectedDatasetCount;
  }

  /** Accessible name / tooltip for the header selection count. */
  get selectionHeaderAriaLabel(): string {
    if (this.selectedDatasetCount === 0) {
      return '0 rows selected';
    }
    if (!this.selectionCountShowsSplit) {
      return `${this.selectedDatasetCount} rows selected`;
    }
    return `${this.selectedFilteredCount} selected in current filter, ${this.selectedDatasetCount} selected in loaded dataset`;
  }

  /** Rows passed to p-table (full filtered set or selected-only subset). */
  get tableDisplayedRows(): ConfigRow[] {
    if (!this.showSelectedRowsOnly) {
      return this.filteredRows;
    }
    return this.filteredRows.filter((row) => this.selectedRowKeys.has(row.rowKey));
  }

  get emptyTableMessage(): string {
    if (this.filteredRows.length === 0) {
      return 'No rows match your current filters.';
    }
    if (this.showSelectedRowsOnly) {
      return 'No selected rows in the current filter. Turn off Selected only to see all filtered rows.';
    }
    return 'No rows match your current filters.';
  }

  get masterCheckboxChecked(): boolean {
    const { filteredRows, selectedRowKeys } = this;
    if (filteredRows.length === 0) {
      return false;
    }
    return filteredRows.every((row) => selectedRowKeys.has(row.rowKey));
  }

  get masterCheckboxIndeterminate(): boolean {
    const { filteredRows, selectedRowKeys } = this;
    if (filteredRows.length === 0) {
      return false;
    }
    const n = filteredRows.filter((row) => selectedRowKeys.has(row.rowKey)).length;
    return n > 0 && n < filteredRows.length;
  }

  isRowSelected(row: ConfigRow): boolean {
    return this.selectedRowKeys.has(row.rowKey);
  }

  onRowCheckboxChange(row: ConfigRow, event: Event): void {
    const input = event.target as HTMLInputElement | null;
    if (!input) {
      return;
    }
    if (input.checked) {
      this.selectedRowKeys.add(row.rowKey);
    } else {
      this.selectedRowKeys.delete(row.rowKey);
    }
    this.clearSelectedOnlyIfNoSelection();
    this.syncMatchInspectorToDisplayedTable();
  }

  onMasterCheckboxChange(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    if (!input) {
      return;
    }
    if (input.checked) {
      for (const row of this.filteredRows) {
        this.selectedRowKeys.add(row.rowKey);
      }
    } else {
      for (const row of this.filteredRows) {
        this.selectedRowKeys.delete(row.rowKey);
      }
    }
    this.clearSelectedOnlyIfNoSelection();
    this.syncMatchInspectorToDisplayedTable();
  }

  /** Rows in the loaded dataset where Value ≠ Default (same rules as the green border). */
  get valueColumnChangeRowCount(): number {
    return this.rows.filter((row) => this.valueColumnDiffersFromDefault(row)).length;
  }

  onSelectValueChangesClick(event: MouseEvent): void {
    event.stopPropagation();
    event.preventDefault();
    this.selectedRowKeys.clear();
    for (const row of this.rows) {
      if (this.valueColumnDiffersFromDefault(row)) {
        this.selectedRowKeys.add(row.rowKey);
      }
    }
    this.clearSelectedOnlyIfNoSelection();
    this.syncMatchInspectorToDisplayedTable();
    this.safeMarkForCheck();
  }

  onSelectedOnlyModeChange(on: boolean): void {
    this.showSelectedRowsOnly = on;
    if (on) {
      this.tableFirst = 0;
    } else {
      this.clampTableFirstToDisplayedData();
    }
    this.syncMatchInspectorToDisplayedTable();
  }

  onTableFirstChange(first: number): void {
    this.tableFirst = typeof first === 'number' && !Number.isNaN(first) ? first : 0;
  }

  /** Keep paginator index valid when displayed row count shrinks (filters, selected-only, page size). */
  private clampTableFirstToDisplayedData(): void {
    const n = this.tableDisplayedRows.length;
    const r = this.rowsPerPage;
    if (n === 0) {
      this.tableFirst = 0;
      return;
    }
    const maxFirst = Math.max(0, (Math.ceil(n / r) - 1) * r);
    if (this.tableFirst > maxFirst) {
      this.tableFirst = maxFirst;
    }
  }

  /** Placeholder for future transfer action. */
  onUtransferClick(): void {}

  exportSelectedToCsv(): void {
    const cols = this.visibleColumns;
    if (cols.length === 0) {
      return;
    }
    const selected = this.rows.filter((row) => this.selectedRowKeys.has(row.rowKey));
    if (selected.length === 0) {
      return;
    }
    const headerLine = cols.map((c) => this.escapeCsvField(c.label)).join(',');
    const lines = selected.map((row) =>
      cols.map((col) => this.escapeCsvField(this.getCellValue(row, col.key))).join(',')
    );
    const body = [headerLine, ...lines].join('\r\n');
    const blob = new Blob([`\ufeff${body}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = this.buildSelectionExportFilename();
    anchor.click();
    URL.revokeObjectURL(url);
  }

  @ViewChild('chipsScrollArea')
  set chipsScrollAreaRef(ref: ElementRef<HTMLElement> | undefined) {
    this.teardownChipsScrollOverflowTracking();
    const el = ref?.nativeElement ?? null;
    this.chipsScrollHost = el;
    if (el) {
      this.setupChipsScrollOverflowTracking(el);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['rows']) {
      return;
    }

    this.valueColumnMultiModelCache.clear();
    this.valueColumnSelectOptionsCache.clear();

    this.rebuildColumnsFromRows();

    if (!this.restoredState) {
      this.restoreState();
      this.restoredState = true;
    } else {
      this.syncColumnKeysWithNewDataset();
    }

    this.filterOptions = this.buildFilterOptions(this.rows);
    this.sanitizeFilters();
    this.applyFilters();
  }

  private collectExtraColumnKeysInOrder(rows: ConfigRow[]): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row.extra ?? {})) {
        if (!seen.has(key)) {
          seen.add(key);
          order.push(key);
        }
      }
    }
    return order;
  }

  private rebuildColumnsFromRows(): void {
    const extraKeys = this.collectExtraColumnKeysInOrder(this.rows);
    const dynamicCols: ColumnDefinition[] = extraKeys.map((key) => ({
      key,
      label: key.startsWith(EXTRA_COLUMN_PREFIX) ? key.slice(EXTRA_COLUMN_PREFIX.length) : key,
      filterType: 'text' as const
    }));
    this.columns = [...BASE_COLUMN_DEFINITIONS, ...dynamicCols];
  }

  private syncColumnKeysWithNewDataset(): void {
    this.columnOrderKeys = this.normalizeColumnOrderKeys(this.columnOrderKeys);
    const valid = new Set(this.columns.map((column) => column.key));
    this.visibleColumnKeys = this.visibleColumnKeys.filter((key) => valid.has(key));
    this.visibleColumnKeys = this.ensurePropertyVisible(this.visibleColumnKeys);
    if (this.visibleColumnKeys.length === 0 && this.columnOrderKeys.length > 0) {
      this.visibleColumnKeys = [...this.columnOrderKeys];
      this.visibleColumnKeys = this.ensurePropertyVisible(this.visibleColumnKeys);
    }
  }

  ngOnDestroy(): void {
    this.teardownChipsScrollOverflowTracking();
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
        .filter((key: unknown): key is string => typeof key === 'string' && this.columns.some((c) => c.key === key))
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

  getTextFilter(key: string): string {
    return this.textFilters[key] ?? '';
  }

  setTextFilter(key: string, value: string): void {
    this.textFilters[key] = value;
    this.onFiltersChanged();
  }

  getTextMode(key: string): TextMatchMode {
    const mode = this.textModes[key];
    return mode === 'and' || mode === 'regex' ? mode : 'or';
  }

  setTextMode(key: string, mode: string): void {
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

  clearTextFilterInput(key: string): void {
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

  onCellHoverEnter(event: MouseEvent, value: string, columnKey: string): void {
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

  onCellHoverMove(event: MouseEvent, value: string, columnKey: string): void {
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
    if (!this.isCellHoverTooltipOpen && this.cellHoverTooltipColumnKey === null) {
      return;
    }
    this.isCellHoverTooltipOpen = false;
    this.cellHoverTooltipColumnKey = null;
  }

  /** Stable *ngFor identity so CD / mousemove does not recreate text nodes (which clears selection). */
  trackByDefaultValuePart(index: number, valuePart: string): string {
    return `${index}:${valuePart}`;
  }

  trackByHighlightPart(index: number, part: HighlightPart): string {
    return `${index}:${part.kind}:${part.text}`;
  }

  trackByDialogLine(index: number, line: string): string {
    return `${index}:${line}`;
  }

  onCellCmdClick(event: MouseEvent, row: ConfigRow, column: ColumnDefinition): void {
    if (!event.metaKey && !event.ctrlKey) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target && this.isInteractiveCellTarget(target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.openCellDetailDialog(row, column);
  }

  private isInteractiveCellTarget(el: HTMLElement): boolean {
    const node = el.closest(
      'button, a, input, textarea, select, label, .p-multiselect, .p-multiselect-panel, .p-multiselect-header, .p-multiselect-item'
    );
    return Boolean(node);
  }

  private openCellDetailDialog(row: ConfigRow, column: ColumnDefinition): void {
    this.onCellHoverLeave();
    this.cellDetailDialogRowKey = row.rowKey;
    this.cellDetailDialogColumnKey = column.key;
    this.cellDetailDialogPropertyCode = this.getCellValue(row, 'property')?.trim() ?? '';
    const raw = this.getCellValue(row, column.key);
    if (column.key === 'allowedValues') {
      this.cellDetailDialogAllowedLines = [...this.getWhitespaceValueParts(raw)];
      this.cellDetailDialogPlainText = '';
    } else if (column.key === 'allowedScopes' || column.key === 'editableBy') {
      this.cellDetailDialogAllowedLines = this.parseCommaSeparatedCellList(raw ?? '');
      this.cellDetailDialogPlainText = '';
    } else {
      this.cellDetailDialogAllowedLines = null;
      this.cellDetailDialogPlainText = raw?.trim() ?? '';
    }
    this.safeMarkForCheck();
    queueMicrotask(() => {
      const dialog = this.cellDetailDialogEl?.nativeElement;
      if (dialog && !dialog.open) {
        dialog.showModal();
      }
    });
  }

  closeCellDetailDialog(): void {
    this.cellDetailDialogEl?.nativeElement.close();
  }

  onCellDetailDialogBackdrop(event: MouseEvent): void {
    if (event.target === this.cellDetailDialogEl?.nativeElement) {
      this.closeCellDetailDialog();
    }
  }

  onCellDetailDialogCleanup(): void {
    this.cellDetailDialogRowKey = null;
    this.cellDetailDialogColumnKey = null;
    this.cellDetailDialogPropertyCode = '';
    this.cellDetailDialogPlainText = '';
    this.cellDetailDialogAllowedLines = null;
    this.safeMarkForCheck();
  }

  get isCellDetailDialogItemList(): boolean {
    const key = this.cellDetailDialogColumnKey;
    return (
      (key === 'allowedValues' || key === 'allowedScopes' || key === 'editableBy') &&
      this.cellDetailDialogAllowedLines !== null
    );
  }

  get isCellDetailDialogCodeStyle(): boolean {
    const key = this.cellDetailDialogColumnKey;
    return key === 'property' || key === 'defaultValue';
  }

  cellDetailDialogFullCellCopyId(): string {
    const key = this.cellDetailDialogColumnKey ?? '';
    return this.fullCellCopyId(key, this.cellDetailDialogPlainText);
  }

  dialogLineCopyId(index: number): string {
    return `dlg:${this.cellDetailDialogRowKey ?? 'x'}:${index}`;
  }

  /** Bound on each body cell so PrimeNG scrollable tables still receive Shift+hover reliably. */
  onRowMatchInspectorHover(event: MouseEvent, row: ConfigRow): void {
    this.pointerContextRow = row;
    this.pointerContextClientX = event.clientX;
    this.pointerContextClientY = event.clientY;

    if (!this.isShiftHeldForMatchInspector(event)) {
      this.closeMatchInspector();
      return;
    }
    this.openMatchInspector(event, row);
  }

  private isShiftHeldForMatchInspector(event: MouseEvent): boolean {
    if (this.matchInspectorShiftFromKeyboard) {
      return true;
    }
    if (event.shiftKey) {
      return true;
    }
    return typeof event.getModifierState === 'function' && event.getModifierState('Shift');
  }

  private tryOpenMatchInspectorFromPointerContext(): void {
    if (!this.pointerContextRow) {
      return;
    }
    const synthetic = {
      clientX: this.pointerContextClientX,
      clientY: this.pointerContextClientY
    } as MouseEvent;
    this.openMatchInspector(synthetic, this.pointerContextRow);
  }

  /** Single `mousemove` on data cells: Cmd/Ctrl cell tooltip + Shift match inspector. */
  onBodyCellMouseMove(event: MouseEvent, row: ConfigRow, column: ColumnDefinition): void {
    this.onCellHoverMove(event, this.getCellValue(row, column.key), column.key);
    this.onRowMatchInspectorHover(event, row);
  }

  onRowHoverLeave(): void {
    this.closeMatchInspector();
    this.pointerContextRow = null;
  }

  private openMatchInspector(event: MouseEvent, row: ConfigRow): void {
    if (!this.hasActiveFilters) {
      this.closeMatchInspector();
      return;
    }

    if (this.matchInspectorRow === row && this.isMatchInspectorOpen) {
      this.positionMatchInspector(event);
      return;
    }

    const reasons = this.getRowMatchReasons(row);
    if (reasons.length === 0) {
      this.closeMatchInspector();
      return;
    }

    this.matchInspectorRow = row;
    this.matchInspectorReasons = reasons;
    this.isMatchInspectorOpen = true;
    this.positionMatchInspector(event);
  }

  private closeMatchInspector(): void {
    if (!this.isMatchInspectorOpen && this.matchInspectorRow === null) {
      return;
    }
    this.isMatchInspectorOpen = false;
    this.matchInspectorReasons = [];
    this.matchInspectorRow = null;
  }

  private positionMatchInspector(event: MouseEvent): void {
    const offset = 14;
    const maxWidth = 430;
    const margin = 12;
    let left = event.clientX + offset;
    let top = event.clientY + offset;

    if (left + maxWidth > globalThis.innerWidth - margin) {
      left = Math.max(margin, event.clientX - maxWidth - offset);
    }
    const estimatedHeight = 230;
    if (top + estimatedHeight > globalThis.innerHeight - margin) {
      top = Math.max(margin, event.clientY - estimatedHeight - offset);
    }

    this.matchInspectorLeft = left;
    this.matchInspectorTop = top;
  }

  private getRowMatchReasons(row: ConfigRow): MatchReason[] {
    const reasons: MatchReason[] = [];

    const globalInput = this.globalFilter.trim();
    if (globalInput) {
      const columnsToSearch = this.globalFilterScope === 'visible' ? this.visibleColumns : this.columns;
      if (this.globalFilterMode === 'regex') {
        const regex = this.tryParseRegexInput(globalInput);
        if (regex) {
          const matchedColumns = columnsToSearch
            .filter((column) => this.matchesRegex(this.getCellValue(row, column.key), regex))
            .map((column) => column.label);
          if (matchedColumns.length > 0) {
            reasons.push({
              label: `Global (${this.globalFilterMode.toUpperCase()}, ${this.globalFilterScope})`,
              detail: `${globalInput} -> ${matchedColumns.join(', ')}`
            });
          }
        }
      } else {
        const rawTokens = this.splitRawFilterTokens(globalInput);
        const normalizedTokens = this.splitFilterTokens(globalInput, this.globalFilterMode);
        const tokenMatches: string[] = [];
        for (let index = 0; index < normalizedTokens.length; index += 1) {
          const token = normalizedTokens[index];
          const matchedColumns = columnsToSearch
            .filter((column) => this.normalize(this.getCellValue(row, column.key)).includes(token))
            .map((column) => column.label);
          if (matchedColumns.length > 0) {
            tokenMatches.push(`${rawTokens[index] ?? token} -> ${matchedColumns.join(', ')}`);
          }
        }
        if (tokenMatches.length > 0) {
          reasons.push({
            label: `Global (${this.globalFilterMode.toUpperCase()}, ${this.globalFilterScope})`,
            detail: tokenMatches.join(' | ')
          });
        }
      }
    }

    for (const column of this.columns) {
      if (column.filterType === 'text') {
        const input = (this.textFilters[column.key] ?? '').trim();
        if (!input) {
          continue;
        }
        const mode = this.getTextMode(column.key);
        const value = this.getCellValue(row, column.key);
        if (mode === 'regex') {
          const regex = this.tryParseRegexInput(input);
          if (regex && this.matchesRegex(value, regex)) {
            reasons.push({
              label: `${column.label} (${mode.toUpperCase()})`,
              detail: input
            });
          }
          continue;
        }

        const rawTokens = this.splitRawFilterTokens(input);
        const normalizedTokens = this.splitFilterTokens(input, mode);
        const normalizedValue = this.normalize(value);
        const matched = rawTokens.filter((_, idx) => normalizedValue.includes(normalizedTokens[idx]));
        if (matched.length > 0) {
          reasons.push({
            label: `${column.label} (${mode.toUpperCase()})`,
            detail: matched.join(', ')
          });
        }
        continue;
      }

      const selectedValues = this.valueFilters[column.key] ?? [];
      if (selectedValues.length === 0) {
        continue;
      }

      if (column.filterType === 'list') {
        const rowTokens = new Set(
          (column.key === 'allowedScopes' ? row.allowedScopesTokens : row.editableByTokens).map((token) =>
            this.normalize(token)
          )
        );
        const matchedValues = selectedValues.filter((value) => rowTokens.has(this.normalize(value)));
        if (matchedValues.length > 0) {
          reasons.push({
            label: `${column.label} (${this.getListMode(column.key).toUpperCase()})`,
            detail: matchedValues.join(', ')
          });
        }
        continue;
      }

      if (column.filterType === 'select') {
        const rowValue = this.normalize(this.getCellValue(row, column.key));
        const matched = selectedValues.find((value) => this.normalize(value) === rowValue);
        if (matched) {
          reasons.push({
            label: `${column.label} (SELECT)`,
            detail: matched
          });
        }
      }
    }

    return reasons;
  }

  getColumnLabel(columnKey: string | null): string {
    if (!columnKey) {
      return 'Value';
    }
    return this.columns.find((column) => column.key === columnKey)?.label ?? 'Value';
  }

  getValueFilter(key: string): string[] {
    return this.valueFilters[key] ?? this.emptyFilterValues;
  }

  setValueFilter(key: string, values: string[] | undefined): void {
    this.valueFilters[key] = values ?? [];
    this.onFiltersChanged();
  }

  getFilterOptions(key: string): SelectOption[] {
    return this.filterOptions[key] ?? [];
  }

  getListMode(key: string): FilterMode {
    return this.listModes[this.toListColumnKey(key)];
  }

  setListMode(key: string, mode: string): void {
    this.listModes[this.toListColumnKey(key)] = mode === 'and' ? 'and' : 'or';
    this.onFiltersChanged();
  }

  onRowsPerPageChange(value: string | number): void {
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && parsed > 0) {
      this.rowsPerPage = parsed;
      this.clampTableFirstToDisplayedData();
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

    this.pruneSelectionToDatasetRows();
    this.clearSelectedOnlyIfNoSelection();

    this.scheduleChipsScrollOverflowSync();

    if (this.isMatchInspectorOpen && this.matchInspectorRow) {
      if (!this.filteredRows.includes(this.matchInspectorRow) || !this.hasActiveFilters) {
        this.closeMatchInspector();
      } else {
        const reasons = this.getRowMatchReasons(this.matchInspectorRow);
        if (reasons.length === 0) {
          this.closeMatchInspector();
        } else {
          this.matchInspectorReasons = reasons;
        }
      }
    }

    this.syncMatchInspectorToDisplayedTable();
    this.clampTableFirstToDisplayedData();
  }

  private setupChipsScrollOverflowTracking(el: HTMLElement): void {
    const run = () => this.syncChipsScrollOverflowClass(el);
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => run());
      ro.observe(el);
      this.chipsScrollResizeObserver = ro;
    }
    requestAnimationFrame(run);
  }

  private teardownChipsScrollOverflowTracking(): void {
    this.chipsScrollResizeObserver?.disconnect();
    this.chipsScrollResizeObserver = null;
    this.chipsScrollHost = null;
  }

  private scheduleChipsScrollOverflowSync(): void {
    // Run after Angular has attached *ngIf chips (ViewChild setter) and laid out widths.
    globalThis.setTimeout(() => {
      requestAnimationFrame(() => {
        const el = this.chipsScrollHost;
        if (el?.isConnected) {
          this.syncChipsScrollOverflowClass(el);
        }
      });
    }, 0);
  }

  private syncChipsScrollOverflowClass(el: HTMLElement): void {
    const overflowing = el.scrollWidth > el.clientWidth + 1;
    el.classList.toggle('chips-scroll-area--overflowing', overflowing);
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

    if (column.filterType === 'text') {
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

  private buildFilterOptions(rows: ConfigRow[]): Partial<Record<string, SelectOption[]>> {
    const optionsMap: Partial<Record<string, SelectOption[]>> = {};

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

  getCellValue(row: ConfigRow, key: string): string {
    if (key === 'source') {
      return row.source ?? '';
    }
    if (key.startsWith(EXTRA_COLUMN_PREFIX)) {
      return row.extra[key] ?? '';
    }
    const field = key as keyof ConfigRow;
    if (field === 'extra' || field === 'allowedScopesTokens' || field === 'editableByTokens') {
      return '';
    }
    const value = row[field];
    return typeof value === 'string' ? value : '';
  }

  /** Drop selection only for properties that no longer exist in the loaded dataset (e.g. new file). */
  private pruneSelectionToDatasetRows(): void {
    const allowed = new Set(this.rows.map((row) => row.rowKey));
    for (const key of [...this.selectedRowKeys]) {
      if (!allowed.has(key)) {
        this.selectedRowKeys.delete(key);
      }
    }
  }

  private clearSelectedOnlyIfNoSelection(): void {
    if (this.showSelectedRowsOnly && this.selectedFilteredCount === 0) {
      this.showSelectedRowsOnly = false;
    }
  }

  private syncMatchInspectorToDisplayedTable(): void {
    if (!this.isMatchInspectorOpen || !this.matchInspectorRow) {
      return;
    }
    if (!this.tableDisplayedRows.includes(this.matchInspectorRow)) {
      this.closeMatchInspector();
    }
  }

  private escapeCsvField(value: string): string {
    const s = value ?? '';
    if (/[",\r\n]/.test(s)) {
      return `"${s.replaceAll('"', '""')}"`;
    }
    return s;
  }

  private buildSelectionExportFilename(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `configuration-selection-${y}-${m}-${day}.csv`;
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
        // Fall through when the value is not valid JSON.
      }
    }

    // Default value: one logical value may contain spaces; multiple values use commas only.
    if (trimmed.includes(',')) {
      return this.parseCommaSeparatedCellList(trimmed);
    }
    return [trimmed];
  }

  /** Split cell display tokens on whitespace (allowed values). */
  getWhitespaceValueParts(value = ''): string[] {
    const trimmed = value.trim();
    if (!trimmed) {
      return [''];
    }
    const parts = trimmed.split(/\s+/).filter((part) => part.length > 0);
    return parts.length > 0 ? parts : [''];
  }

  /** Cmd+click dialog: one row per comma-separated token (allowed scopes, editable by). */
  parseCommaSeparatedCellList(value = ''): string[] {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    return trimmed
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  isValueColumnBooleanType(row: ConfigRow): boolean {
    return row.type.trim().toLowerCase() === 'boolean';
  }

  isValueColumnListOfPrefixType(row: ConfigRow): boolean {
    return row.type.trim().startsWith('List of');
  }

  /** Allowed-values tokens for Value column options (same tokenization as Allowed values column). */
  getValueColumnAllowedOptionValues(row: ConfigRow): string[] {
    if (!row.hasAllowedValuesColumn) {
      return [];
    }
    return this.getWhitespaceValueParts(row.allowedValues ?? '').filter((part) => part.trim().length > 0);
  }

  hasValueColumnAllowedOptions(row: ConfigRow): boolean {
    return this.getValueColumnAllowedOptionValues(row).length > 0;
  }

  getValueColumnSelectOptions(row: ConfigRow): SelectOption[] {
    const cacheKey = `${row.rowKey}\0${row.hasAllowedValuesColumn ? row.allowedValues : ''}`;
    const hit = this.valueColumnSelectOptionsCache.get(cacheKey);
    if (hit) {
      return hit;
    }
    const opts = [...this.getValueColumnAllowedOptionValues(row)]
      .sort((a, b) => a.localeCompare(b))
      .map((v) => ({ label: v, value: v }));
    this.valueColumnSelectOptionsCache.set(cacheKey, opts);
    return opts;
  }

  valueColumnUsesMultiSelect(row: ConfigRow): boolean {
    return this.hasValueColumnAllowedOptions(row) && this.isValueColumnListOfPrefixType(row);
  }

  valueColumnUsesSingleSelectFromAllowed(row: ConfigRow): boolean {
    if (!this.hasValueColumnAllowedOptions(row) || this.isValueColumnBooleanType(row)) {
      return false;
    }
    return !this.isValueColumnListOfPrefixType(row);
  }

  getValueColumnMultiModel(row: ConfigRow): string[] {
    const v = row.value ?? '';
    const cached = this.valueColumnMultiModelCache.get(row.rowKey);
    if (cached && cached.value === v) {
      return cached.selected;
    }
    const allowed = new Set(this.getValueColumnAllowedOptionValues(row));
    const selected = this.parseListStyleCellToTokens(v).filter((p) => allowed.has(p));
    this.valueColumnMultiModelCache.set(row.rowKey, { value: v, selected });
    return selected;
  }

  /** Close other value-column multiselect overlays so only one panel stays open (appendTo body). */
  onValueColumnMultiselectPanelShow(source: MultiSelect): void {
    const list = this.valueCellMultiselects;
    if (!list) {
      return;
    }
    for (const ms of list) {
      if (ms !== source && ms.overlayVisible) {
        ms.hide();
      }
    }
  }

  onValueColumnMultiChange(row: ConfigRow, selected: string[] | null | undefined): void {
    const picked = (selected ?? []).filter((p) => p.trim().length > 0);
    const next = picked.join(',');
    row.value = next;
    const allowed = new Set(this.getValueColumnAllowedOptionValues(row));
    const normalized = picked.filter((p) => allowed.has(p));
    this.valueColumnMultiModelCache.set(row.rowKey, { value: next, selected: normalized });
    this.safeMarkForCheck();
  }

  onResetValueToDefault(event: MouseEvent, row: ConfigRow): void {
    event.stopPropagation();
    event.preventDefault();
    if (!this.valueColumnDiffersFromDefault(row)) {
      return;
    }
    row.value = row.defaultValue ?? '';
    this.valueColumnMultiModelCache.delete(row.rowKey);
    this.safeMarkForCheck();
  }

  onValueCellControlClick(event: MouseEvent): void {
    event.stopPropagation();
  }

  /**
   * True when the Value field differs from Default value (for list types, token order is ignored).
   */
  valueColumnDiffersFromDefault(row: ConfigRow): boolean {
    if (this.valueColumnUsesMultiSelect(row)) {
      const valueParts = this.getValueColumnMultiselectTokensForCompare(row.value ?? '');
      const defaultParts = this.getValueColumnMultiselectDefaultTokensForCompare(row.defaultValue ?? '');
      return !this.valueListsEqualIgnoreOrder(valueParts, defaultParts);
    }
    if (this.isValueColumnBooleanType(row)) {
      const v = (row.value ?? '').trim().toLowerCase();
      const d = (row.defaultValue ?? '').trim().toLowerCase();
      return v !== d;
    }
    return (row.value ?? '').trim() !== (row.defaultValue ?? '').trim();
  }

  private valueListsEqualIgnoreOrder(left: string[], right: string[]): boolean {
    const norm = (items: string[]) =>
      [...items]
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .sort((a, b) => a.localeCompare(b));
    const a = norm(left);
    const b = norm(right);
    if (a.length !== b.length) {
      return false;
    }
    return a.every((t, i) => t === b[i]);
  }

  /** Empty selection vs default `[]` — `row.value` may still be the literal `[]` from CSV (comma-split would yield one bogus token). */
  private isEmptyJsonArrayLiteral(raw: string): boolean {
    const t = raw.trim();
    return t.length === 0 || /^\[\s*\]$/.test(t);
  }

  private getValueColumnMultiselectTokensForCompare(raw: string): string[] {
    return this.parseListStyleCellToTokens(raw);
  }

  /**
   * Value column list storage: comma-separated and/or JSON array (copied from Default value on import).
   */
  private parseListStyleCellToTokens(raw: string): string[] {
    const t = (raw ?? '').trim();
    if (this.isEmptyJsonArrayLiteral(t)) {
      return [];
    }
    if (t.startsWith('[') && t.endsWith(']')) {
      try {
        const parsed = JSON.parse(t) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.map((e) => String(e ?? '').trim()).filter((s) => s.length > 0);
        }
      } catch {
        /* fall through to comma split */
      }
    }
    return this.parseCommaSeparatedCellList(t);
  }

  private getValueColumnMultiselectDefaultTokensForCompare(raw: string): string[] {
    if (this.isEmptyJsonArrayLiteral(raw)) {
      return [];
    }
    return this.getDefaultValueParts(raw).filter((p) => p.trim().length > 0);
  }

  /** True when chip column should render anything (non-empty tokens only). */
  hasChipPartsContent(parts: string[]): boolean {
    return parts.some((part) => part.trim().length > 0);
  }

  isDefaultValueCellVisible(raw: string): boolean {
    return this.hasChipPartsContent(this.getDefaultValueParts(raw));
  }

  isAllowedValuesCellVisible(raw: string): boolean {
    return this.hasChipPartsContent(this.getWhitespaceValueParts(raw));
  }

  get cellDetailDialogAllowedLinesForDisplay(): string[] {
    const lines = this.cellDetailDialogAllowedLines;
    if (!lines) {
      return [];
    }
    return lines.filter((line) => line.trim().length > 0);
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

  getHighlightedParts(value = '', columnKey?: string): HighlightPart[] {
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

  isFullCellCopied(columnKey: string, value: string): boolean {
    const text = value?.trim() ?? '';
    return this.lastCopiedClipboardId === this.fullCellCopyId(columnKey, text);
  }

  fullCellCopyId(columnKey: string, trimmedValue: string): string {
    return `full:${columnKey}:${trimmedValue}`;
  }

  async copyFullCell(columnKey: string, value: string): Promise<void> {
    const text = value?.trim() ?? '';
    if (!text) {
      return;
    }
    await this.copyById(this.fullCellCopyId(columnKey, text), text);
  }

  async copyById(id: string, text: string): Promise<void> {
    if (!text) {
      return;
    }

    const copied = await this.tryCopyToClipboard(text);
    if (!copied) {
      return;
    }

    this.lastCopiedClipboardId = id;
    this.safeMarkForCheck();
    if (this.copyResetTimerId !== undefined) {
      globalThis.clearTimeout(this.copyResetTimerId);
    }
    this.copyResetTimerId = globalThis.setTimeout(() => {
      this.lastCopiedClipboardId = null;
      this.copyResetTimerId = undefined;
      this.safeMarkForCheck();
    }, 800);
  }

  isCopiedId(id: string): boolean {
    return this.lastCopiedClipboardId === id;
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

  private splitRawFilterTokens(input: string): string[] {
    return input
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
  }

  private matchesTokens(value: string, tokens: string[], mode: TextMatchMode, regex: RegExp | null): boolean {
    if (mode === 'regex') {
      return this.matchesRegex(value, regex);
    }

    if (tokens.length === 0) {
      return true;
    }
    // Tokens from splitFilterTokens are lowercased; compare on normalized haystack (same as global filter).
    const haystack = this.normalize(value);
    if (mode === 'and') {
      return tokens.every((token) => haystack.includes(token));
    }
    return tokens.some((token) => haystack.includes(token));
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

  private toListColumnKey(key: string): ListColumnKey {
    return key === 'allowedScopes' ? 'allowedScopes' : 'editableBy';
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key === 'Shift' || event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      this.matchInspectorShiftFromKeyboard = true;
      this.tryOpenMatchInspectorFromPointerContext();
    }

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

  @HostListener('document:keyup', ['$event'])
  onDocumentKeyupShiftTrack(event: KeyboardEvent): void {
    if (event.key === 'Shift' || event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      this.matchInspectorShiftFromKeyboard = false;
    }
  }

  @HostListener('window:blur')
  onWindowBlurClearShiftTrack(): void {
    this.matchInspectorShiftFromKeyboard = false;
    if (this.isMatchInspectorOpen) {
      this.closeMatchInspector();
    }
  }

  private syncColumnOrderFromVisibleOrder(orderedVisibleKeys: string[]): void {
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

  private normalizeColumnOrderKeys(keys: string[] | undefined): string[] {
    const defaultOrder = this.columns.map((column) => column.key);
    if (!keys || keys.length === 0) {
      return defaultOrder;
    }

    const validKeys = new Set(defaultOrder);
    const uniqueOrdered: string[] = [];
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
        this.columnOrderKeys = this.columns.map((column) => column.key);
        this.visibleColumnKeys = this.ensurePropertyVisible([...this.columnOrderKeys]);
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
            acc[key] = mode;
          } else {
            acc[key] = 'or';
          }
          return acc;
        },
        {} as Partial<Record<string, TextMatchMode>>
      );
      this.valueFilters = parsedState.valueFilters ?? {};
      this.listModes = {
        allowedScopes: parsedState.listModes?.allowedScopes === 'and' ? 'and' : 'or',
        editableBy: parsedState.listModes?.editableBy === 'and' ? 'and' : 'or'
      };
      this.columnOrderKeys = this.normalizeColumnOrderKeys(parsedState.columnOrderKeys);

      const validColumns = (parsedState.visibleColumnKeys ?? []).filter((key: string) =>
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

  private ensurePropertyVisible(keys: string[]): string[] {
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

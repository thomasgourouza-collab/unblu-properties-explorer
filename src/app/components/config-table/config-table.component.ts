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
import { SortMeta } from 'primeng/api';
import { MultiSelect, MultiSelectModule } from 'primeng/multiselect';
import type { Table } from 'primeng/table';
import { TableColumnReorderEvent, TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { stringify as stringifyYaml } from 'yaml';

import { ColumnDefinition, ConfigRow, EXTRA_COLUMN_PREFIX, FilterMode, PROPERTY_STATUS_OPTIONS } from '../../models/config-row.model';
import { buildSelectionExportFilename, escapeCsvField } from './lib/config-export.util';
import {
  filterIgnoredImportKeys,
  parseImportedConfigFileText,
  parseImportedPropertiesFileText
} from './lib/config-import.util';
import { ActiveFilterChip, buildActiveFilterChips, buildDisplayedRows } from './lib/filtering.util';
import { clonePlainJsonObject } from './lib/json-record.util';
import { countSelectedDatasetRows, countSelectedFilteredRows, buildSelectionHeaderAriaLabel } from './lib/row-selection.util';
import {
  collectHighlightOperands,
  evaluateFilterAst,
  FILTER_EXPR_EMPTY_ERROR,
  formatExpressionMatchLines,
  isFilterExprNullOperand,
  parseFilterExpression
} from '../../utils/filter-expression.util';
import { stringifyJavaPropertiesFile } from '../../utils/java-properties-config.util';
import unbluScopeEditorsJson from '../../data/unblu-scope-editors.json';
import { InstallationImportWizardComponent } from '../installation-import-wizard/installation-import-wizard.component';

interface SelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

interface HighlightPart {
  text: string;
  kind: 'none' | 'global' | 'column';
}

interface MatchReason {
  label: string;
  detail: string;
  /** When set, the match inspector renders these as a bullet list (global filter breakdown). */
  detailBullets?: string[];
}

interface CellDetailAllowedScopeRow {
  scope: string;
  roles: string[];
}

/** One unmatched JSON key in the import “not found” dialog (plain text, no JSON quotes). */
interface ImportMissingKeyDialogRow {
  property: string;
  value: string;
}

type ListColumnKey = 'allowedScopes' | 'editableBy';
type GlobalFilterScope = 'all' | 'visible';
type TextMatchMode = 'expr' | 'regex';

interface TableSettings {
  globalFilter: string;
  globalFilterMode?: TextMatchMode;
  globalFilterScope?: GlobalFilterScope;
  globalFilterMatchCase?: boolean;
  globalFilterWholeWord?: boolean;
  textFilters: Partial<Record<string, string>>;
  textModes?: Partial<Record<string, TextMatchMode>>;
  textFilterMatchCase?: Partial<Record<string, boolean>>;
  textFilterWholeWord?: Partial<Record<string, boolean>>;
  valueFilters: Partial<Record<string, string[]>>;
  listFilterTextOverrides?: string[];
  listModes: Record<ListColumnKey, FilterMode>;
  visibleColumnKeys: string[];
  columnOrderKeys?: string[];
}

const UNBLU_SCOPE_EDITORS: Record<string, string[]> = unbluScopeEditorsJson as Record<string, string[]>;

const ALLOWED_SCOPES_DISPLAY_ORDER = [
  'USER',
  'TEAM',
  'CONVERSATION',
  'CONVERSATION_TEMPLATE',
  'AREA',
  'APIKEY',
  'ACCOUNT',
  'GLOBAL',
  'IMMUTABLE',
  'INGRESS',
  'LICENCE'
];
const EDITABLE_BY_DISPLAY_ORDER = [
  'REGISTERED_USER',
  'SUPERVISOR',
  'ADMIN',
  'TECHNICAL_ADMIN',
  'SUPER_ADMIN'
];
const buildRankMap = (order: string[]): Record<string, number> =>
  order.reduce((acc, value, index) => ({ ...acc, [value]: index }), {});
const ALLOWED_SCOPES_RANK: Record<string, number> = buildRankMap(ALLOWED_SCOPES_DISPLAY_ORDER);
const EDITABLE_BY_RANK: Record<string, number> = buildRankMap(EDITABLE_BY_DISPLAY_ORDER);
const allowedScopeRank = (scope: string): number =>
  ALLOWED_SCOPES_RANK[scope.toUpperCase()] ?? ALLOWED_SCOPES_DISPLAY_ORDER.length;
const editableByRank = (role: string): number =>
  EDITABLE_BY_RANK[role.toUpperCase()] ?? EDITABLE_BY_DISPLAY_ORDER.length;
const sortAllowedScopes = (scopes: string[]): string[] =>
  [...scopes].sort((a, b) => allowedScopeRank(a) - allowedScopeRank(b));
const sortEditableBy = (roles: string[]): string[] =>
  [...roles].sort((a, b) => editableByRank(a) - editableByRank(b));

const BASE_COLUMN_DEFINITIONS: ColumnDefinition[] = [
  { key: 'source', label: 'Source', filterType: 'select' },
  { key: 'category', label: 'Group title', filterType: 'select' },
  { key: 'propertyTitle', label: 'Label', filterType: 'text' },
  { key: 'property', label: 'Key', filterType: 'text' },
  { key: 'status', label: 'Status', filterType: 'select' },
  { key: 'dependsOn', label: 'Depends on', filterType: 'text' },
  { key: 'value', label: 'Value', filterType: 'text' },
  { key: 'defaultValue', label: 'Default value', filterType: 'text' },
  { key: 'allowedValues', label: 'Allowed values', filterType: 'text' },
  { key: 'type', label: 'Type', filterType: 'select' },
  { key: 'description', label: 'Description', filterType: 'text' },
  { key: 'allowedScopes', label: 'Allowed scopes', filterType: 'list' },
  { key: 'editableBy', label: 'Editable by', filterType: 'list' },
  { key: 'visibility', label: 'Visibility', filterType: 'select' }
];

/**
 * Header multiselect value for “no value” on Allowed scopes, Visibility, and Editable by.
 * Not a real cell value; handled in rowMatchesColumnFilter / getRowMatchReasons.
 */
const COLUMN_FILTER_NONE_VALUE = '__none__';

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
  imports: [
    CommonModule,
    FormsModule,
    TableModule,
    MultiSelectModule,
    TagModule,
    BindIndeterminateDirective,
    InstallationImportWizardComponent
  ],
  templateUrl: './config-table.component.html',
  styleUrl: './config-table.component.scss'
})
export class ConfigTableComponent implements OnChanges, OnDestroy {
  constructor(private readonly cdr: ChangeDetectorRef) {}

  @Input({ required: true }) rows: ConfigRow[] = [];
  @ViewChild('globalFilterInputRef') globalFilterInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('importConfigInput') private readonly importConfigInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('importTableSettingsInput') private readonly importTableSettingsInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('exportFormatMenuHost') private readonly exportFormatMenuHost?: ElementRef<HTMLElement>;
  @ViewChild('importConfigMenuHost') private readonly importConfigMenuHost?: ElementRef<HTMLElement>;
  @ViewChild('tableSettingsMenuHost') private readonly tableSettingsMenuHost?: ElementRef<HTMLElement>;
  /** Template ref on `p-table` — avoid `@ViewChild(Table)` (can trip Angular’s injector with PrimeNG 21). */
  @ViewChild('configTable') private readonly configTableRef?: Table;
  @ViewChildren('valueCellMulti', { read: MultiSelect })
  private valueCellMultiselects?: QueryList<MultiSelect>;
  /** Stable `ngModel` / `[options]` refs for Value-column multiselect (new arrays each CD freeze PrimeNG). */
  private readonly valueColumnMultiModelCache = new Map<string, { value: string; selected: string[] }>();
  private readonly valueColumnSelectOptionsCache = new Map<string, SelectOption[]>();
  private globalExprRowPredicate: ((row: ConfigRow) => boolean) | null = null;
  private readonly columnTextExprPredicates = new Map<string, (value: string) => boolean>();
  /**
   * PrimeNG multi-sort toggles asc ↔ desc only. We treat “desc → asc” on the same column as a 3rd click → unsort.
   * Ignored when multiSortMeta has more than one entry (Ctrl/Cmd multi-sort).
   */
  private tableSortTriStateAnchor: { field: string; order: 1 | -1 } | null = null;
  rowsPerPage = 25;
  readonly rowsPerPageOptions = [10, 25, 50, 100];
  /** Bound to p-table [first]; kept in range when data length or page size changes. */
  tableFirst = 0;

  columns: ColumnDefinition[] = [...BASE_COLUMN_DEFINITIONS];

  filteredRows: ConfigRow[] = [];
  /** When true, the table lists only rows that are selected within the current filter. */
  showSelectedRowsOnly = false;
  /** When true, the table lists only rows matched by the last imported config keys. */
  showConfigRowsOnly = false;
  /** Angular-driven export format menu (no Bootstrap JS). */
  exportFormatMenuOpen = false;
  /** Nested menu under Export config → To file (.json / .yaml / .properties). */
  exportToFileSubmenuOpen = false;
  /** Import config menu (file import only). */
  importConfigMenuOpen = false;
  /** Installation-import wizard visibility (From installation submenu). */
  installationImportWizardVisible = false;
  /** Table settings dropdown (reset / export / import persisted UI). */
  tableSettingsMenuOpen = false;
  /** Row identity for selection / CSV export (stable across duplicate property codes). */
  private readonly selectedRowKeys = new Set<string>();
  globalFilter = '';
  globalFilterMode: TextMatchMode = 'expr';
  globalFilterScope: GlobalFilterScope = 'visible';
  globalFilterMatchCase = false;
  globalFilterWholeWord = false;
  textFilters: Partial<Record<string, string>> = {};
  textModes: Partial<Record<string, TextMatchMode>> = {};
  textFilterMatchCase: Partial<Record<string, boolean>> = {};
  textFilterWholeWord: Partial<Record<string, boolean>> = {};
  valueFilters: Partial<Record<string, string[]>> = {};
  /** Columns with native select/list filterType overridden to free text mode. */
  listFilterTextOverrides = new Set<string>();
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
  /**
   * Last successful JSON import (snapshot for Reset); cleared on Remove or when `rows` input changes.
   */
  lastConfigImport: { fileName: string; snapshot: Record<string, unknown> } | null = null;
  /** Row keys matched by the last imported config keys (supports Config only filter). */
  private readonly configImportRowKeys = new Set<string>();
  private copyResetTimerId?: ReturnType<typeof globalThis.setTimeout>;

  @ViewChild('cellDetailDialog') private cellDetailDialogEl?: ElementRef<HTMLDialogElement>;
  /** Help-style overlay when JSON import contains keys with no matching Key row. */
  importMissingKeysDialogVisible = false;
  importMissingKeysDialogTitle = '';
  importMissingKeysDialogRows: ImportMissingKeyDialogRow[] = [];
  cellDetailDialogRowKey: string | null = null;
  cellDetailDialogColumnKey: string | null = null;
  /** Row property key shown next to the dialog title (Cmd/Ctrl+click). */
  cellDetailDialogPropertyCode = '';
  cellDetailDialogPlainText = '';
  /** When set, dialog shows list + per-line copy (allowed values). */
  cellDetailDialogAllowedLines: string[] | null = null;
  /** Cmd/Ctrl+click on Allowed scopes: one row per scope with role hints from `unblu-scope-editors.json`. */
  cellDetailDialogAllowedScopeRows: CellDetailAllowedScopeRow[] | null = null;
  isMatchInspectorOpen = false;
  matchInspectorLeft = 0;
  matchInspectorTop = 0;
  matchInspectorReasons: MatchReason[] = [];
  private matchInspectorRow: ConfigRow | null = null;

  /** Cmd/Ctrl+hover: same floating panel as the match inspector, body matches the cell detail dialog. */
  cellCmdPreviewOpen = false;

  /** Shift+hover: some hosts omit `shiftKey` on mouse events; track Shift from keyboard too. */
  private matchInspectorShiftFromKeyboard = false;
  private pointerContextRow: ConfigRow | null = null;
  /** Data column under the pointer (checkbox column clears this). */
  private pointerContextColumn: ColumnDefinition | null = null;
  private pointerContextClientX = 0;
  private pointerContextClientY = 0;

  private readonly settingsStorageKey = 'unblu-properties-explorer-table-settings';
  private restoredSettings = false;

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
    if (columnKey === 'property' || columnKey === 'dependsOn') {
      return 2;
    }
    if (columnKey === 'value') {
      return 1.5;
    }
    if (columnKey === 'visibility' || columnKey === 'status') {
      return 0.65;
    }
    if (columnKey === 'source') {
      return 0.8;
    }
    if (columnKey === 'description') {
      return 1.5;
    }
    return 1;
  }

  get activeFilterChips(): ActiveFilterChip[] {
    return buildActiveFilterChips(
      this.columns,
      this.globalFilter,
      this.textFilters,
      this.valueFilters,
      (value) => this.columnFilterChipValueLabel(value)
    );
  }

  get hasActiveFilters(): boolean {
    return this.activeFilterChips.length > 0;
  }

  /** Selected rows that match the current column/global filters (visible in the table when not in “selected only” mode). */
  get selectedFilteredCount(): number {
    return countSelectedFilteredRows(this.filteredRows, this.selectedRowKeys);
  }

  /** All selected rows in the loaded dataset (persists across filters and pagination). */
  get selectedDatasetCount(): number {
    return countSelectedDatasetRows(this.rows, this.selectedRowKeys);
  }

  /** True when some selection is off the current filtered view (show dual count in header). */
  get selectionCountShowsSplit(): boolean {
    return this.selectedDatasetCount > 0 && this.selectedFilteredCount !== this.selectedDatasetCount;
  }

  /** Accessible name / tooltip for the header selection count. */
  get selectionHeaderAriaLabel(): string {
    return buildSelectionHeaderAriaLabel(this.selectedFilteredCount, this.selectedDatasetCount);
  }

  /** Rows passed to p-table (filtered, optionally narrowed by Selected only and/or Config only). */
  get tableDisplayedRows(): ConfigRow[] {
    return buildDisplayedRows(this.filteredRows, {
      showSelectedRowsOnly: this.showSelectedRowsOnly,
      showConfigRowsOnly: this.showConfigRowsOnly,
      selectedRowKeys: this.selectedRowKeys,
      configImportRowKeys: this.configImportRowKeys
    });
  }

  get emptyTableMessage(): string {
    if (this.filteredRows.length === 0) {
      return 'No rows match your current filters.';
    }
    if (this.showSelectedRowsOnly && this.showConfigRowsOnly) {
      return 'No rows match both Selected only and Config only in the current filter.';
    }
    if (this.showSelectedRowsOnly) {
      return 'No selected rows in the current filter. Turn off Selected only to see all filtered rows.';
    }
    if (this.showConfigRowsOnly) {
      return 'No imported config rows in the current filter. Turn off Config only to see all filtered rows.';
    }
    return 'No rows match your current filters.';
  }

  get masterCheckboxChecked(): boolean {
    const displayed = this.tableDisplayedRows;
    if (displayed.length === 0) {
      return false;
    }
    return displayed.every((row) => this.selectedRowKeys.has(row.rowKey));
  }

  get masterCheckboxIndeterminate(): boolean {
    const displayed = this.tableDisplayedRows;
    if (displayed.length === 0) {
      return false;
    }
    const n = displayed.filter((row) => this.selectedRowKeys.has(row.rowKey)).length;
    return n > 0 && n < displayed.length;
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
    this.syncMatchInspectorToDisplayedTable();
  }

  onMasterCheckboxChange(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    if (!input) {
      return;
    }
    const displayed = this.tableDisplayedRows;
    // None selected → select all displayed. Some or all selected → deselect all displayed.
    // (Overrides the native toggle so clicks on the indeterminate state clear instead of selecting.)
    const anySelected = displayed.some((row) => this.selectedRowKeys.has(row.rowKey));
    if (anySelected) {
      for (const row of displayed) {
        this.selectedRowKeys.delete(row.rowKey);
      }
      input.checked = false;
    } else {
      for (const row of displayed) {
        this.selectedRowKeys.add(row.rowKey);
      }
      input.checked = true;
    }
    this.syncMatchInspectorToDisplayedTable();
  }

  /** Rows in the full dataset where Value ≠ Default (same rules as the blue divergent border). */
  get valueColumnChangeRowCount(): number {
    return this.rows.filter((row) => this.valueColumnDiffersFromDefault(row)).length;
  }

  private get valueColumnDiffRows(): ConfigRow[] {
    let rows = this.filteredRows;
    if (this.showConfigRowsOnly) {
      rows = rows.filter((row) => this.configImportRowKeys.has(row.rowKey));
    }
    return rows.filter((row) => this.valueColumnDiffersFromDefault(row));
  }

  get valueColumnDiffsCheckboxChecked(): boolean {
    const diffRows = this.valueColumnDiffRows;
    if (diffRows.length === 0) {
      return false;
    }
    return diffRows.every((row) => this.selectedRowKeys.has(row.rowKey));
  }

  get valueColumnDiffsCheckboxIndeterminate(): boolean {
    const diffRows = this.valueColumnDiffRows;
    if (diffRows.length === 0) {
      return false;
    }
    const n = diffRows.filter((row) => this.selectedRowKeys.has(row.rowKey)).length;
    return n > 0 && n < diffRows.length;
  }

  get selectedDiffCount(): number {
    return this.valueColumnDiffRows.filter((row) => this.selectedRowKeys.has(row.rowKey)).length;
  }

  onValueDiffsCheckboxChange(event: Event): void {
    event.stopPropagation();
    const input = event.target as HTMLInputElement | null;
    if (!input) {
      return;
    }
    const diffRows = this.valueColumnDiffRows;
    if (input.checked) {
      for (const row of diffRows) {
        this.selectedRowKeys.add(row.rowKey);
      }
    } else {
      for (const row of diffRows) {
        this.selectedRowKeys.delete(row.rowKey);
      }
    }
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

  onConfigOnlyModeChange(on: boolean): void {
    if (on && !this.lastConfigImport) {
      this.showConfigRowsOnly = false;
      return;
    }
    this.showConfigRowsOnly = on;
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

  /**
   * Custom sort: apply Prime’s multiSortMeta to `filteredRows`, with a 3rd click cycle
   * (asc → desc → restore default row order) for single-column sorts.
   */
  onConfigTableCustomSort(event: { data: ConfigRow[]; mode: string; multiSortMeta: SortMeta[] | null }): void {
    const meta = event.multiSortMeta ?? [];

    if (meta.length !== 1) {
      this.tableSortTriStateAnchor = null;
      // Only multi-column (Ctrl/Cmd) sorts reach here with length > 1.
      // length === 0: Prime used to re-emit here after we set multiSortMeta = [] (array is truthy → sortMultiple → this handler → applyFilters). Use null when clearing instead; ignore empty.
      if (meta.length > 1) {
        this.sortFilteredRowsBySortMeta(meta);
      }
      this.safeMarkForCheck();
      return;
    }

    const single = meta[0];
    const field = String(single.field);
    const order = single.order;

    if (
      this.tableSortTriStateAnchor &&
      this.tableSortTriStateAnchor.field === field &&
      this.tableSortTriStateAnchor.order === -1 &&
      order === 1
    ) {
      this.tableSortTriStateAnchor = null;
      this.restoreFilteredRowsDatasetOrder();
      // `[]` is truthy: Prime’s ngOnChanges would call sortMultiple() again and re-fire sortFunction (empty), which used to run applyFilters() and grind the app. `null` skips that path.
      if (this.configTableRef) {
        this.configTableRef.multiSortMeta = null;
      }
      this.safeMarkForCheck();
      return;
    }

    this.tableSortTriStateAnchor = order === 1 || order === -1 ? { field, order: order as 1 | -1 } : null;
    this.sortFilteredRowsBySortMeta(meta);
    this.safeMarkForCheck();
  }

  /**
   * Put `filteredRows` back in the same order as `this.rows` (subset only). Used when clearing column sort;
   * avoids `applyFilters()` which re-runs every filter and ancillary UI work.
   */
  private restoreFilteredRowsDatasetOrder(): void {
    if (this.filteredRows.length === 0) {
      return;
    }
    const indexByKey = new Map<string, number>();
    for (let i = 0; i < this.rows.length; i++) {
      indexByKey.set(this.rows[i].rowKey, i);
    }
    this.filteredRows.sort((a, b) => (indexByKey.get(a.rowKey) ?? 0) - (indexByKey.get(b.rowKey) ?? 0));
  }

  private sortFilteredRowsBySortMeta(meta: SortMeta[]): void {
    if (meta.length === 0) {
      return;
    }
    this.filteredRows.sort((a, b) => {
      for (const m of meta) {
        const cmp = this.compareConfigRowsForSort(a, b, String(m.field), m.order);
        if (cmp !== 0) {
          return cmp;
        }
      }
      return 0;
    });
  }

  private compareConfigRowsForSort(a: ConfigRow, b: ConfigRow, field: string, order: number): number {
    const v1 = this.getCellValue(a, field);
    const v2 = this.getCellValue(b, field);
    const cmp = v1.localeCompare(v2, undefined, { numeric: true, sensitivity: 'base' });
    return order < 0 ? -cmp : cmp;
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

  /**
   * Move the table paginator by one page (← / →). Returns whether `tableFirst` changed.
   */
  private tryStepTablePage(direction: -1 | 1): boolean {
    const n = this.tableDisplayedRows.length;
    const r = this.rowsPerPage;
    if (n === 0 || r <= 0) {
      return false;
    }
    const pageCount = Math.ceil(n / r);
    if (pageCount <= 1) {
      return false;
    }
    const maxFirst = (pageCount - 1) * r;
    const nextFirst = Math.max(0, Math.min(maxFirst, this.tableFirst + direction * r));
    if (nextFirst === this.tableFirst) {
      return false;
    }
    this.tableFirst = nextFirst;
    return true;
  }

  /** Skip ←/→ paging when focus is in inputs, dialogs, or floating PrimeNG panels. */
  private shouldDeferTablePageKeys(target: HTMLElement): boolean {
    if (this.importMissingKeysDialogVisible) {
      return true;
    }
    if (target.closest('dialog')) {
      return true;
    }
    if (target.closest('[role="dialog"]')) {
      return true;
    }
    if (this.isEditableElement(target)) {
      return true;
    }
    if (target.tagName.toLowerCase() === 'select') {
      return true;
    }
    if (target.closest('.p-connected-overlay, .p-overlay, .p-select-overlay, .p-multiselect-overlay')) {
      return true;
    }
    return false;
  }

  onUtransferClick(): void {
    this.importConfigInputRef?.nativeElement?.click();
  }

  /** Rows with a non-empty import error message (trimmed). */
  get configImportErrorCount(): number {
    let n = 0;
    for (const row of this.rows) {
      if ((row.configImportError ?? '').trim().length > 0) {
        n += 1;
      }
    }
    return n;
  }

  get lastConfigImportKeyCount(): number {
    return this.lastConfigImport ? Object.keys(this.lastConfigImport.snapshot).length : 0;
  }

  onRemoveImportedConfigClick(): void {
    this.lastConfigImport = null;
    this.configImportRowKeys.clear();
    this.showConfigRowsOnly = false;
    this.selectedRowKeys.clear();
    for (const row of this.rows) {
      row.value = row.defaultValue ?? '';
      row.configImportError = '';
      row.valueImportResolvedHighlight = false;
      this.valueColumnMultiModelCache.delete(row.rowKey);
    }
    this.valueColumnSelectOptionsCache.clear();
    this.syncMatchInspectorToDisplayedTable();
    this.safeMarkForCheck();
    this.persistSettings();
  }

  onResetImportedConfigClick(): void {
    if (!this.lastConfigImport) {
      return;
    }
    this.applyJsonConfigImport(clonePlainJsonObject(this.lastConfigImport.snapshot), this.lastConfigImport.fileName);
  }

  onImportConfigFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const nameLower = file.name.toLowerCase();
      const parsed = nameLower.endsWith('.properties')
        ? parseImportedPropertiesFileText(text)
        : parseImportedConfigFileText(text);
      if (parsed === 'not-object') {
        globalThis.alert(
          'Config import requires a plain object at the root (not an array). Use a JSON object or YAML mapping.'
        );
        return;
      }
      if (parsed === null) {
        globalThis.alert(
          'Could not parse this file. For .properties use key=value lines (UTF-8). For other files use JSON or YAML with a root object.'
        );
        return;
      }
      this.applyJsonConfigImport(parsed, file.name);
    };
    reader.onerror = () => {
      globalThis.alert('Could not read the selected file.');
    };
    reader.readAsText(file, 'UTF-8');
  }

  private applyJsonConfigImport(obj: Record<string, unknown>, importedFileName: string): void {
    const filteredImportObject = filterIgnoredImportKeys(obj);
    this.configImportRowKeys.clear();
    const unmatchedKeys: string[] = [];
    for (const k of Object.keys(filteredImportObject)) {
      const trimmedKey = k.trim();
      const hasRow = this.rows.some((row) => row.property.trim() === trimmedKey);
      if (!hasRow) {
        unmatchedKeys.push(k);
      }
    }

    for (const row of this.rows) {
      row.configImportError = '';
      row.valueImportResolvedHighlight = false;
    }
    for (const k of Object.keys(filteredImportObject)) {
      const trimmedKey = k.trim();
      const matchingRows = this.rows.filter((row) => row.property.trim() === trimmedKey);
      for (const row of matchingRows) {
        this.configImportRowKeys.add(row.rowKey);
        const raw = this.coerceJsonImportValueToRaw(filteredImportObject[k]);
        if (this.jsonImportValueIsValid(row, raw)) {
          row.value = this.canonicalJsonImportStoredValue(row, raw);
          row.configImportError = '';
          row.valueImportResolvedHighlight = false;
          this.valueColumnMultiModelCache.delete(row.rowKey);
        } else {
          row.value = raw;
          row.configImportError = raw;
          row.valueImportResolvedHighlight = false;
          this.valueColumnMultiModelCache.delete(row.rowKey);
        }
      }
    }
    this.valueColumnSelectOptionsCache.clear();
    this.lastConfigImport = {
      fileName: importedFileName,
      snapshot: clonePlainJsonObject(filteredImportObject)
    };
    this.showConfigRowsOnly = true;
    this.tableFirst = 0;
    this.syncMatchInspectorToDisplayedTable();
    this.safeMarkForCheck();
    this.persistSettings();

    if (unmatchedKeys.length > 0) {
      const dialogRows = this.buildImportMissingKeyDialogRows(unmatchedKeys, filteredImportObject);
      this.openImportMissingKeysDialog(unmatchedKeys.length, dialogRows);
    }
  }

  trackByImportMissingRow(index: number, row: ImportMissingKeyDialogRow): string {
    return `${index}\0${row.property}\0${row.value}`;
  }

  importMissingKeyPropertyCopyId(index: number): string {
    return `importMissing:${index}:prop`;
  }

  importMissingKeyValueCopyId(index: number): string {
    return `importMissing:${index}:val`;
  }

  private buildImportMissingKeyDialogRows(
    unmatchedKeys: string[],
    obj: Record<string, unknown>
  ): ImportMissingKeyDialogRow[] {
    return unmatchedKeys.map((k) => ({
      property: k,
      value: this.coerceJsonImportValueToRaw(obj[k])
    }));
  }

  private openImportMissingKeysDialog(count: number, rows: ImportMissingKeyDialogRow[]): void {
    this.importMissingKeysDialogTitle =
      count === 1
        ? 'Import — 1 key not found'
        : `Import — ${count} keys not found`;
    this.importMissingKeysDialogRows = rows;
    this.importMissingKeysDialogVisible = true;
    this.safeMarkForCheck();
  }

  closeImportMissingKeysDialog(): void {
    this.importMissingKeysDialogVisible = false;
    this.importMissingKeysDialogTitle = '';
    this.importMissingKeysDialogRows = [];
  }

  onImportMissingKeysPanelClick(event: MouseEvent): void {
    event.stopPropagation();
  }

  private coerceJsonImportValueToRaw(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (typeof value === 'number') {
      return String(value);
    }
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((el) => this.coerceJsonImportArrayElementToRaw(el)).join(',');
    }
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }
    if (typeof value === 'bigint') {
      return String(value);
    }
    return '';
  }

  private coerceJsonImportArrayElementToRaw(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (typeof value === 'number') {
      return String(value);
    }
    if (typeof value === 'string') {
      return value;
    }
    return JSON.stringify(value);
  }

  /**
   * Match import token to an allowed Value option with case-insensitive comparison;
   * returns the spelling from the allowed list, or `null` if no match (empty token → `null`).
   */
  private resolveImportTokenToAllowedSpelling(allowedList: string[], candidate: string): string | null {
    const t = candidate.trim();
    if (t === '') {
      return null;
    }
    const down = t.toLowerCase();
    for (const opt of allowedList) {
      if (opt.toLowerCase() === down) {
        return opt;
      }
    }
    return null;
  }

  private jsonImportValueIsValid(row: ConfigRow, raw: string): boolean {
    if (this.isValueColumnBooleanType(row)) {
      const t = raw.trim().toLowerCase();
      return t === '' || t === 'true' || t === 'false';
    }
    if (this.valueColumnUsesMultiSelect(row)) {
      const allowed = this.getValueColumnAllowedOptionValues(row);
      const tokens = this.parseListStyleCellToTokens(raw);
      if (tokens.length === 0) {
        return true;
      }
      return tokens.every((tok) => this.resolveImportTokenToAllowedSpelling(allowed, tok) !== null);
    }
    if (this.valueColumnUsesSingleSelectFromAllowed(row)) {
      const t = raw.trim();
      if (t === '') {
        return true;
      }
      return this.resolveImportTokenToAllowedSpelling(this.getValueColumnAllowedOptionValues(row), t) !== null;
    }
    return true;
  }

  private canonicalJsonImportStoredValue(row: ConfigRow, raw: string): string {
    if (this.isValueColumnBooleanType(row)) {
      const t = raw.trim().toLowerCase();
      return t === '' ? '' : t;
    }
    if (this.valueColumnUsesMultiSelect(row)) {
      const allowed = this.getValueColumnAllowedOptionValues(row);
      const canonical = this.parseListStyleCellToTokens(raw)
        .map((tok) => this.resolveImportTokenToAllowedSpelling(allowed, tok))
        .filter((x): x is string => x !== null);
      return [...canonical].sort((a, b) => a.localeCompare(b)).join(',');
    }
    if (this.valueColumnUsesSingleSelectFromAllowed(row)) {
      const t = raw.trim();
      if (t === '') {
        return '';
      }
      const resolved = this.resolveImportTokenToAllowedSpelling(this.getValueColumnAllowedOptionValues(row), t);
      return resolved ?? t;
    }
    return raw;
  }

  toggleExportFormatMenu(event: MouseEvent): void {
    event.stopPropagation();
    if (this.selectedDatasetCount === 0) {
      return;
    }
    this.exportFormatMenuOpen = !this.exportFormatMenuOpen;
    this.exportToFileSubmenuOpen = false;
    if (this.exportFormatMenuOpen) {
      this.closeToolbarMenus('export');
    }
    this.safeMarkForCheck();
  }

  toggleExportToFileSubmenu(event: MouseEvent): void {
    event.stopPropagation();
    this.exportToFileSubmenuOpen = !this.exportToFileSubmenuOpen;
    this.safeMarkForCheck();
  }

  toggleImportConfigMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.importConfigMenuOpen = !this.importConfigMenuOpen;
    if (this.importConfigMenuOpen) {
      this.closeToolbarMenus('import');
    }
    this.safeMarkForCheck();
  }

  toggleTableSettingsMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.tableSettingsMenuOpen = !this.tableSettingsMenuOpen;
    if (this.tableSettingsMenuOpen) {
      this.closeToolbarMenus('settings');
    }
    this.safeMarkForCheck();
  }

  onImportConfigFromFileChosen(event: MouseEvent): void {
    event.stopPropagation();
    this.importConfigMenuOpen = false;
    this.onUtransferClick();
    this.safeMarkForCheck();
  }

  onImportConfigFromInstallationChosen(event: MouseEvent): void {
    event.stopPropagation();
    this.importConfigMenuOpen = false;
    this.installationImportWizardVisible = true;
    this.safeMarkForCheck();
  }

  onInstallationImportApplied(payload: { source: string; merged: Record<string, string> }): void {
    this.installationImportWizardVisible = false;
    this.applyJsonConfigImport(payload.merged, payload.source);
    this.safeMarkForCheck();
  }

  onInstallationImportClosed(): void {
    this.installationImportWizardVisible = false;
    this.safeMarkForCheck();
  }

  onTableSettingsResetChosen(event: MouseEvent): void {
    event.stopPropagation();
    this.tableSettingsMenuOpen = false;
    this.resetTableSettings();
  }

  onTableSettingsExportChosen(event: MouseEvent): void {
    event.stopPropagation();
    this.tableSettingsMenuOpen = false;
    this.exportTableSettingsToJsonFile();
    this.safeMarkForCheck();
  }

  onTableSettingsImportChosen(event: MouseEvent): void {
    event.stopPropagation();
    this.tableSettingsMenuOpen = false;
    this.triggerImportTableSettingsFile();
    this.safeMarkForCheck();
  }

  onExportFormatChosen(format: 'json' | 'yaml' | 'properties', event: MouseEvent): void {
    event.stopPropagation();
    this.exportFormatMenuOpen = false;
    this.exportToFileSubmenuOpen = false;
    switch (format) {
      case 'json':
        this.exportSelectedToJson();
        break;
      case 'yaml':
        this.exportSelectedToYaml();
        break;
      case 'properties':
        this.exportSelectedToProperties();
        break;
    }
    this.safeMarkForCheck();
  }

  exportSelectedToCsv(): void {
    const cols = this.visibleColumns;
    if (cols.length === 0) {
      return;
    }
    const selected = this.rows.filter((row) => this.selectedRowKeys.has(row.rowKey));
    if (selected.length === 0) {
      return;
    }
    const headerLine = cols.map((c) => escapeCsvField(c.label)).join(',');
    const lines = selected.map((row) =>
      cols.map((col) => escapeCsvField(this.getCellValue(row, col.key))).join(',')
    );
    const body = [headerLine, ...lines].join('\r\n');
    const blob = new Blob([`\ufeff${body}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = buildSelectionExportFilename('csv');
    anchor.click();
    URL.revokeObjectURL(url);
  }

  exportSelectedToJson(): void {
    if (this.selectedDatasetCount === 0) {
      return;
    }
    const out = this.buildSelectionExportPropertyValueMap();
    const body = `${JSON.stringify(out, null, 2)}\n`;
    const blob = new Blob([body], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = buildSelectionExportFilename('json');
    anchor.click();
    URL.revokeObjectURL(url);
  }

  exportSelectedToYaml(): void {
    if (this.selectedDatasetCount === 0) {
      return;
    }
    const out = this.buildSelectionExportPropertyValueMap();
    const yamlText = stringifyYaml(out, { lineWidth: 0 });
    const body = yamlText.endsWith('\n') ? yamlText : `${yamlText}\n`;
    const blob = new Blob([body], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = buildSelectionExportFilename('yaml');
    anchor.click();
    URL.revokeObjectURL(url);
  }

  exportSelectedToProperties(): void {
    if (this.selectedDatasetCount === 0) {
      return;
    }
    const out = this.buildSelectionExportPropertyValueMap();
    const body = stringifyJavaPropertiesFile(out);
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = buildSelectionExportFilename('properties');
    anchor.click();
    URL.revokeObjectURL(url);
  }

  /** Key → Value strings for JSON/YAML/properties selection export. */
  private buildSelectionExportPropertyValueMap(): Record<string, string> {
    const selected = this.rows.filter((row) => this.selectedRowKeys.has(row.rowKey));
    const out: Record<string, string> = {};
    for (const row of selected) {
      const prop = this.getCellValue(row, 'property').trim();
      if (!prop) {
        continue;
      }
      let value = this.getCellValue(row, 'value');
      if (this.valueColumnUsesMultiSelect(row)) {
        value = this.parseListStyleCellToTokens(value).join(',');
      }
      out[prop] = value;
    }
    return out;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['rows']) {
      return;
    }

    this.lastConfigImport = null;
    this.configImportRowKeys.clear();
    this.showConfigRowsOnly = false;
    if (this.importMissingKeysDialogVisible) {
      this.closeImportMissingKeysDialog();
    }
    this.valueColumnMultiModelCache.clear();
    this.valueColumnSelectOptionsCache.clear();

    this.rebuildColumnsFromRows();

    if (!this.restoredSettings) {
      this.restoreSettings();
      this.restoredSettings = true;
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
    if (this.copyResetTimerId !== undefined) {
      globalThis.clearTimeout(this.copyResetTimerId);
    }
  }

  onColumnVisibilityChange(): void {
    const selectedSet = new Set(this.ensurePropertyVisible(this.visibleColumnKeys));
    this.visibleColumnKeys = this.columnOrderKeys.filter((key) => selectedSet.has(key));

    if (this.visibleColumnKeys.length === 0 && this.columnOrderKeys.length > 0) {
      this.visibleColumnKeys = this.ensurePropertyVisible([this.columnOrderKeys[0]]);
    }

    this.onFiltersChanged();
  }

  /** Header × control: hide column (Key is never closable). Same as clearing it in Visible columns. */
  hideColumnFromHeader(columnKey: string, event: Event): void {
    event.stopPropagation();
    event.preventDefault();
    if (columnKey === 'property') {
      return;
    }
    this.visibleColumnKeys = this.visibleColumnKeys.filter((key) => key !== columnKey);
    this.onColumnVisibilityChange();
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
    this.persistSettings();
  }

  onFiltersChanged(): void {
    this.applyFilters();
    this.persistSettings();
  }

  /** Returns the effective filter type for a column, accounting for text overrides. */
  getEffectiveFilterType(key: string): 'text' | 'select' | 'list' {
    const column = this.columns.find((c) => c.key === key);
    if (!column) {
      return 'text';
    }
    if ((column.filterType === 'select' || column.filterType === 'list') && this.listFilterTextOverrides.has(key)) {
      return 'text';
    }
    return column.filterType;
  }

  /** Whether a column's native filterType is select or list (toggle is available). */
  isFilterTypeToggleable(key: string): boolean {
    const column = this.columns.find((c) => c.key === key);
    return column?.filterType === 'select' || column?.filterType === 'list';
  }

  toggleFilterTextOverride(key: string): void {
    if (this.listFilterTextOverrides.has(key)) {
      // Switching back to list/select: clear text filter state
      delete this.textFilters[key];
      delete this.textModes[key];
      delete this.textFilterMatchCase[key];
      delete this.textFilterWholeWord[key];
      this.listFilterTextOverrides.delete(key);
    } else {
      // Switching to text: clear value filter state
      delete this.valueFilters[key];
      this.listFilterTextOverrides.add(key);
    }
    this.onFiltersChanged();
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
    if (!value.trim()) {
      delete this.textFilterMatchCase[key];
      delete this.textFilterWholeWord[key];
    }
    this.onFiltersChanged();
  }

  getTextFilterMatchCase(key: string): boolean {
    return !!this.textFilterMatchCase[key];
  }

  getTextFilterWholeWord(key: string): boolean {
    return !!this.textFilterWholeWord[key];
  }

  toggleGlobalFilterMatchCase(): void {
    this.globalFilterMatchCase = !this.globalFilterMatchCase;
    this.onFiltersChanged();
  }

  toggleGlobalFilterWholeWord(): void {
    this.globalFilterWholeWord = !this.globalFilterWholeWord;
    this.onFiltersChanged();
  }

  toggleTextFilterMatchCase(key: string): void {
    this.textFilterMatchCase[key] = !this.textFilterMatchCase[key];
    if (!this.textFilterMatchCase[key]) {
      delete this.textFilterMatchCase[key];
    }
    this.onFiltersChanged();
  }

  toggleTextFilterWholeWord(key: string): void {
    this.textFilterWholeWord[key] = !this.textFilterWholeWord[key];
    if (!this.textFilterWholeWord[key]) {
      delete this.textFilterWholeWord[key];
    }
    this.onFiltersChanged();
  }

  getTextMode(key: string): TextMatchMode {
    const mode = this.textModes[key];
    return mode === 'regex' ? 'regex' : 'expr';
  }

  toggleGlobalFilterRegex(): void {
    this.globalFilterMode = this.globalFilterMode === 'regex' ? 'expr' : 'regex';
    this.onFiltersChanged();
  }

  toggleTextFilterRegex(key: string): void {
    const next = this.getTextMode(key) === 'regex' ? 'expr' : 'regex';
    if (next === 'expr') {
      delete this.textModes[key];
    } else {
      this.textModes[key] = 'regex';
    }
    this.onFiltersChanged();
  }

  clearGlobalFilterInput(): void {
    if (!this.globalFilter) {
      return;
    }
    this.globalFilter = '';
    this.onFiltersChanged();
  }

  isColumnTextFilterClearable(key: string): boolean {
    if ((this.textFilters[key] ?? '').trim()) {
      return true;
    }
    if (this.textModes[key] === 'regex') {
      return true;
    }
    if (this.textFilterMatchCase[key]) {
      return true;
    }
    if (this.textFilterWholeWord[key]) {
      return true;
    }
    return false;
  }

  clearTextFilterInput(key: string): void {
    if (!this.isColumnTextFilterClearable(key)) {
      return;
    }
    delete this.textFilters[key];
    delete this.textModes[key];
    delete this.textFilterMatchCase[key];
    delete this.textFilterWholeWord[key];
    this.onFiltersChanged();
  }

  setGlobalFilterScope(scope: string): void {
    this.globalFilterScope = scope === 'visible' ? 'visible' : 'all';
    this.onFiltersChanged();
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

  trackByAllowedScopeRow(index: number, row: CellDetailAllowedScopeRow): string {
    return `${index}:${row.scope}`;
  }

  private buildCellDetailAllowedScopeRows(raw: string): CellDetailAllowedScopeRow[] {
    return this.parseCommaSeparatedCellList(raw)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((scope) => ({
        scope,
        roles: this.getUnbluScopeEditorRoles(scope)
      }));
  }

  private getUnbluScopeEditorRoles(scope: string): string[] {
    const key = scope.trim().toUpperCase();
    const list = UNBLU_SCOPE_EDITORS[key];
    return list ?? [];
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
    this.closeCellCmdPreview();
    this.openCellDetailDialog(row, column);
  }

  /** Data body cells: Shift = match inspector; Cmd/Ctrl = cell content preview (same shell as match inspector). */
  onBodyDataCellPointerMove(event: MouseEvent, row: ConfigRow, column: ColumnDefinition): void {
    this.pointerContextRow = row;
    this.pointerContextColumn = column;
    this.pointerContextClientX = event.clientX;
    this.pointerContextClientY = event.clientY;

    if (this.isShiftHeldForMatchInspector(event)) {
      this.closeCellCmdPreview();
      this.openMatchInspector(event, row);
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      this.closeMatchInspector();
      const t = event.target as HTMLElement | null;
      if (t && this.isInteractiveCellTarget(t)) {
        this.closeCellCmdPreview();
      } else {
        this.openCellCmdPreview(event, row, column);
      }
      return;
    }
    this.closeMatchInspector();
    this.closeCellCmdPreview();
  }

  private isInteractiveCellTarget(el: HTMLElement): boolean {
    const node = el.closest(
      'button, a, input, textarea, select, label, .p-multiselect, .p-multiselect-panel, .p-multiselect-header, .p-multiselect-item'
    );
    return Boolean(node);
  }

  private applyCellDetailDialogState(row: ConfigRow, column: ColumnDefinition): void {
    this.cellDetailDialogRowKey = row.rowKey;
    this.cellDetailDialogColumnKey = column.key;
    this.cellDetailDialogPropertyCode = this.getCellValue(row, 'property')?.trim() ?? '';
    const raw = this.getCellValue(row, column.key);
    if (column.key === 'allowedValues') {
      this.cellDetailDialogAllowedScopeRows = null;
      this.cellDetailDialogAllowedLines = [...this.getWhitespaceValueParts(raw)];
      this.cellDetailDialogPlainText = '';
    } else if (column.key === 'allowedScopes') {
      this.cellDetailDialogAllowedLines = null;
      this.cellDetailDialogAllowedScopeRows = this.buildCellDetailAllowedScopeRows(raw ?? '');
      this.cellDetailDialogPlainText = '';
    } else if (column.key === 'editableBy') {
      this.cellDetailDialogAllowedScopeRows = null;
      this.cellDetailDialogAllowedLines = this.parseCommaSeparatedCellList(raw ?? '');
      this.cellDetailDialogPlainText = '';
    } else if (column.key === 'dependsOn') {
      this.cellDetailDialogAllowedScopeRows = null;
      this.cellDetailDialogAllowedLines = [...(row.dependsOn ?? [])];
      this.cellDetailDialogPlainText = '';
    } else {
      this.cellDetailDialogAllowedLines = null;
      this.cellDetailDialogAllowedScopeRows = null;
      this.cellDetailDialogPlainText = raw?.trim() ?? '';
    }
  }

  private openCellDetailDialog(row: ConfigRow, column: ColumnDefinition): void {
    this.cellCmdPreviewOpen = false;
    this.applyCellDetailDialogState(row, column);
    this.safeMarkForCheck();
    queueMicrotask(() => {
      const dialog = this.cellDetailDialogEl?.nativeElement;
      if (dialog && !dialog.open) {
        dialog.showModal();
      }
    });
  }

  private openCellCmdPreview(event: MouseEvent, row: ConfigRow, column: ColumnDefinition): void {
    if (this.cellDetailDialogEl?.nativeElement.open) {
      return;
    }
    if (
      this.cellCmdPreviewOpen &&
      this.cellDetailDialogRowKey === row.rowKey &&
      this.cellDetailDialogColumnKey === column.key
    ) {
      this.positionMatchInspector(event);
      return;
    }
    this.applyCellDetailDialogState(row, column);
    this.cellCmdPreviewOpen = true;
    this.positionMatchInspector(event);
    this.safeMarkForCheck();
  }

  private closeCellCmdPreview(): void {
    if (!this.cellCmdPreviewOpen) {
      return;
    }
    this.cellCmdPreviewOpen = false;
    const dialogEl = this.cellDetailDialogEl?.nativeElement;
    if (!dialogEl?.open) {
      this.clearCellDetailDialogState();
    }
    this.safeMarkForCheck();
  }

  private clearCellDetailDialogState(): void {
    this.cellDetailDialogRowKey = null;
    this.cellDetailDialogColumnKey = null;
    this.cellDetailDialogPropertyCode = '';
    this.cellDetailDialogPlainText = '';
    this.cellDetailDialogAllowedLines = null;
    this.cellDetailDialogAllowedScopeRows = null;
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
    this.cellCmdPreviewOpen = false;
    this.clearCellDetailDialogState();
    this.safeMarkForCheck();
  }

  get isCellDetailDialogItemList(): boolean {
    const key = this.cellDetailDialogColumnKey;
    if (key === 'allowedScopes') {
      return this.cellDetailDialogAllowedScopeRows !== null;
    }
    return (
      (key === 'allowedValues' || key === 'editableBy' || key === 'dependsOn') &&
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
    this.pointerContextColumn = null;
    this.pointerContextClientX = event.clientX;
    this.pointerContextClientY = event.clientY;

    if (!this.isShiftHeldForMatchInspector(event)) {
      this.closeMatchInspector();
      this.closeCellCmdPreview();
      return;
    }
    this.closeCellCmdPreview();
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
    this.closeCellCmdPreview();
    if (!this.pointerContextRow) {
      return;
    }
    const synthetic = {
      clientX: this.pointerContextClientX,
      clientY: this.pointerContextClientY
    } as MouseEvent;
    this.openMatchInspector(synthetic, this.pointerContextRow);
  }

  private tryOpenCellCmdPreviewFromKeyboard(event: KeyboardEvent): void {
    if (!event.metaKey && !event.ctrlKey) {
      return;
    }
    if (event.shiftKey || this.matchInspectorShiftFromKeyboard) {
      return;
    }
    if (!this.pointerContextRow || !this.pointerContextColumn) {
      return;
    }
    if (this.cellDetailDialogEl?.nativeElement.open) {
      return;
    }
    if (typeof document !== 'undefined' && document.elementFromPoint) {
      const hit = document.elementFromPoint(this.pointerContextClientX, this.pointerContextClientY);
      if (hit instanceof HTMLElement && this.isInteractiveCellTarget(hit)) {
        return;
      }
    }
    const synthetic = {
      clientX: this.pointerContextClientX,
      clientY: this.pointerContextClientY
    } as MouseEvent;
    this.openCellCmdPreview(synthetic, this.pointerContextRow, this.pointerContextColumn);
  }

  onRowHoverLeave(): void {
    this.closeMatchInspector();
    this.closeCellCmdPreview();
    this.pointerContextRow = null;
    this.pointerContextColumn = null;
  }

  private openMatchInspector(event: MouseEvent, row: ConfigRow): void {
    this.closeCellCmdPreview();
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
        const regex = this.tryParseRegexInput(globalInput, {
          matchCase: this.globalFilterMatchCase,
          wholeWord: this.globalFilterWholeWord
        });
        if (regex) {
          const matchedColumns = columnsToSearch
            .filter((column) => this.matchesRegex(this.getCellValue(row, column.key), regex))
            .map((column) => column.label);
          if (matchedColumns.length > 0) {
            reasons.push({
              label: 'Global',
              detail: `${globalInput} -> ${matchedColumns.join(', ')}`
            });
          }
        }
      } else {
        const pr = parseFilterExpression(globalInput);
        if (pr.ok) {
          const rowValues = columnsToSearch.map((column) => this.getCellValue(row, column.key) ?? '');
          const rowContains = (t: string): boolean =>
            rowValues.some((v) =>
              this.textFilterAtomMatches(v, t, {
                matchCase: this.globalFilterMatchCase,
                wholeWord: this.globalFilterWholeWord
              })
            );
          const lines = formatExpressionMatchLines(pr.ast, rowContains);
          if (lines.length > 0) {
            reasons.push({
              label: 'Global',
              detail: '',
              detailBullets: lines
            });
          }
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
          const regex = this.tryParseRegexInput(input, {
            matchCase: this.getTextFilterMatchCase(column.key),
            wholeWord: this.getTextFilterWholeWord(column.key)
          });
          if (regex && this.matchesRegex(value, regex)) {
            reasons.push({
              label: `${column.label} (${mode.toUpperCase()})`,
              detail: input
            });
          }
          continue;
        }

        const pr = parseFilterExpression(input);
        if (pr.ok) {
          const lines = formatExpressionMatchLines(pr.ast, (op) =>
            this.textFilterAtomMatches(value, op, {
              matchCase: this.getTextFilterMatchCase(column.key),
              wholeWord: this.getTextFilterWholeWord(column.key)
            })
          );
          if (lines.length > 0) {
            reasons.push({
              label: `${column.label} (EXPR)`,
              detail: '',
              detailBullets: lines
            });
          }
        }
        continue;
      }

      const selectedValues = this.valueFilters[column.key] ?? [];
      if (selectedValues.length === 0) {
        continue;
      }

      if (column.filterType === 'list') {
        const tokens = this.listColumnNormalizedTokenSet(row, column.key);
        const noneN = this.normalize(COLUMN_FILTER_NONE_VALUE);
        const selectedNorm = selectedValues.map((value) => this.normalize(value));
        const matchedLabels: string[] = [];
        if (selectedNorm.includes(noneN) && tokens.size === 0) {
          matchedLabels.push('None');
        }
        for (const value of selectedValues) {
          if (this.normalize(value) === noneN) {
            continue;
          }
          if (tokens.has(this.normalize(value))) {
            matchedLabels.push(value);
          }
        }
        if (matchedLabels.length > 0) {
          reasons.push({
            label: `${column.label} (${this.getListMode(column.key).toUpperCase()})`,
            detail: matchedLabels.join(', ')
          });
        }
        continue;
      }

      if (column.filterType === 'select') {
        const rowValue = this.normalize(this.getCellValue(row, column.key));
        const noneN = this.normalize(COLUMN_FILTER_NONE_VALUE);
        const selectedNorm = selectedValues.map((value) => this.normalize(value));
        const details: string[] = [];
        if (selectedNorm.includes(noneN) && rowValue === '') {
          details.push('None');
        }
        const matched = selectedValues.find(
          (value) => this.normalize(value) !== noneN && this.normalize(value) === rowValue
        );
        if (matched) {
          details.push(matched);
        }
        if (details.length > 0) {
          reasons.push({
            label: `${column.label} (SELECT)`,
            detail: details.join(', ')
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

  exportTableSettingsToJsonFile(): void {
    this.persistSettings();
    const raw = this.readRawTableSettings();
    let body: string;
    try {
      const obj = raw ? JSON.parse(raw) : {};
      body = JSON.stringify(obj, null, 2);
    } catch {
      globalThis.alert('Stored table settings are not valid JSON; export aborted.');
      return;
    }
    const blob = new Blob([body], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'unblu-properties-explorer-table-settings.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  triggerImportTableSettingsFile(): void {
    this.importTableSettingsInputRef?.nativeElement?.click();
  }

  onImportTableSettingsFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        globalThis.alert('Could not parse JSON.');
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        globalThis.alert('Table settings file must be a JSON object at the root.');
        return;
      }
      try {
        localStorage.setItem(this.settingsStorageKey, JSON.stringify(parsed));
      } catch {
        globalThis.alert('Could not write to local storage.');
        return;
      }
      this.restoreSettings();
      this.sanitizeFilters();
      this.onFiltersChanged();
      this.safeMarkForCheck();
    };
    reader.onerror = () => {
      globalThis.alert('Could not read the selected file.');
    };
    reader.readAsText(file, 'UTF-8');
  }

  /** Clear persisted settings, filters/columns, and all row selections (as when localStorage has no entry). */
  resetTableSettings(): void {
    try {
      localStorage.removeItem(this.settingsStorageKey);
    } catch {
      /* ignore quota / private mode */
    }

    this.globalFilter = '';
    this.globalFilterMode = 'expr';
    this.globalFilterScope = 'visible';
    this.globalFilterMatchCase = false;
    this.globalFilterWholeWord = false;
    this.textFilters = {};
    this.textModes = {};
    this.textFilterMatchCase = {};
    this.textFilterWholeWord = {};
    this.valueFilters = {};
    this.listModes = {
      allowedScopes: 'or',
      editableBy: 'or'
    };
    this.columnOrderKeys = this.columns.map((column) => column.key);
    this.visibleColumnKeys = this.ensurePropertyVisible([...this.columnOrderKeys]);

    this.tableFirst = 0;
    this.showSelectedRowsOnly = false;
    this.selectedRowKeys.clear();
    this.tableSortTriStateAnchor = null;
    if (this.configTableRef) {
      this.configTableRef.multiSortMeta = null;
    }

    this.applyFilters();
    this.syncMatchInspectorToDisplayedTable();
    this.safeMarkForCheck();
  }

  clearFilters(): void {
    this.globalFilter = '';
    this.globalFilterMode = 'expr';
    this.globalFilterScope = 'visible';
    this.globalFilterMatchCase = false;
    this.globalFilterWholeWord = false;
    this.textFilters = {};
    this.textModes = {};
    this.textFilterMatchCase = {};
    this.textFilterWholeWord = {};
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
      delete this.textFilters[chip.columnKey];
      delete this.textModes[chip.columnKey];
      delete this.textFilterMatchCase[chip.columnKey];
      delete this.textFilterWholeWord[chip.columnKey];
      this.onFiltersChanged();
      return;
    }

    if (chip.kind === 'value' && chip.value !== undefined) {
      const values = this.valueFilters[chip.columnKey] ?? [];
      this.valueFilters[chip.columnKey] = values.filter((value) => value !== chip.value);
      this.onFiltersChanged();
    }
  }

  private applyFilters(): void {
    this.syncExprPredicates();

    this.filteredRows = this.rows.filter((row) => {
      if (!this.passesGlobalFilter(row)) {
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

  /** Rebuild expression predicates used by `passesGlobalFilter` / text column filters (call from `applyFilters`). */
  private syncExprPredicates(): void {
    this.globalExprRowPredicate = null;
    this.columnTextExprPredicates.clear();

    if (this.globalFilterMode === 'expr') {
      const pr = parseFilterExpression(this.globalFilter);
      if (!pr.ok) {
        this.globalExprRowPredicate =
          pr.error === FILTER_EXPR_EMPTY_ERROR ? () => true : () => false;
      } else {
        const ast = pr.ast;
        const gCase = this.globalFilterMatchCase;
        const gWord = this.globalFilterWholeWord;
        this.globalExprRowPredicate = (row: ConfigRow) => {
          const columnsToSearch = this.globalFilterScope === 'visible' ? this.visibleColumns : this.columns;
          const rowValues = columnsToSearch.map((column) => this.getCellValue(row, column.key) ?? '');
          const rowContains = (s: string): boolean =>
            rowValues.some((value) => this.textFilterAtomMatches(value, s, { matchCase: gCase, wholeWord: gWord }));
          return evaluateFilterAst(ast, rowContains);
        };
      }
    }

    for (const column of this.columns) {
      if (this.getEffectiveFilterType(column.key) !== 'text') {
        continue;
      }
      if (this.getTextMode(column.key) !== 'expr') {
        continue;
      }
      const pr = parseFilterExpression(this.textFilters[column.key] ?? '');
      if (!pr.ok) {
        this.columnTextExprPredicates.set(
          column.key,
          pr.error === FILTER_EXPR_EMPTY_ERROR ? () => true : () => false
        );
        continue;
      } else {
        const ast = pr.ast;
        const cCase = this.getTextFilterMatchCase(column.key);
        const cWord = this.getTextFilterWholeWord(column.key);
        this.columnTextExprPredicates.set(column.key, (value: string) => {
          return evaluateFilterAst(ast, (op) =>
            this.textFilterAtomMatches(value, op, { matchCase: cCase, wholeWord: cWord })
          );
        });
      }
    }
  }

  private passesGlobalFilter(row: ConfigRow): boolean {
    if (this.globalFilterMode === 'regex') {
      const t = this.globalFilter.trim();
      if (!t) {
        return true;
      }
      const regex = this.tryParseRegexInput(this.globalFilter, {
        matchCase: this.globalFilterMatchCase,
        wholeWord: this.globalFilterWholeWord
      });
      if (!regex) {
        return true;
      }
      const columnsToSearch = this.globalFilterScope === 'visible' ? this.visibleColumns : this.columns;
      const rawValues = columnsToSearch.map((column) => this.getCellValue(row, column.key));
      return rawValues.some((value) => this.matchesRegex(value, regex));
    }

    const pred = this.globalExprRowPredicate;
    return pred ? pred(row) : true;
  }

  private columnFilterChipValueLabel(value: string): string {
    return value === COLUMN_FILTER_NONE_VALUE ? 'None' : value;
  }

  /** Non-empty normalized tokens for list columns (allowed scopes, editable by). */
  private listColumnNormalizedTokenSet(row: ConfigRow, columnKey: string): Set<string> {
    const list = columnKey === 'allowedScopes' ? row.allowedScopesTokens : row.editableByTokens;
    return new Set(
      list.map((token) => this.normalize(token)).filter((token) => token.length > 0)
    );
  }

  private rowMatchesColumnFilter(row: ConfigRow, column: ColumnDefinition): boolean {
    const effectiveType = this.getEffectiveFilterType(column.key);
    if (effectiveType === 'text') {
      const textMode = this.getTextMode(column.key);
      const raw = (this.textFilters[column.key] ?? '').trim();
      if (textMode === 'regex') {
        if (raw) {
          const textRegex = this.tryParseRegexInput(this.textFilters[column.key] ?? '', {
            matchCase: this.getTextFilterMatchCase(column.key),
            wholeWord: this.getTextFilterWholeWord(column.key)
          });
          if (textRegex) {
            const value = this.getCellValue(row, column.key);
            if (!this.matchesRegex(value, textRegex)) {
              return false;
            }
          }
        }
      } else {
        const pred = this.columnTextExprPredicates.get(column.key);
        if (pred && !pred(this.getCellValue(row, column.key))) {
          return false;
        }
      }
    }

    const selectedValues = this.valueFilters[column.key] ?? [];
    if (selectedValues.length === 0) {
      return true;
    }

    if (effectiveType === 'list') {
      const listKey = this.toListColumnKey(column.key);
      const selectedNormalized = selectedValues.map((value) => this.normalize(value));
      const noneN = this.normalize(COLUMN_FILTER_NONE_VALUE);
      const tokens = this.listColumnNormalizedTokenSet(row, column.key);
      const rowIsNone = tokens.size === 0;

      if (this.listModes[listKey] === 'and') {
        return selectedNormalized.every((selected) => {
          if (selected === noneN) {
            return rowIsNone;
          }
          return tokens.has(selected);
        });
      }

      return selectedNormalized.some((selected) => {
        if (selected === noneN) {
          return rowIsNone;
        }
        return tokens.has(selected);
      });
    }

    if (effectiveType === 'text') {
      return true;
    }

    const rowValue = this.normalize(this.getCellValue(row, column.key));
    const noneN = this.normalize(COLUMN_FILTER_NONE_VALUE);
    const selectedNormalized = selectedValues.map((value) => this.normalize(value));
    if (selectedNormalized.includes(noneN) && rowValue === '') {
      return true;
    }
    return selectedNormalized.some((s) => s !== noneN && s === rowValue);
  }

  private sanitizeFilters(): void {
    for (const column of this.columns) {
      if (column.filterType !== 'text') {
        delete this.textFilters[column.key];
        delete this.textModes[column.key];
        delete this.textFilterMatchCase[column.key];
        delete this.textFilterWholeWord[column.key];
      }
    }

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

      if (column.key === 'status') {
        optionsMap['status'] = PROPERTY_STATUS_OPTIONS.map((value: string) => ({ label: value, value }));
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

      let sortFn: (left: string, right: string) => number;
      if (column.key === 'allowedScopes') {
        sortFn = (left, right) => allowedScopeRank(left) - allowedScopeRank(right);
      } else if (column.key === 'editableBy') {
        sortFn = (left, right) => editableByRank(left) - editableByRank(right);
      } else {
        sortFn = (left, right) => left.localeCompare(right);
      }
      const sorted = [...values]
        .sort(sortFn)
        .map((value) => ({ label: value, value }));

      const hasEmptySource =
        column.key === 'source' && rows.some((row) => !this.getCellValue(row, 'source').trim());

      if (column.key === 'allowedScopes' || column.key === 'visibility' || column.key === 'editableBy') {
        optionsMap[column.key] = [...sorted, { label: 'None', value: COLUMN_FILTER_NONE_VALUE }];
      } else if (hasEmptySource) {
        optionsMap[column.key] = [...sorted, { label: 'None', value: COLUMN_FILTER_NONE_VALUE }];
      } else {
        optionsMap[column.key] = sorted;
      }
    }

    return optionsMap;
  }

  getCellValue(row: ConfigRow, key: string): string {
    if (key === 'source') {
      return row.source ?? '';
    }
    if (key === 'dependsOn') {
      return (row.dependsOn ?? []).join(', ');
    }
    if (key === 'allowedScopes') {
      return sortAllowedScopes(row.allowedScopesTokens ?? []).join(', ');
    }
    if (key === 'editableBy') {
      return sortEditableBy(row.editableByTokens ?? []).join(', ');
    }
    if (key.startsWith(EXTRA_COLUMN_PREFIX)) {
      return row.extra[key] ?? '';
    }
    const field = key as keyof ConfigRow;
    if (
      field === 'extra' ||
      field === 'allowedScopesTokens' ||
      field === 'editableByTokens' ||
      field === 'valueImportResolvedHighlight'
    ) {
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

  private syncMatchInspectorToDisplayedTable(): void {
    if (this.isMatchInspectorOpen && this.matchInspectorRow) {
      if (!this.tableDisplayedRows.includes(this.matchInspectorRow)) {
        this.closeMatchInspector();
      }
    }
    if (this.cellCmdPreviewOpen && this.cellDetailDialogRowKey) {
      const previewRow = this.rows.find((r) => r.rowKey === this.cellDetailDialogRowKey) ?? null;
      if (!previewRow || !this.tableDisplayedRows.includes(previewRow)) {
        this.closeCellCmdPreview();
      }
    }
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
    const allowedVals = this.getValueColumnAllowedOptionValues(row);
    const opts: SelectOption[] = [];
    for (const v of [...allowedVals].sort((a, b) => a.localeCompare(b))) {
      opts.push({ label: v, value: v });
    }
    this.valueColumnSelectOptionsCache.set(cacheKey, opts);
    return opts;
  }

  /** Blank `<select>` option / multiselect clear when default is empty (trimmed). */
  valueColumnAllowsEmptyChoice(row: ConfigRow): boolean {
    return (row.defaultValue ?? '').trim().length === 0;
  }

  /** Extra `<option>` for boolean Value when JSON import left an invalid value. */
  valueColumnBooleanShowsInvalidOption(row: ConfigRow): boolean {
    if (!this.isValueColumnBooleanType(row)) {
      return false;
    }
    if (!(row.configImportError ?? '').trim()) {
      return false;
    }
    const t = (row.value ?? '').trim().toLowerCase();
    return t !== '' && t !== 'true' && t !== 'false';
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
    const hadImportError = (row.configImportError ?? '').trim().length > 0;
    row.value = next;
    if (this.jsonImportValueIsValid(row, next)) {
      row.configImportError = '';
      if (hadImportError) {
        row.valueImportResolvedHighlight = true;
      }
    } else {
      row.valueImportResolvedHighlight = false;
      row.configImportError = next.trim().length > 0 ? next : 'invalid';
    }
    this.valueColumnMultiModelCache.set(row.rowKey, { value: next, selected: picked });
    this.safeMarkForCheck();
  }

  onValueColumnSelectChange(row: ConfigRow, newValue: string): void {
    const hadImportError = (row.configImportError ?? '').trim().length > 0;
    row.value = newValue;
    if (this.jsonImportValueIsValid(row, newValue)) {
      row.configImportError = '';
      if (hadImportError) {
        row.valueImportResolvedHighlight = true;
      }
    } else {
      row.valueImportResolvedHighlight = false;
      row.configImportError = newValue.trim().length > 0 ? newValue : 'invalid';
    }
    this.valueColumnMultiModelCache.delete(row.rowKey);
    this.safeMarkForCheck();
  }

  onValueColumnFreeTextChange(row: ConfigRow, newValue: string): void {
    const hadImportError = (row.configImportError ?? '').trim().length > 0;
    row.value = newValue;
    if (this.jsonImportValueIsValid(row, newValue)) {
      row.configImportError = '';
      if (hadImportError) {
        row.valueImportResolvedHighlight = true;
      }
    } else {
      row.valueImportResolvedHighlight = false;
      if (hadImportError) {
        row.configImportError = newValue;
      }
    }
    this.valueColumnMultiModelCache.delete(row.rowKey);
    this.safeMarkForCheck();
  }

  /** Import / validity border: red (invalid), blue when resolved but still off default, or neutral. */
  valueColumnImportBorderState(row: ConfigRow): 'invalid' | 'resolved' | null {
    const raw = row.value ?? '';
    if ((row.configImportError ?? '').trim().length > 0 || !this.jsonImportValueIsValid(row, raw)) {
      return 'invalid';
    }
    if (row.valueImportResolvedHighlight && this.jsonImportValueIsValid(row, raw)) {
      return 'resolved';
    }
    return null;
  }

  onResetValueToDefault(event: MouseEvent, row: ConfigRow): void {
    event.stopPropagation();
    event.preventDefault();
    if (!this.valueColumnDiffersFromDefault(row)) {
      return;
    }
    this.resetRowValueToDefaultFields(row);
    this.safeMarkForCheck();
  }

  onResetAllValuesToDefault(event: MouseEvent): void {
    event.stopPropagation();
    event.preventDefault();
    let changed = false;
    for (const row of this.rows) {
      if (this.valueColumnDiffersFromDefault(row)) {
        this.resetRowValueToDefaultFields(row);
        changed = true;
      }
    }
    if (changed) {
      this.safeMarkForCheck();
    }
  }

  private resetRowValueToDefaultFields(row: ConfigRow): void {
    row.value = row.defaultValue ?? '';
    row.configImportError = '';
    row.valueImportResolvedHighlight = false;
    this.valueColumnMultiModelCache.delete(row.rowKey);
  }

  onValueCellControlClick(event: MouseEvent): void {
    event.stopPropagation();
  }

  /** Matches `[maxSelectedLabels]` on Value column multiselect — switch to summary label when exceeded. */
  readonly valueColumnMultiMaxSummaryLabels = 2;

  /** Source string for filter highlights in native Value selects (stored value matches display tokens). */
  valueColumnNativeSelectHighlightSource(row: ConfigRow): string {
    return row.value ?? '';
  }

  valueColumnMultiselectUseSummaryLabel(row: ConfigRow): boolean {
    return this.getValueColumnMultiModel(row).length > this.valueColumnMultiMaxSummaryLabels;
  }

  valueColumnMultiselectSummaryLabel(row: ConfigRow): string {
    const n = this.getValueColumnMultiModel(row).length;
    return `${n} selected`;
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
    return (raw ?? '').length > 0;
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

  getHighlightedParts(value = '', columnKey?: string): HighlightPart[] {
    const source = value;
    if (!source) {
      return [{ text: '', kind: 'none' }];
    }

    const globalRegex =
      this.globalFilterMode === 'regex'
        ? this.tryParseRegexInput(this.globalFilter, {
            matchCase: this.globalFilterMatchCase,
            wholeWord: this.globalFilterWholeWord
          })
        : null;
    let globalExprHighlightTokens: string[] = [];
    if (this.globalFilterMode === 'expr' && this.globalFilter.trim()) {
      const gpr = parseFilterExpression(this.globalFilter);
      if (gpr.ok) {
        globalExprHighlightTokens = collectHighlightOperands(gpr.ast);
      }
    }

    let columnTokens: string[] = [];
    const columnRegex =
      columnKey &&
      this.columns.some((column) => column.key === columnKey && column.filterType === 'text') &&
      this.getTextMode(columnKey) === 'regex'
        ? this.tryParseRegexInput(this.textFilters[columnKey] ?? '', {
            matchCase: this.getTextFilterMatchCase(columnKey),
            wholeWord: this.getTextFilterWholeWord(columnKey)
          })
        : null;

    if (
      columnKey &&
      this.columns.some((column) => column.key === columnKey && column.filterType === 'text') &&
      this.getTextMode(columnKey) === 'expr'
    ) {
      const cpr = parseFilterExpression(this.textFilters[columnKey] ?? '');
      if (cpr.ok) {
        columnTokens = collectHighlightOperands(cpr.ast);
      }
    }

    if (
      globalExprHighlightTokens.length === 0 &&
      columnTokens.length === 0 &&
      !globalRegex &&
      !columnRegex
    ) {
      return [{ text: source, kind: 'none' }];
    }

    const sourceLower = source.toLowerCase();
    const levels = new Array<number>(source.length).fill(0);

    this.applyTokenHighlights(source, sourceLower, globalExprHighlightTokens, globalRegex, levels, 1, {
      matchCase: this.globalFilterMatchCase,
      wholeWord: this.globalFilterWholeWord
    });
    this.applyTokenHighlights(source, sourceLower, columnTokens, columnRegex, levels, 2, {
      matchCase: columnKey ? this.getTextFilterMatchCase(columnKey) : false,
      wholeWord: columnKey ? this.getTextFilterWholeWord(columnKey) : false
    });

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
    level: number,
    tokenOpts?: { matchCase: boolean; wholeWord: boolean }
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

    const opts = tokenOpts ?? { matchCase: false, wholeWord: false };

    for (const token of tokens) {
      if (!token) {
        continue;
      }
      if (isFilterExprNullOperand(token)) {
        continue;
      }
      if (!opts.wholeWord && !opts.matchCase) {
        const tl = token.toLowerCase();
        let cursor = 0;
        while (cursor < sourceLower.length) {
          const matchIndex = sourceLower.indexOf(tl, cursor);
          if (matchIndex < 0) {
            break;
          }
          const matchEnd = matchIndex + token.length;
          for (let index = matchIndex; index < matchEnd && index < levels.length; index += 1) {
            levels[index] = Math.max(levels[index], level);
          }
          cursor = matchIndex + 1;
        }
      } else if (!opts.wholeWord && opts.matchCase) {
        let cursor = 0;
        while (cursor < source.length) {
          const matchIndex = source.indexOf(token, cursor);
          if (matchIndex < 0) {
            break;
          }
          const matchEnd = matchIndex + token.length;
          for (let index = matchIndex; index < matchEnd && index < levels.length; index += 1) {
            levels[index] = Math.max(levels[index], level);
          }
          cursor = matchIndex + 1;
        }
      } else {
        try {
          const inner = this.escapeRegExp(token);
          const flags = opts.matchCase ? 'g' : 'gi';
          const re = new RegExp(`\\b${inner}\\b`, flags);
          let m: RegExpExecArray | null;
          while ((m = re.exec(source)) !== null) {
            const start = m.index;
            const len = m[0]?.length ?? 0;
            const end = start + len;
            if (len === 0) {
              re.lastIndex += 1;
              continue;
            }
            for (let index = start; index < end && index < levels.length; index += 1) {
              levels[index] = Math.max(levels[index], level);
            }
          }
        } catch {
          /* ignore invalid token for highlight */
        }
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

  valueCellCopyId(row: ConfigRow): string {
    return `value:${row.rowKey}`;
  }

  async onCopyRowValue(event: MouseEvent, row: ConfigRow): Promise<void> {
    event.stopPropagation();
    event.preventDefault();
    await this.copyById(this.valueCellCopyId(row), row.value ?? '');
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

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Expression-mode atom: substring or whole-word match; case depends on `matchCase`.
   */
  private textFilterAtomMatches(
    hayRaw: string,
    operand: string,
    opts: { matchCase: boolean; wholeWord: boolean }
  ): boolean {
    const exact = operand.endsWith('!');
    const op = exact ? operand.slice(0, -1) : operand;

    if (isFilterExprNullOperand(op)) {
      return hayRaw.trim().length === 0;
    }
    const hay = hayRaw.trim();
    if (!op) {
      return false;
    }

    if (exact) {
      return opts.matchCase ? hay === op : hay.toLowerCase() === op.toLowerCase();
    }

    const { matchCase, wholeWord } = opts;
    if (!wholeWord) {
      if (!matchCase) {
        return hay.toLowerCase().includes(op.toLowerCase());
      }
      return hay.includes(op);
    }
    try {
      const inner = this.escapeRegExp(op);
      const flags = matchCase ? '' : 'i';
      return new RegExp(`\\b${inner}\\b`, flags).test(hay);
    } catch {
      return false;
    }
  }

  private tryParseRegexInput(
    input: string,
    options?: { matchCase?: boolean; wholeWord?: boolean }
  ): RegExp | null {
    const matchCase = !!options?.matchCase;
    const wholeWord = !!options?.wholeWord;
    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }

    let base: RegExp | null = null;

    if (trimmed.startsWith('/')) {
      const lastSlash = trimmed.lastIndexOf('/');
      if (lastSlash > 0) {
        const pattern = trimmed.slice(1, lastSlash);
        const flags = trimmed.slice(lastSlash + 1);
        if (/^[dgimsuy]*$/.test(flags)) {
          try {
            base = new RegExp(pattern, flags);
          } catch {
            return null;
          }
        }
      }
      if (!base) {
        return null;
      }
    } else {
      try {
        const flags = matchCase ? '' : 'i';
        base = new RegExp(trimmed, flags);
      } catch {
        return null;
      }
    }

    if (!wholeWord) {
      return base;
    }
    try {
      const flagsNoG = base.flags.replaceAll('g', '');
      return new RegExp(`\\b(?:${base.source})\\b`, flagsNoG);
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

  private closeExportMenu(): void {
    this.exportFormatMenuOpen = false;
    this.exportToFileSubmenuOpen = false;
  }

  private closeImportMenu(): void {
    this.importConfigMenuOpen = false;
  }

  private closeTableSettingsMenu(): void {
    this.tableSettingsMenuOpen = false;
  }

  /**
   * Close toolbar menus while optionally keeping one open.
   * Passing no argument closes every toolbar menu.
   */
  private closeToolbarMenus(except?: 'export' | 'import' | 'settings'): void {
    if (except !== 'export') {
      this.closeExportMenu();
    }
    if (except !== 'import') {
      this.closeImportMenu();
    }
    if (except !== 'settings') {
      this.closeTableSettingsMenu();
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClickCloseExportMenu(event: MouseEvent): void {
    const t = event.target;
    let changed = false;
    if (this.exportFormatMenuOpen) {
      const host = this.exportFormatMenuHost?.nativeElement;
      if (!host || !(t instanceof Node) || !host.contains(t)) {
        this.closeExportMenu();
        changed = true;
      }
    }
    if (this.importConfigMenuOpen) {
      const host = this.importConfigMenuHost?.nativeElement;
      if (!host || !(t instanceof Node) || !host.contains(t)) {
        this.closeImportMenu();
        changed = true;
      }
    }
    if (this.tableSettingsMenuOpen) {
      const host = this.tableSettingsMenuHost?.nativeElement;
      if (!host || !(t instanceof Node) || !host.contains(t)) {
        this.closeTableSettingsMenu();
        changed = true;
      }
    }
    if (changed) {
      this.safeMarkForCheck();
    }
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && (this.exportFormatMenuOpen || this.importConfigMenuOpen || this.tableSettingsMenuOpen)) {
      event.preventDefault();
      this.closeToolbarMenus();
      this.safeMarkForCheck();
      return;
    }

    if (event.key === 'Escape' && this.importMissingKeysDialogVisible) {
      event.preventDefault();
      this.closeImportMissingKeysDialog();
      return;
    }

    this.tryOpenCellCmdPreviewFromKeyboard(event);

    if (event.key === 'Shift' || event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      this.matchInspectorShiftFromKeyboard = true;
      this.tryOpenMatchInspectorFromPointerContext();
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        const t = event.target as HTMLElement | null;
        if (!t || !this.shouldDeferTablePageKeys(t)) {
          const dir: -1 | 1 = event.key === 'ArrowLeft' ? -1 : 1;
          if (this.tryStepTablePage(dir)) {
            event.preventDefault();
            this.safeMarkForCheck();
          }
        }
      }
      return;
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
    if (!event.metaKey && !event.ctrlKey && this.cellCmdPreviewOpen) {
      this.closeCellCmdPreview();
    }
  }

  @HostListener('window:blur')
  onWindowBlurClearShiftTrack(): void {
    this.matchInspectorShiftFromKeyboard = false;
    this.closeCellCmdPreview();
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

  private readRawTableSettings(): string | null {
    return localStorage.getItem(this.settingsStorageKey);
  }

  private restoreSettings(): void {
    try {
      const raw = this.readRawTableSettings();
      if (!raw) {
        this.columnOrderKeys = this.columns.map((column) => column.key);
        this.visibleColumnKeys = this.ensurePropertyVisible([...this.columnOrderKeys]);
        return;
      }

      const parsed = JSON.parse(raw) as TableSettings;
      this.globalFilter = parsed.globalFilter ?? '';
      this.globalFilterMode =
        parsed.globalFilterMode === 'regex' ? 'regex' : 'expr';
      this.globalFilterScope = parsed.globalFilterScope === 'all' ? 'all' : 'visible';
      this.globalFilterMatchCase = !!parsed.globalFilterMatchCase;
      this.globalFilterWholeWord = !!parsed.globalFilterWholeWord;
      this.textFilters = parsed.textFilters ?? {};
      this.textModes = Object.entries(parsed.textModes ?? {}).reduce(
        (acc, [key, mode]) => {
          acc[key] = mode === 'regex' ? 'regex' : 'expr';
          return acc;
        },
        {} as Partial<Record<string, TextMatchMode>>
      );
      this.textFilterMatchCase = Object.entries(parsed.textFilterMatchCase ?? {}).reduce(
        (acc, [key, v]) => {
          if (v) {
            acc[key] = true;
          }
          return acc;
        },
        {} as Partial<Record<string, boolean>>
      );
      this.textFilterWholeWord = Object.entries(parsed.textFilterWholeWord ?? {}).reduce(
        (acc, [key, v]) => {
          if (v) {
            acc[key] = true;
          }
          return acc;
        },
        {} as Partial<Record<string, boolean>>
      );
      this.valueFilters = parsed.valueFilters ?? {};
      this.listFilterTextOverrides = new Set(
        Array.isArray(parsed.listFilterTextOverrides) ? parsed.listFilterTextOverrides : []
      );
      this.listModes = {
        allowedScopes: parsed.listModes?.allowedScopes === 'and' ? 'and' : 'or',
        editableBy: parsed.listModes?.editableBy === 'and' ? 'and' : 'or'
      };
      this.columnOrderKeys = this.normalizeColumnOrderKeys(parsed.columnOrderKeys);

      const validColumns = (parsed.visibleColumnKeys ?? []).filter((key: string) =>
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
      this.visibleColumnKeys = this.ensurePropertyVisible([...this.columnOrderKeys]);
    }
  }

  private persistSettings(): void {
    const settings: TableSettings = {
      globalFilter: this.globalFilter,
      globalFilterScope: this.globalFilterScope,
      globalFilterMatchCase: this.globalFilterMatchCase || undefined,
      globalFilterWholeWord: this.globalFilterWholeWord || undefined,
      textFilters: this.textFilters,
      globalFilterMode: this.globalFilterMode,
      textModes: this.textModes,
      textFilterMatchCase:
        Object.keys(this.textFilterMatchCase).length > 0 ? this.textFilterMatchCase : undefined,
      textFilterWholeWord:
        Object.keys(this.textFilterWholeWord).length > 0 ? this.textFilterWholeWord : undefined,
      valueFilters: this.valueFilters,
      listFilterTextOverrides: this.listFilterTextOverrides.size > 0 ? [...this.listFilterTextOverrides] : undefined,
      listModes: this.listModes,
      visibleColumnKeys: this.visibleColumnKeys,
      columnOrderKeys: this.columnOrderKeys
    };

    try {
      localStorage.setItem(this.settingsStorageKey, JSON.stringify(settings));
    } catch {
      /* ignore quota / private mode */
    }
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

}

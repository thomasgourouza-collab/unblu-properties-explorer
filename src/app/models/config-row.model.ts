export type ConfigColumnKey =
  | 'category'
  | 'propertyTitle'
  | 'property'
  | 'source'
  | 'defaultValue'
  | 'value'
  | 'type'
  | 'allowedValues'
  | 'allowedScopes'
  | 'visibility'
  | 'editableBy'
  | 'description';

/** Prefix for dynamic CSV columns that do not map to ConfigColumnKey. */
export const EXTRA_COLUMN_PREFIX = 'extra:' as const;

export type FilterMode = 'or' | 'and';

export interface ConfigRow {
  category: string;
  propertyTitle: string;
  property: string;
  /** Originating CSV filename for merged uploads. */
  source: string;
  /** Stable unique id for selection / export when the same property appears in multiple rows. */
  rowKey: string;
  defaultValue: string;
  /** Synthetic UI column; not loaded from CSV. */
  value: string;
  type: string;
  allowedValues: string;
  allowedScopes: string;
  visibility: string;
  editableBy: string;
  description: string;
  allowedScopesTokens: string[];
  editableByTokens: string[];
  hasAllowedValuesColumn: boolean;
  /** Unmapped CSV headers → values; keys are `${EXTRA_COLUMN_PREFIX}${trimmedHeader}`. */
  extra: Record<string, string>;
}

export interface ColumnDefinition {
  key: string;
  label: string;
  filterType: 'text' | 'select' | 'list';
}

export interface CsvParseResult {
  rows: ConfigRow[];
  warnings: string[];
}

/** Single-file parse before merge (includes extra column order). */
export interface CsvParseFileResult {
  rows: ConfigRow[];
  warnings: string[];
  /** Ordered unmapped header names (no prefix). */
  extraHeaderKeys: string[];
}

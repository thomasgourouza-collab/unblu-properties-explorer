export type ConfigColumnKey =
  | 'category'
  | 'propertyTitle'
  | 'property'
  | 'defaultValue'
  | 'type'
  | 'allowedValues'
  | 'allowedScopes'
  | 'visibility'
  | 'editableBy'
  | 'description';

export type FilterMode = 'or' | 'and';

export interface ConfigRow {
  category: string;
  propertyTitle: string;
  property: string;
  defaultValue: string;
  type: string;
  allowedValues: string;
  allowedScopes: string;
  visibility: string;
  editableBy: string;
  description: string;
  allowedScopesTokens: string[];
  editableByTokens: string[];
  hasAllowedValuesColumn: boolean;
}

export interface ColumnDefinition {
  key: ConfigColumnKey;
  label: string;
  filterType: 'text' | 'select' | 'list';
}

export interface CsvParseResult {
  rows: ConfigRow[];
  warnings: string[];
}

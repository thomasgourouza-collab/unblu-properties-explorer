export type PropertyStatus = 'Preview' | 'Stable' | 'Deprecated';

export interface ScrapedPropertyRow {
  groupTitle: string;
  label: string;
  key: string;
  defaultValue: string;
  type: string;
  allowedValues: string;
  allowedScopes: string;
  visibility: string;
  editableBy: string;
  description: string;
  status: PropertyStatus;
  dependsOn: string[];
  source: 'configuration-properties' | 'text-properties';
  hasAllowedValuesColumn: boolean;
}

export interface ConfigRowApi {
  category: string;
  propertyTitle: string;
  property: string;
  source: string;
  rowKey: string;
  defaultValue: string;
  value: string;
  configImportError: string;
  valueImportResolvedHighlight: boolean;
  type: string;
  allowedValues: string;
  allowedScopes: string;
  visibility: string;
  editableBy: string;
  description: string;
  status: PropertyStatus;
  dependsOn: string[];
  allowedScopesTokens: string[];
  editableByTokens: string[];
  hasAllowedValuesColumn: boolean;
  extra: Record<string, string>;
}

export interface PropertiesSnapshot {
  rows: ConfigRowApi[];
  warnings: string[];
  metadata: {
    scrapedAt: string;
  };
}

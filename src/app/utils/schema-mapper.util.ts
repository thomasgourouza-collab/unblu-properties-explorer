import { ConfigRow, PropertyStatus } from '../models/config-row.model';

export interface SchemaMapResult {
  rows: ConfigRow[];
  warnings: string[];
  productVersion: string;
}

const STATUS_MAP: Record<string, PropertyStatus> = {
  STABLE: 'Stable',
  PREVIEW: 'Preview',
  DEPRECATED: 'Deprecated'
};

/** Loose shape check: is the value plausibly a parsed mergedConfigurationSchema JSON? */
export function isMergedConfigurationSchema(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  if (value['cls'] !== 'IConfigurationSchema') {
    return false;
  }
  return Array.isArray(value['children']);
}

export function mapSchemaToRows(schema: unknown): SchemaMapResult {
  const rows: ConfigRow[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(schema)) {
    return { rows, warnings: ['Schema root is not a JSON object.'], productVersion: '' };
  }

  const productVersion = asString(schema['productVersion']);

  if (!isMergedConfigurationSchema(schema)) {
    warnings.push('Schema root is missing cls = "IConfigurationSchema" or has no children array.');
  }

  const rootChildren = Array.isArray(schema['children']) ? schema['children'] : [];
  for (const child of rootChildren) {
    walk(child, '', rows, warnings);
  }

  return { rows, warnings, productVersion };
}

function walk(
  node: unknown,
  inheritedCategory: string,
  rows: ConfigRow[],
  warnings: string[]
): void {
  if (!isPlainObject(node)) {
    warnings.push('Encountered a non-object child in schema tree.');
    return;
  }

  const cls = asString(node['cls']);

  if (cls === 'IConfigurationGroup') {
    const label = asString(node['label']);
    const key = asString(node['key']);
    const nextCategory = label || inheritedCategory || key;
    const children = Array.isArray(node['children']) ? node['children'] : [];
    for (const child of children) {
      walk(child, nextCategory, rows, warnings);
    }
    return;
  }

  if (cls === 'IConfigurationProperty' || cls === 'ITextProperty') {
    const row = mapPropertyNode(node, cls, inheritedCategory, rows.length);
    if (row) {
      rows.push(row);
    }
    return;
  }

  warnings.push(`Unknown cls "${cls}" encountered; node skipped.`);
}

function mapPropertyNode(
  node: Record<string, unknown>,
  cls: 'IConfigurationProperty' | 'ITextProperty',
  category: string,
  index: number
): ConfigRow | null {
  const key = asString(node['key']);
  if (!key) {
    return null;
  }

  const isText = cls === 'ITextProperty';
  const sourceLabel = isText ? 'Text' : 'Configuration';

  const defaultValue = coerceToDisplayString(isText ? node['fallback'] : node['defaultValue']);

  const label = asString(node['label']);
  const propertyTitle = label.trim() ? label : lastSegment(key);

  const rawType = asString(node['type']);
  const isList = node['isList'] === true;
  const type = isList && rawType ? `List of ${rawType}` : rawType;

  const allowedValuesArr = Array.isArray(node['enumArguments']) ? node['enumArguments'] : [];
  const allowedValues = allowedValuesArr.map((value) => String(value).toUpperCase()).join(', ');

  const allowedScopesTokens = Array.isArray(node['allowedScopes'])
    ? node['allowedScopes'].filter(isString)
    : [];
  const allowedScopes = allowedScopesTokens.join(', ');

  const minimumRole = asString(node['minimumRole']);
  const editableByTokens = minimumRole ? [minimumRole] : [];

  const dependsOn = Array.isArray(node['dependsOn']) ? node['dependsOn'].filter(isString) : [];

  const status: PropertyStatus = STATUS_MAP[asString(node['status'])] ?? 'Stable';

  return {
    category,
    propertyTitle,
    property: key,
    source: sourceLabel,
    rowKey: `${sourceLabel}::${key}::${index}`,
    defaultValue,
    value: defaultValue,
    configImportError: '',
    valueImportResolvedHighlight: false,
    type,
    allowedValues,
    allowedScopes,
    visibility: asString(node['visibility']),
    editableBy: minimumRole,
    description: asString(node['description']),
    status,
    dependsOn,
    allowedScopesTokens,
    editableByTokens,
    hasAllowedValuesColumn: allowedValuesArr.length > 0,
    extra: {}
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function coerceToDisplayString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function lastSegment(key: string): string {
  const idx = key.lastIndexOf('.');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

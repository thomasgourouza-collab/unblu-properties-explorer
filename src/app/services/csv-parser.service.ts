import { Injectable } from '@angular/core';
import Papa from 'papaparse';

import {
  ConfigRow,
  CsvParseFileResult,
  CsvParseResult,
  EXTRA_COLUMN_PREFIX,
  PROPERTY_STATUS_OPTIONS,
  PropertyStatus
} from '../models/config-row.model';

type RawCsvRow = Record<string, string | undefined>;
type CsvMappedKey = keyof Omit<
  ConfigRow,
  | 'allowedScopesTokens'
  | 'editableByTokens'
  | 'hasAllowedValuesColumn'
  | 'source'
  | 'rowKey'
  | 'extra'
  | 'value'
  | 'configImportError'
  | 'valueImportResolvedHighlight'
  | 'dependsOn'
  | 'status'
>;

export interface ParseFileSource {
  /** Shown in the Source column (e.g. filename). */
  displayLabel: string;
  /** Disambiguates rowKey across slots (e.g. slot1 vs slot2). */
  rowKeyPrefix: string;
}

@Injectable({
  providedIn: 'root'
})
export class CsvParserService {
  private readonly headerKeyMap: Record<string, CsvMappedKey> = {
    grouptitle: 'category',
    label: 'propertyTitle',
    key: 'property',
    defaultvalue: 'defaultValue',
    type: 'type',
    allowedvalues: 'allowedValues',
    allowedscopes: 'allowedScopes',
    visibility: 'visibility',
    editableby: 'editableBy',
    description: 'description'
  };

  private readonly statusHeaderAliases = ['status', 'stability'];
  private readonly dependsOnHeaderAliases = ['dependson', 'dependencies', 'depends'];

  /** Maps internal required-header keys to the CSV column names shown in error messages. */
  private readonly headerDisplayNames: Partial<Record<string, string>> = {
    category: 'group title',
    propertyTitle: 'label',
    property: 'key',
    defaultValue: 'default value',
    type: 'type',
    allowedValues: 'allowed values',
    allowedScopes: 'allowed scopes',
    visibility: 'visibility',
    editableBy: 'editable by',
    description: 'description'
  };

  /** @deprecated Use parseFile + mergeParsedFiles for dual uploads. */
  parse(file: File): Promise<CsvParseResult> {
    return this.parseFile(file, {
      displayLabel: file.name,
      rowKeyPrefix: 'single'
    }).then((r) => ({
      rows: r.rows,
      warnings: r.warnings
    }));
  }

  parseFile(file: File, source: ParseFileSource): Promise<CsvParseFileResult> {
    return new Promise((resolve, reject) => {
      Papa.parse<RawCsvRow>(file, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => header.trim(),
        complete: ({ data, errors, meta }) => {
          const warnings = errors.map((error) => `Line ${error.row}: ${error.message}`);
          const { headerMap, extraHeadersOrdered, statusHeader, dependsOnHeader } = this.classifyHeaders(meta.fields ?? []);
          const missingHeaders = this.getMissingHeaders(headerMap);

          if (missingHeaders.length > 0) {
            const displayNames = missingHeaders.map(
              (h) => this.headerDisplayNames[h] ?? h
            );
            reject(
              new Error(
                `Missing required columns: ${displayNames.join(', ')}.`
              )
            );
            return;
          }

          const rows: ConfigRow[] = [];
          let rowIndex = 0;
          for (const row of data) {
            const mapped = this.mapRow(
              row,
              { headerMap, extraHeadersOrdered, statusHeader, dependsOnHeader },
              source.displayLabel,
              source.rowKeyPrefix,
              rowIndex
            );
            if (!this.rowHasMeaningfulContent(mapped)) {
              continue;
            }
            rows.push(mapped);
            rowIndex += 1;
          }

          resolve({
            rows,
            warnings,
            extraHeaderKeys: extraHeadersOrdered
          });
        },
        error: (error) => reject(error)
      });
    });
  }

  mergeParsedFiles(
    file1: CsvParseFileResult | null,
    file2: CsvParseFileResult | null
  ): CsvParseResult {
    if (!file1 && !file2) {
      return { rows: [], warnings: [] };
    }

    const extraUnion = this.mergeExtraHeaderOrder(
      file1?.extraHeaderKeys ?? [],
      file2?.extraHeaderKeys ?? []
    );
    const allExtraColumnKeys = extraUnion.map((h) => `${EXTRA_COLUMN_PREFIX}${h}`);

    const rows1 = file1 ? this.normalizeRowsExtra(file1.rows, allExtraColumnKeys) : [];
    const rows2 = file2 ? this.normalizeRowsExtra(file2.rows, allExtraColumnKeys) : [];

    return {
      rows: [...rows1, ...rows2],
      warnings: [...(file1?.warnings ?? []), ...(file2?.warnings ?? [])]
    };
  }

  private mergeExtraHeaderOrder(first: string[], second: string[]): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const h of first) {
      if (!seen.has(h)) {
        seen.add(h);
        order.push(h);
      }
    }
    for (const h of second) {
      if (!seen.has(h)) {
        seen.add(h);
        order.push(h);
      }
    }
    return order;
  }

  private normalizeRowsExtra(rows: ConfigRow[], allExtraColumnKeys: string[]): ConfigRow[] {
    return rows.map((row) => {
      const nextExtra: Record<string, string> = {};
      for (const k of allExtraColumnKeys) {
        nextExtra[k] = row.extra[k] ?? '';
      }
      return { ...row, extra: nextExtra };
    });
  }

  private classifyHeaders(headers: string[]): {
    headerMap: Map<CsvMappedKey, string>;
    extraHeadersOrdered: string[];
    statusHeader: string | null;
    dependsOnHeader: string | null;
  } {
    const headerMap = new Map<CsvMappedKey, string>();
    const extraHeadersOrdered: string[] = [];
    const seenExtra = new Set<string>();
    let statusHeader: string | null = null;
    let dependsOnHeader: string | null = null;

    for (const header of headers) {
      const normalizedHeader = this.normalizeHeader(header);
      const mappedKey = this.headerKeyMap[normalizedHeader];

      if (mappedKey && !headerMap.has(mappedKey)) {
        headerMap.set(mappedKey, header);
        continue;
      }
      if (!statusHeader && this.statusHeaderAliases.includes(normalizedHeader)) {
        statusHeader = header;
        continue;
      }
      if (!dependsOnHeader && this.dependsOnHeaderAliases.includes(normalizedHeader)) {
        dependsOnHeader = header;
        continue;
      }
      if (header.length > 0 && !seenExtra.has(header)) {
        seenExtra.add(header);
        extraHeadersOrdered.push(header);
      }
    }

    return { headerMap, extraHeadersOrdered, statusHeader, dependsOnHeader };
  }

  private getMissingHeaders(headerMap: Map<CsvMappedKey, string>): string[] {
    const requiredHeaders: CsvMappedKey[] = [
      'category',
      'propertyTitle',
      'property',
      'defaultValue',
      'type',
      'allowedScopes',
      'visibility',
      'editableBy',
      'description'
    ];

    return requiredHeaders.filter((header) => !headerMap.has(header));
  }

  private mapRow(
    row: RawCsvRow,
    classification: {
      headerMap: Map<CsvMappedKey, string>;
      extraHeadersOrdered: string[];
      statusHeader: string | null;
      dependsOnHeader: string | null;
    },
    sourceLabel: string,
    rowKeyPrefix: string,
    rowIndex: number
  ): ConfigRow {
    const { headerMap, extraHeadersOrdered, statusHeader, dependsOnHeader } = classification;
    const getValue = (key: CsvMappedKey): string => {
      const header = headerMap.get(key);
      if (!header) {
        return '';
      }

      return (row[header] ?? '').trim();
    };

    const allowedScopes = getValue('allowedScopes');
    const editableBy = getValue('editableBy');
    const hasAllowedValuesColumn = headerMap.has('allowedValues');

    const extra: Record<string, string> = {};
    for (const header of extraHeadersOrdered) {
      const colKey = `${EXTRA_COLUMN_PREFIX}${header}`;
      extra[colKey] = (row[header] ?? '').trim();
    }

    const defaultValue = getValue('defaultValue');
    const statusRaw = statusHeader ? (row[statusHeader] ?? '').trim() : '';
    const dependsOnRaw = dependsOnHeader ? (row[dependsOnHeader] ?? '').trim() : '';

    return {
      category: getValue('category'),
      propertyTitle: getValue('propertyTitle'),
      property: getValue('property'),
      source: this.stripCsvExtensionForDisplay(sourceLabel),
      rowKey: `${rowKeyPrefix}::${rowIndex}`,
      defaultValue,
      value: defaultValue,
      configImportError: '',
      valueImportResolvedHighlight: false,
      type: getValue('type'),
      allowedValues: hasAllowedValuesColumn ? getValue('allowedValues') : '',
      allowedScopes,
      visibility: getValue('visibility'),
      editableBy,
      description: getValue('description'),
      status: this.normalizeStatus(statusRaw),
      dependsOn: this.tokenizeCommaSeparatedValues(dependsOnRaw).filter((k) => k.startsWith('com.unblu.')),
      allowedScopesTokens: this.tokenizeCommaSeparatedValues(allowedScopes),
      editableByTokens: this.tokenizeCommaSeparatedValues(editableBy),
      hasAllowedValuesColumn,
      extra
    };
  }

  private normalizeStatus(raw: string): PropertyStatus {
    const normalized = raw.trim().toLowerCase();
    const match = PROPERTY_STATUS_OPTIONS.find((option) => option.toLowerCase() === normalized);
    return match ?? 'Stable';
  }

  private tokenizeCommaSeparatedValues(input: string): string[] {
    return input
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  private normalizeHeader(header: string): string {
    return header
      .toLowerCase()
      .replaceAll(/[^a-z0-9]/g, '');
  }

  /** Filename without trailing `.csv` for the Source column (case-insensitive). */
  private stripCsvExtensionForDisplay(filename: string): string {
    return filename.replace(/\.csv$/i, '');
  }

  /** Ignore synthetic fields (source, rowKey) so blank CSV lines are still dropped. */
  private rowHasMeaningfulContent(row: ConfigRow): boolean {
    const core: string[] = [
      row.category,
      row.propertyTitle,
      row.property,
      row.defaultValue,
      row.type,
      row.allowedValues,
      row.allowedScopes,
      row.visibility,
      row.editableBy,
      row.description
    ];
    if (core.some((value) => value.trim() !== '')) {
      return true;
    }
    return Object.values(row.extra).some((value) => value.trim() !== '');
  }
}


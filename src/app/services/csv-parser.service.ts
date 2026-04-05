import { Injectable } from '@angular/core';
import Papa from 'papaparse';

import {
  ConfigRow,
  CsvParseFileResult,
  CsvParseResult,
  EXTRA_COLUMN_PREFIX
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
    category: 'category',
    propertytitle: 'propertyTitle',
    property: 'property',
    defaultvalue: 'defaultValue',
    type: 'type',
    allowedvalues: 'allowedValues',
    allowedscopes: 'allowedScopes',
    visibility: 'visibility',
    editableby: 'editableBy',
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
          const { headerMap, extraHeadersOrdered } = this.classifyHeaders(meta.fields ?? []);
          const missingHeaders = this.getMissingHeaders(headerMap);

          if (missingHeaders.length > 0) {
            reject(
              new Error(
                `Missing required columns: ${missingHeaders.join(', ')}.`
              )
            );
            return;
          }

          const rows: ConfigRow[] = [];
          let rowIndex = 0;
          for (const row of data) {
            const mapped = this.mapRow(
              row,
              headerMap,
              extraHeadersOrdered,
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
  } {
    const headerMap = new Map<CsvMappedKey, string>();
    const extraHeadersOrdered: string[] = [];
    const seenExtra = new Set<string>();

    for (const header of headers) {
      const normalizedHeader = this.normalizeHeader(header);
      const mappedKey = this.headerKeyMap[normalizedHeader];

      if (mappedKey && !headerMap.has(mappedKey)) {
        headerMap.set(mappedKey, header);
      } else if (!mappedKey && header.length > 0) {
        if (!seenExtra.has(header)) {
          seenExtra.add(header);
          extraHeadersOrdered.push(header);
        }
      }
    }

    return { headerMap, extraHeadersOrdered };
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
    headerMap: Map<CsvMappedKey, string>,
    extraHeadersOrdered: string[],
    sourceLabel: string,
    rowKeyPrefix: string,
    rowIndex: number
  ): ConfigRow {
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

    return {
      category: getValue('category'),
      propertyTitle: getValue('propertyTitle'),
      property: getValue('property'),
      source: sourceLabel,
      rowKey: `${rowKeyPrefix}::${rowIndex}`,
      defaultValue: getValue('defaultValue'),
      type: getValue('type'),
      allowedValues: hasAllowedValuesColumn ? getValue('allowedValues') : '',
      allowedScopes,
      visibility: getValue('visibility'),
      editableBy,
      description: getValue('description'),
      allowedScopesTokens: this.tokenizeCommaSeparatedValues(allowedScopes),
      editableByTokens: this.tokenizeCommaSeparatedValues(editableBy),
      hasAllowedValuesColumn,
      extra
    };
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


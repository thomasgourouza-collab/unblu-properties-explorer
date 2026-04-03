import { Injectable } from '@angular/core';
import Papa from 'papaparse';

import { ConfigRow, CsvParseResult } from '../models/config-row.model';

type RawCsvRow = Record<string, string | undefined>;

@Injectable({
  providedIn: 'root'
})
export class CsvParserService {
  private readonly headerKeyMap: Record<string, keyof Omit<ConfigRow, 'allowedScopesTokens' | 'editableByTokens'>> = {
    category: 'category',
    propertytitle: 'propertyTitle',
    property: 'property',
    defaultvalue: 'defaultValue',
    type: 'type',
    allowedscopes: 'allowedScopes',
    visibility: 'visibility',
    editableby: 'editableBy',
    description: 'description'
  };

  parse(file: File): Promise<CsvParseResult> {
    return new Promise((resolve, reject) => {
      Papa.parse<RawCsvRow>(file, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => header.trim(),
        complete: ({ data, errors, meta }) => {
          const warnings = errors.map((error) => `Line ${error.row}: ${error.message}`);
          const headerMap = this.buildHeaderMap(meta.fields ?? []);
          const missingHeaders = this.getMissingHeaders(headerMap);

          if (missingHeaders.length > 0) {
            reject(
              new Error(
                `Missing required columns: ${missingHeaders.join(', ')}.`
              )
            );
            return;
          }

          const rows = data
            .map((row) => this.mapRow(row, headerMap))
            .filter((row) => Object.values(row).some((value) => value !== '' && !Array.isArray(value)));

          resolve({
            rows,
            warnings
          });
        },
        error: (error) => reject(error)
      });
    });
  }

  private buildHeaderMap(headers: string[]): Map<keyof Omit<ConfigRow, 'allowedScopesTokens' | 'editableByTokens'>, string> {
    const mappedHeaders = new Map<keyof Omit<ConfigRow, 'allowedScopesTokens' | 'editableByTokens'>, string>();

    for (const header of headers) {
      const normalizedHeader = this.normalizeHeader(header);
      const mappedKey = this.headerKeyMap[normalizedHeader];

      if (mappedKey && !mappedHeaders.has(mappedKey)) {
        mappedHeaders.set(mappedKey, header);
      }
    }

    return mappedHeaders;
  }

  private getMissingHeaders(
    headerMap: Map<keyof Omit<ConfigRow, 'allowedScopesTokens' | 'editableByTokens'>, string>
  ): string[] {
    const requiredHeaders: Array<keyof Omit<ConfigRow, 'allowedScopesTokens' | 'editableByTokens'>> = [
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
    headerMap: Map<keyof Omit<ConfigRow, 'allowedScopesTokens' | 'editableByTokens'>, string>
  ): ConfigRow {
    const getValue = (key: keyof Omit<ConfigRow, 'allowedScopesTokens' | 'editableByTokens'>): string => {
      const header = headerMap.get(key);
      if (!header) {
        return '';
      }

      return (row[header] ?? '').trim();
    };

    const allowedScopes = getValue('allowedScopes');
    const editableBy = getValue('editableBy');

    return {
      category: getValue('category'),
      propertyTitle: getValue('propertyTitle'),
      property: getValue('property'),
      defaultValue: getValue('defaultValue'),
      type: getValue('type'),
      allowedScopes,
      visibility: getValue('visibility'),
      editableBy,
      description: getValue('description'),
      allowedScopesTokens: this.tokenizeCommaSeparatedValues(allowedScopes),
      editableByTokens: this.tokenizeCommaSeparatedValues(editableBy)
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
      .replace(/[^a-z0-9]/g, '');
  }
}

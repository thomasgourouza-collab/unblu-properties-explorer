import type { ConfigRow } from '../../../models/config-row.model';
import { asRecord } from './json-record.util';

export interface PatchAccountPayloadOptions {
  rows: ConfigRow[];
  selectedRowKeys: Set<string>;
  valueForRow: (row: ConfigRow) => string;
}

/**
 * Patch selected rows into account payload:
 * - source contains "configuration" => configuration[key] = value
 * - source contains "text" => text[key].en = value
 */
export function patchAccountPayloadFromSelection(
  accountPayload: Record<string, unknown>,
  options: PatchAccountPayloadOptions
): number {
  const selected = options.rows.filter((row) => options.selectedRowKeys.has(row.rowKey));
  let patched = 0;

  let configuration = asRecord(accountPayload['configuration']);
  if (!configuration) {
    configuration = {};
    accountPayload['configuration'] = configuration;
  }

  let text = asRecord(accountPayload['text']);
  if (!text) {
    text = {};
    accountPayload['text'] = text;
  }

  for (const row of selected) {
    const key = (row.property ?? '').trim();
    if (!key) {
      continue;
    }

    const value = options.valueForRow(row);
    const source = (row.source ?? '').toLowerCase();
    if (source.includes('configuration')) {
      configuration[key] = value;
      patched += 1;
    }
    if (source.includes('text')) {
      const existing = asRecord(text[key]);
      text[key] = existing ? { ...existing, en: value } : { en: value };
      patched += 1;
    }
  }

  return patched;
}

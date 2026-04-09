import { parse as parseYaml } from 'yaml';

import { parseJavaPropertiesFile } from '../../../utils/java-properties-config.util';
import { asRecord } from './json-record.util';

export type ParsedConfigFileResult = Record<string, unknown> | null | 'not-object';

/** `.properties` files -> string map as `Record<string, unknown>` for the same import pipeline. */
export function parseImportedPropertiesFileText(text: string): Record<string, unknown> | null {
  const body = text.replace(/^\uFEFF/, '').trim();
  if (!body) {
    return {};
  }
  const map = parseJavaPropertiesFile(text);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = v;
  }
  return out;
}

/**
 * Parse JSON first, then YAML. Returns a plain object record, `null` if syntax is invalid, or
 * `'not-object'` if the document root is not a non-null object (e.g. array or scalar).
 */
export function parseImportedConfigFileText(text: string): ParsedConfigFileResult {
  const body = text.replace(/^\uFEFF/, '').trim();
  if (!body) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    try {
      parsed = parseYaml(body);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'not-object';
  }
  return parsed as Record<string, unknown>;
}

export function buildConfigImportFromConnectedAccount(account: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const configuration = asRecord(account['configuration']);
  if (configuration) {
    for (const [key, value] of Object.entries(configuration)) {
      out[key] = value;
    }
  }

  const textConfig = asRecord(account['text']);
  if (textConfig) {
    for (const [key, value] of Object.entries(textConfig)) {
      const langMap = asRecord(value);
      if (!langMap || !('en' in langMap)) {
        continue;
      }
      out[key] = langMap['en'];
    }
  }

  if (Object.keys(out).length === 0) {
    throw new Error('Connected account does not contain configuration/text data in expected format.');
  }

  return out;
}

export function filterIgnoredImportKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.trim() === '$_version') {
      continue;
    }
    out[key] = value;
  }
  return out;
}

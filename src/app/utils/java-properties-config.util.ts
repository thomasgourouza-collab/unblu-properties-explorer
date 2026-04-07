/**
 * Read/write Java-style .properties lines (UTF-8): `key=value` or `key: value`,
 * with common escapes (\\, \n, \t, \r, \uXXXX). Lines starting with # or ! are comments.
 */

function indexOfUnescaped(s: string, ch: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ch) {
      continue;
    }
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) {
      backslashes++;
    }
    if (backslashes % 2 === 0) {
      return i;
    }
  }
  return -1;
}

function unescapeJavaProps(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '\\') {
      out += s[i];
      i++;
      continue;
    }
    i++;
    if (i >= s.length) {
      out += '\\';
      break;
    }
    const c = s[i++];
    switch (c) {
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'f':
        out += '\f';
        break;
      case 'u':
        if (i + 4 <= s.length) {
          const hex = s.slice(i, i + 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCodePoint(parseInt(hex, 16));
            i += 4;
            break;
          }
        }
        out += 'u';
        break;
      default:
        out += c;
    }
  }
  return out;
}

function escapeKeyPart(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/=/g, '\\=')
    .replace(/:/g, '\\:')
    .replace(/^ /, '\\ ')
    .replace(/ $/, '\\ ');
}

function escapeValuePart(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Parse one line per entry: `key=value` or `key: value` (first unescaped `=` or `:`).
 */
export function parseJavaPropertiesFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = text.replace(/^\uFEFF/, '');
  for (const phys of body.split(/\r?\n/)) {
    const line = phys;
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('!')) {
      continue;
    }
    const idxEq = indexOfUnescaped(line, '=');
    const idxCol = indexOfUnescaped(line, ':');
    let sep = -1;
    if (idxEq >= 0 && (idxCol < 0 || idxEq <= idxCol)) {
      sep = idxEq;
    } else if (idxCol >= 0) {
      sep = idxCol;
    }
    if (sep < 0) {
      const keyOnly = unescapeJavaProps(line.trim());
      if (keyOnly) {
        out[keyOnly] = '';
      }
      continue;
    }
    const keyRaw = line.slice(0, sep).trim();
    const valRaw = line.slice(sep + 1).trim();
    const key = unescapeJavaProps(keyRaw);
    if (!key) {
      continue;
    }
    out[key] = unescapeJavaProps(valRaw);
  }
  return out;
}

/** Stable `key=value` lines, keys sorted; UTF-8 safe. */
export function stringifyJavaPropertiesFile(record: Record<string, string>): string {
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
  const lines = keys.map((k) => `${escapeKeyPart(k)}=${escapeValuePart(record[k] ?? '')}`);
  return `${lines.join('\n')}\n`;
}

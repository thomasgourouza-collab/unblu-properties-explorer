export function escapeCsvField(value: string): string {
  const s = value ?? '';
  if (/[",\r\n]/.test(s)) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

export function buildSelectionExportFilename(
  extension: 'csv' | 'json' | 'yaml' | 'properties',
  now = new Date()
): string {
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  return `configuration-${day}-${month}-${year}.${extension}`;
}

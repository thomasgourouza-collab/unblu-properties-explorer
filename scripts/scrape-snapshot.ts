import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PropertiesScraper } from './scraper/properties-scraper.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FILE = path.resolve(SCRIPT_DIR, '../src/assets/properties-snapshot.json');

async function main(): Promise<void> {
  const forceLogin = process.argv.includes('--force-login');
  const scraper = new PropertiesScraper();

  console.log(`[scrape-snapshot] Starting${forceLogin ? ' (force-login)' : ''}...`);
  const snapshot = await scraper.scrapeAll({ forceLogin });
  console.log(`[scrape-snapshot] Scraped ${snapshot.rows.length} rows.`);

  await fs.mkdir(path.dirname(SNAPSHOT_FILE), { recursive: true });
  await fs.writeFile(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  console.log(`[scrape-snapshot] Wrote ${path.relative(process.cwd(), SNAPSHOT_FILE)}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[scrape-snapshot] Failed: ${message}`);
  process.exit(1);
});

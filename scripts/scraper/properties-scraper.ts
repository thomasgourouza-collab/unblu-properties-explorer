import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { chromium, type Page } from 'playwright';

import type { ConfigRowApi, PropertiesSnapshot, ScrapedPropertyRow } from '../types.js';
import { AuthRequiredError, scrapeConfigurationProperties, scrapeTextProperties } from './extractors.js';

const SCRAPER_DIR = path.dirname(fileURLToPath(import.meta.url));
const AUTH_STATE_FILE = path.resolve(SCRAPER_DIR, '../.auth/storage-state.json');
const AUTH_WAIT_TIMEOUT_MS = 2 * 60 * 1000;

export class PropertiesScraper {
  private readonly scrapeTimeoutMs = 120_000;

  scrapeAll(options?: { forceLogin?: boolean }): Promise<PropertiesSnapshot> {
    return withTimeout(
      this.scrapeAllInternal(options),
      this.scrapeTimeoutMs,
      `Scrape timed out after ${Math.round(this.scrapeTimeoutMs / 1000)} seconds.`
    );
  }

  async clearAuthState(): Promise<void> {
    try {
      await fs.unlink(AUTH_STATE_FILE);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private async scrapeAllInternal(options?: { forceLogin?: boolean }): Promise<PropertiesSnapshot> {
    if (options?.forceLogin) {
      await this.clearAuthState();
      await this.runInteractiveLogin();
      const forcedAttempt = await this.runScrapeAttempt({ allowSavedAuthState: true });
      return this.buildSnapshot(forcedAttempt.rows);
    }

    const primaryAttempt = await this.runScrapeAttempt({ allowSavedAuthState: true }).catch((error) => ({
      error
    }));

    if (!('error' in primaryAttempt)) {
      return this.buildSnapshot(primaryAttempt.rows);
    }

    if (!(primaryAttempt.error instanceof AuthRequiredError)) {
      throw primaryAttempt.error;
    }

    await this.runInteractiveLogin();
    const retryAttempt = await this.runScrapeAttempt({ allowSavedAuthState: true });
    return this.buildSnapshot(retryAttempt.rows);
  }

  private async runScrapeAttempt(options: {
    allowSavedAuthState: boolean;
  }): Promise<{ rows: ScrapedPropertyRow[] }> {
    const statePath = options.allowSavedAuthState && (await this.hasAuthState()) ? AUTH_STATE_FILE : undefined;
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(
      statePath
        ? {
            storageState: statePath
          }
        : undefined
    );

    try {
      const page = await context.newPage();
      const configRows = await scrapeConfigurationProperties(page);
      const textRows = await scrapeTextProperties(page);
      return { rows: [...configRows, ...textRows] };
    } finally {
      await context.close();
      await browser.close();
    }
  }

  private async runInteractiveLogin(): Promise<void> {
    if (!this.canRunHeadedLogin()) {
      throw new AuthRequiredError(
        'Interactive login requires a display server (X11/Wayland). Run this script on a machine with a desktop.'
      );
    }

    await fs.mkdir(path.dirname(AUTH_STATE_FILE), { recursive: true });
    const browser = await chromium.launch({ headless: false, slowMo: 120 });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto('https://udocs.unblu.com/latest-internal/reference/configuration-properties.html', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000
      });

      const loginComplete = await this.waitForAuthenticatedPage(page, AUTH_WAIT_TIMEOUT_MS);
      if (!loginComplete) {
        throw new Error(
          'Login timeout after 2 minutes. Authenticate in the opened browser window, then retry.'
        );
      }

      await context.storageState({ path: AUTH_STATE_FILE });
    } finally {
      await context.close();
      await browser.close();
    }
  }

  /**
   * Headed Chromium needs a GUI. macOS and Windows always allow it; Linux needs DISPLAY/WAYLAND_DISPLAY.
   */
  private canRunHeadedLogin(): boolean {
    const platform = process.platform;
    if (platform === 'darwin' || platform === 'win32') {
      return true;
    }
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  }

  private async waitForAuthenticatedPage(page: Page, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const hasContent = await page
        .waitForSelector('div.sect1', { timeout: 2_000 })
        .then(() => true)
        .catch(() => false);

      if (hasContent) {
        return true;
      }

      await page.waitForTimeout(1_000);
    }

    return false;
  }

  private async hasAuthState(): Promise<boolean> {
    try {
      await fs.access(AUTH_STATE_FILE);
      return true;
    } catch {
      return false;
    }
  }

  private buildSnapshot(rows: ScrapedPropertyRow[]): PropertiesSnapshot {
    const mappedRows: ConfigRowApi[] = rows.map((row, index) => {
      const source = row.source;
      const rowKey = `${source}::${index}`;

      return {
        category: row.groupTitle,
        propertyTitle: row.label,
        property: row.key,
        source,
        rowKey,
        defaultValue: row.defaultValue,
        value: row.defaultValue,
        configImportError: '',
        valueImportResolvedHighlight: false,
        type: row.type,
        allowedValues: row.allowedValues,
        allowedScopes: row.allowedScopes,
        visibility: row.visibility,
        editableBy: row.editableBy,
        description: row.description,
        status: row.status,
        dependsOn: row.dependsOn ?? [],
        allowedScopesTokens: tokenizeCommaSeparatedValues(row.allowedScopes),
        editableByTokens: tokenizeCommaSeparatedValues(row.editableBy),
        hasAllowedValuesColumn: row.hasAllowedValuesColumn,
        extra: {}
      };
    });

    return {
      rows: mappedRows,
      warnings: [],
      metadata: {
        scrapedAt: new Date().toISOString()
      }
    };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise
      .then((value) => {
        globalThis.clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error: unknown) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      });
  });
}

function tokenizeCommaSeparatedValues(input: string): string[] {
  return input
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

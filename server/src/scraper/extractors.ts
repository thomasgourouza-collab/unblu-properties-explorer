import type { Page } from 'playwright';

import type { ScrapedPropertyRow } from '../types.js';

const CONFIG_URL = 'https://udocs.unblu.com/latest-internal/reference/configuration-properties.html';
const TEXT_URL = 'https://udocs.unblu.com/latest-internal/reference/text-properties.html';

const AUTH_ERROR_MESSAGE = 'Invalid IAP credentials: empty token';

export class AuthRequiredError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Authentication required: ${reason}`);
    this.name = 'AuthRequiredError';
    this.reason = reason;
  }
}

export async function scrapeConfigurationProperties(page: Page): Promise<ScrapedPropertyRow[]> {
  await navigateAndEnsureAuthenticated(page, CONFIG_URL);

  return page.evaluate(CONFIG_EXTRACTOR_SCRIPT) as Promise<ScrapedPropertyRow[]>;
}

export async function scrapeTextProperties(page: Page): Promise<ScrapedPropertyRow[]> {
  await navigateAndEnsureAuthenticated(page, TEXT_URL);

  return page.evaluate(TEXT_EXTRACTOR_SCRIPT) as Promise<ScrapedPropertyRow[]>;
}

const SHARED_EXTRACTOR_HELPERS = `
  const detectStatus = (propertyBlock) => {
    if (propertyBlock.querySelector('.admonitionblock.warning, .admonitionblock.caution, [class*="deprecated" i]')) return 'Deprecated';
    if (propertyBlock.querySelector('.admonitionblock.note, .admonitionblock.tip, [class*="preview" i]')) return 'Preview';
    const blockText = (propertyBlock.textContent || '').replace(/\\s+/g, ' ').trim();
    if (/\\bdeprecated\\b/i.test(blockText)) return 'Deprecated';
    if (/\\b(preview feature|in preview|tech preview|technology preview)\\b/i.test(blockText)) return 'Preview';
    return 'Stable';
  };
  const collectDependsOn = (propertyBlock, ownKey) => {
    const seen = new Set();
    const KEY_REGEX = /[a-z][a-zA-Z0-9_-]*(?:\\.[a-zA-Z0-9_-]+){2,}/g;
    const candidates = propertyBlock.querySelectorAll(':scope .paragraph code.code__key, :scope .paragraph code, :scope .ulist.none code.code__key, :scope .ulist.none code');
    candidates.forEach((node) => {
      const text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!text) return;
      const matches = text.match(KEY_REGEX);
      if (!matches) return;
      matches.forEach((match) => {
        if (match && match !== ownKey) seen.add(match);
      });
    });
    return Array.from(seen);
  };
`;

const CONFIG_EXTRACTOR_SCRIPT = `(() => {
  ${SHARED_EXTRACTOR_HELPERS}
  const TYPE_ALLOWED_VALUES_SEPARATOR = /\\s+with allowed values:\\s+/i;
  const cleanText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const normalizeTypeLabel = (typeValue) => (typeValue === 'List of string' ? 'List of strings' : typeValue);
  const splitTypeAndAllowedValues = (typeText) => {
    const value = cleanText(typeText);
    if (!TYPE_ALLOWED_VALUES_SEPARATOR.test(value)) return { type: normalizeTypeLabel(value), allowedValues: '' };
    const parts = value.split(TYPE_ALLOWED_VALUES_SEPARATOR);
    const rawType = parts[0] || '';
    const allowedValues = parts.slice(1).join(', ');
    return { type: normalizeTypeLabel(cleanText(rawType)), allowedValues: cleanText(allowedValues).toUpperCase() };
  };
  const getDirectSect2Blocks = (categoryBlock) => {
    const sectionBody = categoryBlock.querySelector(':scope > .sectionbody');
    if (!sectionBody) return [];
    return Array.from(sectionBody.querySelectorAll(':scope > .sect2'));
  };
  const getFieldMap = (propertyBlock) => {
    const map = { type: '', allowedValues: '', default: '', allowedScopes: '', visibility: '', editableBy: '' };
    const topItems = propertyBlock.querySelectorAll(':scope > .ulist.none > ul.none > li');
    topItems.forEach((li) => {
      const labelNode = li.querySelector('p > strong');
      if (!labelNode) return;
      const labelNodeText = labelNode.textContent || '';
      const label = cleanText(labelNodeText).replace(/:$/, '').toLowerCase();
      const escapedLabel = labelNodeText.replace(/[.*+?^$()|[\\]\\\\{}]/g, '\\\\$&');
      let text = cleanText(li.textContent).replace(new RegExp('^' + escapedLabel + '\\\\s*:\\\\s*', 'i'), '').trim();
      if (label === 'type') {
        const nestedValues = Array.from(li.querySelectorAll(':scope .ulist li p code, :scope .ulist li code'))
          .map((node) => cleanText(node.textContent))
          .filter(Boolean);
        if (nestedValues.length > 0 && !TYPE_ALLOWED_VALUES_SEPARATOR.test(text)) text = (text + ' with allowed values: ' + nestedValues.join(', ')).trim();
        const splitType = splitTypeAndAllowedValues(text);
        map.type = splitType.type;
        map.allowedValues = splitType.allowedValues;
        return;
      }
      if (label === 'default') { map.default = text; return; }
      if (label === 'allowed scopes') { map.allowedScopes = text; return; }
      if (label === 'visibility') { map.visibility = text; return; }
      if (label === 'editable by') map.editableBy = text;
    });
    return map;
  };
  const getDescription = (propertyBlock) => {
    const paragraphs = propertyBlock.querySelectorAll(':scope > .paragraph > p');
    if (paragraphs.length < 2) return '';
    const parts = Array.from(paragraphs).slice(1).map((p) => cleanText(p.textContent)).filter(Boolean);
    return parts.join('\\n\\n');
  };
  const rows = [];
  const categoryBlocks = document.querySelectorAll('div.sect1');
  categoryBlocks.forEach((categoryBlock) => {
    const groupTitle = cleanText(categoryBlock.querySelector(':scope > h2')?.textContent);
    const properties = getDirectSect2Blocks(categoryBlock);
    properties.forEach((propertyBlock) => {
      const label = cleanText(propertyBlock.querySelector(':scope > h3')?.textContent);
      const key = cleanText(propertyBlock.querySelector(':scope > .paragraph code.code__key, :scope > .paragraph code')?.textContent);
      const fields = getFieldMap(propertyBlock);
      rows.push({
        groupTitle,
        label,
        key,
        defaultValue: fields.default,
        type: fields.type,
        allowedValues: fields.allowedValues,
        allowedScopes: fields.allowedScopes,
        visibility: fields.visibility,
        editableBy: fields.editableBy,
        description: getDescription(propertyBlock),
        status: detectStatus(propertyBlock),
        dependsOn: collectDependsOn(propertyBlock, key),
        source: 'configuration-properties',
        hasAllowedValuesColumn: true
      });
    });
  });
  return rows;
})()`;

const TEXT_EXTRACTOR_SCRIPT = `(() => {
  ${SHARED_EXTRACTOR_HELPERS}
  const cleanText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const cleanPreText = (value) => String(value ?? '').replace(/\\r\\n/g, '\\n').trim();
  const getDirectSect2Blocks = (categoryBlock) => {
    const sectionBody = categoryBlock.querySelector(':scope > .sectionbody');
    if (!sectionBody) return [];
    return Array.from(sectionBody.querySelectorAll(':scope > .sect2'));
  };
  const getDefaultFromInlineLi = (defaultLi, defaultLabelText) => {
    if (!defaultLi) return '';
    const escapedLabel = defaultLabelText.replace(/[.*+?^$()|[\\]\\\\{}]/g, '\\\\$&');
    return cleanText(defaultLi.textContent).replace(new RegExp('^' + escapedLabel + '\\\\s*:\\\\s*', 'i'), '').trim();
  };
  const getDefaultFromListingBlock = (propertyBlock) => {
    const pre = propertyBlock.querySelector(':scope > .listingblock > .content > pre');
    return pre ? cleanPreText(pre.textContent) : '';
  };
  const getDefaultValue = (propertyBlock, defaultLi, defaultLabelText) => {
    const inlineDefault = getDefaultFromInlineLi(defaultLi, defaultLabelText);
    return inlineDefault || getDefaultFromListingBlock(propertyBlock);
  };
  const getFieldMap = (propertyBlock) => {
    const map = { type: '', default: '', allowedScopes: '', visibility: '', editableBy: '' };
    const topItems = propertyBlock.querySelectorAll(':scope > .ulist.none > ul.none > li');
    topItems.forEach((li) => {
      const labelNode = li.querySelector('p > strong');
      if (!labelNode) return;
      const rawLabelText = cleanText(labelNode.textContent);
      const label = rawLabelText.replace(/:$/, '').toLowerCase();
      const escapedLabel = rawLabelText.replace(/[.*+?^$()|[\\]\\\\{}]/g, '\\\\$&');
      let text = cleanText(li.textContent).replace(new RegExp('^' + escapedLabel + '\\\\s*:\\\\s*', 'i'), '').trim();
      if (label === 'type') {
        const nestedValues = Array.from(li.querySelectorAll(':scope .ulist li p code, :scope .ulist li code'))
          .map((node) => cleanText(node.textContent))
          .filter(Boolean);
        if (nestedValues.length > 0) text = (text + ' ' + nestedValues.join(', ')).trim();
        map.type = text;
        return;
      }
      if (label === 'default') { map.default = getDefaultValue(propertyBlock, li, rawLabelText); return; }
      if (label === 'allowed scopes') { map.allowedScopes = text; return; }
      if (label === 'visibility') { map.visibility = text; return; }
      if (label === 'editable by') map.editableBy = text;
    });
    return map;
  };
  const getDescription = (propertyBlock) => {
    const paragraphs = propertyBlock.querySelectorAll(':scope > .paragraph > p');
    if (paragraphs.length < 2) return '';
    const parts = Array.from(paragraphs).slice(1).map((p) => cleanText(p.textContent)).filter(Boolean);
    return parts.join('\\n\\n');
  };
  const rows = [];
  const categoryBlocks = document.querySelectorAll('div.sect1');
  categoryBlocks.forEach((categoryBlock) => {
    const groupTitle = cleanText(categoryBlock.querySelector(':scope > h2')?.textContent);
    const properties = getDirectSect2Blocks(categoryBlock);
    properties.forEach((propertyBlock) => {
      const label = cleanText(propertyBlock.querySelector(':scope > h3')?.textContent);
      const key = cleanText(propertyBlock.querySelector(':scope > .paragraph code.code__key, :scope > .paragraph code')?.textContent);
      const fields = getFieldMap(propertyBlock);
      rows.push({
        groupTitle,
        label,
        key,
        defaultValue: fields.default,
        type: fields.type,
        allowedValues: '',
        allowedScopes: fields.allowedScopes,
        visibility: fields.visibility,
        editableBy: fields.editableBy,
        description: getDescription(propertyBlock),
        status: detectStatus(propertyBlock),
        dependsOn: collectDependsOn(propertyBlock, key),
        source: 'text-properties',
        hasAllowedValuesColumn: false
      });
    });
  });
  return rows;
})()`;

export function isLikelyAuthFailure(htmlBody: string): boolean {
  const normalized = htmlBody.toLowerCase();
  return (
    normalized.includes(AUTH_ERROR_MESSAGE.toLowerCase()) ||
    normalized.includes('sign in with google') ||
    normalized.includes('accounts.google.com') ||
    normalized.includes('identity-aware proxy')
  );
}

async function navigateAndEnsureAuthenticated(page: Page, url: string): Promise<void> {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const status = response?.status() ?? 0;

  if (status >= 400) {
    throw new AuthRequiredError(`HTTP ${status}`);
  }

  const hasContent = await page
    .waitForSelector('div.sect1', { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (hasContent) {
    return;
  }

  const htmlBody = await page.content();
  if (isLikelyAuthFailure(htmlBody)) {
    throw new AuthRequiredError('IAP or login page detected');
  }

  throw new Error('Expected documentation content was not found.');
}

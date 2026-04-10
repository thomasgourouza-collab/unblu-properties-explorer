import express from 'express';
import { randomUUID } from 'node:crypto';

import { AuthRequiredError } from './scraper/extractors.js';
import { PropertiesScraper } from './scraper/properties-scraper.js';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const scraper = new PropertiesScraper();
const accountSessions = new Map<string, AccountSession>();

app.use(express.json());
app.use((req, _res, next) => {
  if (
    req.path === '/api/properties' ||
    req.path === '/api/auth/relogin' ||
    req.path === '/api/account/connect' ||
    req.path === '/api/account/update' ||
    req.path === '/api/account/disconnect' ||
    req.path === '/api/account/apikeys' ||
    req.path === '/api/account/apikey/update'
  ) {
    console.log(`[api] ${req.method} ${req.path} started`);
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/properties', async (req, res) => {
  const forceLogin = toBoolean(req.query.forceLogin);

  try {
    const response = await scraper.scrapeAll({ forceLogin });
    console.log(
      `[api] GET /api/properties completed: rows=${response.rows.length}, authRefreshed=${response.metadata.authRefreshed}, fromCache=${response.metadata.fromCache}`
    );
    res.json(response);
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      res.status(401).json({
        message: 'Authentication is required. Complete Google login when prompted and retry.',
        detail: error.reason
      });
      return;
    }

    const message = error instanceof Error ? error.message : 'Unexpected scraper error.';
    res.status(500).json({ message });
  }
});

app.post('/api/auth/relogin', async (_req, res) => {
  try {
    await scraper.clearAuthState();
    const response = await scraper.scrapeAll({ forceLogin: true });
    console.log('[api] POST /api/auth/relogin completed');
    res.json({
      message: 'Authentication refreshed.',
      metadata: response.metadata
    });
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      res.status(401).json({
        message: 'Authentication is required. Complete Google login when prompted and retry.',
        detail: error.reason
      });
      return;
    }

    const message = error instanceof Error ? error.message : 'Authentication refresh failed.';
    res.status(500).json({ message });
  }
});

app.post('/api/account/connect', async (req, res) => {
  const parsed = parseConnectPayload(req.body);
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.message });
    return;
  }

  const { baseUrl, username, password } = parsed.value;
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const endpoint = buildGetCurrentAccountUrl(normalizedBaseUrl);
  const credentials = `${username}:${password}`;
  const authHeader = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      const detail = await readResponseDetail(response);
      res.status(response.status).json({
        message: detail || `Unblu request failed with HTTP ${response.status}.`
      });
      return;
    }

    const payload = (await response.json()) as unknown;
    const sessionId = randomUUID();
    accountSessions.set(sessionId, {
      baseUrl: normalizedBaseUrl,
      authHeader
    });
    res.json({ account: payload, sessionId });
  } catch {
    res.status(502).json({
      message: 'Could not reach the Unblu endpoint. Check base URL, network access, and credentials.'
    });
  }
});

app.post('/api/account/update', async (req, res) => {
  const parsed = parseAccountUpdatePayload(req.body);
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.message });
    return;
  }

  const { sessionId, account } = parsed.value;
  const session = accountSessions.get(sessionId);
  if (!session) {
    res.status(401).json({
      message: 'Account session not found. Connect account again and retry.'
    });
    return;
  }

  const endpoint = buildUpdateAccountUrl(session.baseUrl);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: session.authHeader,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(account)
    });

    if (!response.ok) {
      const detail = await readResponseDetail(response);
      res.status(response.status).json({
        message: detail || `Unblu request failed with HTTP ${response.status}.`
      });
      return;
    }

    const payload = (await response.json()) as unknown;
    res.json({ account: payload });
  } catch {
    res.status(502).json({
      message: 'Could not reach the Unblu endpoint. Check base URL, network access, and credentials.'
    });
  }
});

app.post('/api/account/apikeys', async (req, res) => {
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (!sessionId) {
    res.status(400).json({ message: 'sessionId is required.' });
    return;
  }
  const session = accountSessions.get(sessionId);
  if (!session) {
    res.status(401).json({ message: 'Account session not found. Connect account again and retry.' });
    return;
  }

  const endpoint = `${session.baseUrl}/app/rest/v4/apikeys/search?expand=configuration,text`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: session.authHeader,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ '$_type': 'ApiKeyQuery' })
    });

    if (!response.ok) {
      const detail = await readResponseDetail(response);
      res.status(response.status).json({
        message: detail || `Unblu request failed with HTTP ${response.status}.`
      });
      return;
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const items = Array.isArray(payload) ? payload : Array.isArray(payload.items) ? payload.items : [];
    res.json({ apiKeys: items });
  } catch {
    res.status(502).json({
      message: 'Could not reach the Unblu endpoint. Check base URL, network access, and credentials.'
    });
  }
});

app.post('/api/account/apikey/update', async (req, res) => {
  const parsed = parseAccountUpdatePayload(req.body);
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.message });
    return;
  }

  const { sessionId, account: apiKey } = parsed.value;
  const session = accountSessions.get(sessionId);
  if (!session) {
    res.status(401).json({
      message: 'Account session not found. Connect account again and retry.'
    });
    return;
  }

  const endpoint = `${session.baseUrl}/app/rest/v4/apikeys/update?expand=configuration,text`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: session.authHeader,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(apiKey)
    });

    if (!response.ok) {
      const detail = await readResponseDetail(response);
      res.status(response.status).json({
        message: detail || `Unblu request failed with HTTP ${response.status}.`
      });
      return;
    }

    const payload = (await response.json()) as unknown;
    res.json({ apiKey: payload });
  } catch {
    res.status(502).json({
      message: 'Could not reach the Unblu endpoint. Check base URL, network access, and credentials.'
    });
  }
});

app.post('/api/account/disconnect', (req, res) => {
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (sessionId) {
    accountSessions.delete(sessionId);
  }
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

function toBoolean(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => toBoolean(entry));
  }
  return value === '1' || value === 'true' || value === true;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function buildGetCurrentAccountUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/app/rest/v4/accounts/getCurrentAccount?expand=configuration,text`;
}

function buildUpdateAccountUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/app/rest/v4/accounts/update?expand=configuration,text`;
}

function parseConnectPayload(body: unknown):
  | { ok: true; value: { baseUrl: string; username: string; password: string } }
  | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'Missing request body.' };
  }

  const baseUrl = typeof (body as { baseUrl?: unknown }).baseUrl === 'string'
    ? (body as { baseUrl: string }).baseUrl.trim()
    : '';
  const username = typeof (body as { username?: unknown }).username === 'string'
    ? (body as { username: string }).username.trim()
    : '';
  const password = typeof (body as { password?: unknown }).password === 'string'
    ? (body as { password: string }).password
    : '';

  if (!baseUrl || !username || !password) {
    return { ok: false, message: 'baseUrl, username, and password are required.' };
  }

  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, message: 'baseUrl must start with http:// or https://.' };
    }
  } catch {
    return { ok: false, message: 'baseUrl is not a valid URL.' };
  }

  return { ok: true, value: { baseUrl, username, password } };
}

async function readResponseDetail(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const payload = (await response.json()) as unknown;
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'message' in payload &&
        typeof (payload as { message?: unknown }).message === 'string'
      ) {
        return (payload as { message: string }).message;
      }
      return JSON.stringify(payload);
    }
    const text = await response.text();
    return text.trim();
  } catch {
    return '';
  }
}

interface AccountSession {
  baseUrl: string;
  authHeader: string;
}

function parseAccountUpdatePayload(body: unknown):
  | { ok: true; value: { sessionId: string; account: Record<string, unknown> } }
  | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'Missing request body.' };
  }

  const sessionId = typeof (body as { sessionId?: unknown }).sessionId === 'string'
    ? (body as { sessionId: string }).sessionId.trim()
    : '';
  const accountRaw = (body as { account?: unknown }).account;

  if (!sessionId) {
    return { ok: false, message: 'sessionId is required.' };
  }
  if (typeof accountRaw !== 'object' || accountRaw === null || Array.isArray(accountRaw)) {
    return { ok: false, message: 'account must be a JSON object.' };
  }

  return {
    ok: true,
    value: {
      sessionId,
      account: accountRaw as Record<string, unknown>
    }
  };
}

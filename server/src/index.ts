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
    req.path === '/api/account/refresh' ||
    req.path === '/api/account/update' ||
    req.path === '/api/account/disconnect' ||
    req.path === '/api/account/apikeys' ||
    req.path === '/api/account/apikey/update' ||
    req.path === '/api/account/list' ||
    req.path === '/api/global/get' ||
    req.path === '/api/global/update'
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

  const { baseUrl, username, password, kind } = parsed.value;
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const credentials = `${username}:${password}`;
  const authHeader = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
  const session: AccountSession = { baseUrl: normalizedBaseUrl, authHeader, kind };

  try {
    if (kind === 'global') {
      // Phase 1: stateless calls (Basic Auth) — verify superadmin and gather instance-wide data.
      const [accounts, globalData] = await Promise.all([
        fetchAllAccounts(session),
        fetchGlobalData(session)
      ]);

      // Phase 2: open a cookie session for switchToAccount-based per-account work.
      // If login fails, we still ship the connect — the user just won't be able to list/update
      // API keys in non-superadmin-home accounts. We return a soft warning instead of erroring.
      let cookieSessionWarning: string | undefined;
      try {
        await startCookieSession(session, username, password);
      } catch (loginErr) {
        cookieSessionWarning =
          loginErr instanceof UnbluUpstreamError
            ? loginErr.message
            : 'Could not start cookie session for per-account API key access.';
      }

      // Phase 3: per-account API keys. Sequential because the cookie session has shared state.
      const apiKeysByAccountId: Record<string, unknown[]> = {};
      const accountIds = accounts
        .map((acc) => (typeof acc['id'] === 'string' ? acc['id'] : ''))
        .filter((id): id is string => id.length > 0);
      if (session.cookieHeader) {
        for (const accountId of accountIds) {
          try {
            apiKeysByAccountId[accountId] = await fetchApiKeysForAccount(session, accountId);
          } catch {
            // Don't fail the whole connect for a single account's keys.
            apiKeysByAccountId[accountId] = [];
          }
        }
      } else {
        for (const accountId of accountIds) {
          apiKeysByAccountId[accountId] = [];
        }
      }

      const sessionId = randomUUID();
      accountSessions.set(sessionId, session);
      res.json({
        kind: 'global',
        accounts,
        apiKeysByAccountId,
        global: globalData,
        sessionId,
        cookieSessionWarning
      });
      return;
    }

    // Account-level connect: fetch the current account.
    const endpoint = buildGetCurrentAccountUrl(normalizedBaseUrl);
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: authHeader, Accept: 'application/json' }
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
    accountSessions.set(sessionId, session);
    res.json({ kind: 'account', account: payload, sessionId });
  } catch (error) {
    if (error instanceof UnbluUpstreamError) {
      res.status(error.status).json({ message: error.message });
      return;
    }
    res.status(502).json({
      message: 'Could not reach the Unblu endpoint. Check base URL, network access, and credentials.'
    });
  }
});

app.post('/api/account/refresh', async (req, res) => {
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

  const accountId = typeof req.body?.accountId === 'string' ? req.body.accountId.trim() : '';
  if (session.kind === 'global' && !accountId) {
    res.status(400).json({ message: 'accountId is required when refreshing a global session.' });
    return;
  }

  const endpoint =
    session.kind === 'global'
      ? `${session.baseUrl}/app/rest/v4/accounts/${encodeURIComponent(accountId)}/read?expand=configuration,text`
      : buildGetCurrentAccountUrl(session.baseUrl);

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: session.authHeader, Accept: 'application/json' }
    });
    if (!response.ok) {
      const detail = await readResponseDetail(response);
      res.status(response.status).json({ message: detail || `HTTP ${response.status}` });
      return;
    }
    const payload = (await response.json()) as unknown;
    res.json({ account: payload });
  } catch {
    res.status(502).json({ message: 'Could not reach the Unblu endpoint.' });
  }
});

app.post('/api/account/update', async (req, res) => {
  const parsed = parseAccountUpdatePayload(req.body);
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.message });
    return;
  }

  const { sessionId, account, accountId } = parsed.value;
  const session = accountSessions.get(sessionId);
  if (!session) {
    res.status(401).json({
      message: 'Account session not found. Connect account again and retry.'
    });
    return;
  }
  if (session.kind === 'global' && !accountId) {
    res.status(400).json({ message: 'accountId is required when updating in a global session.' });
    return;
  }

  const endpoint = buildAccountScopedUrl(
    session,
    '/app/rest/v4/accounts/update?expand=configuration,text',
    accountId
  );
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

  const accountId = typeof req.body?.accountId === 'string' ? req.body.accountId.trim() : '';
  if (session.kind === 'global' && !accountId) {
    res.status(400).json({ message: 'accountId is required when listing API keys in a global session.' });
    return;
  }

  try {
    const items = await fetchApiKeysForAccount(session, accountId);
    res.json({ apiKeys: items });
  } catch (error) {
    if (error instanceof UnbluUpstreamError) {
      res.status(error.status).json({ message: error.message });
      return;
    }
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

  const { sessionId, account: apiKey, accountId } = parsed.value;
  const session = accountSessions.get(sessionId);
  if (!session) {
    res.status(401).json({
      message: 'Account session not found. Connect account again and retry.'
    });
    return;
  }
  if (session.kind === 'global' && !accountId) {
    res.status(400).json({ message: 'accountId is required when updating an API key in a global session.' });
    return;
  }

  const path = '/app/rest/v4/apikeys/update?expand=configuration,text';
  const body = JSON.stringify(apiKey);

  const runUpdate = async (
    headers: Record<string, string>
  ): Promise<{ status: number; payload: unknown; ok: boolean; detail: string }> => {
    const response = await fetch(`${session.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...headers
      },
      body
    });
    if (!response.ok) {
      const detail = await readResponseDetail(response);
      return { status: response.status, payload: null, ok: false, detail };
    }
    return { status: response.status, payload: await response.json(), ok: true, detail: '' };
  };

  try {
    const result =
      session.kind === 'global'
        ? await withSwitchedAccount(session, accountId, () =>
            runUpdate({ Cookie: session.cookieHeader ?? '' })
          )
        : await runUpdate({ Authorization: session.authHeader });

    if (!result.ok) {
      res.status(result.status).json({
        message: result.detail || `Unblu request failed with HTTP ${result.status}.`
      });
      return;
    }
    res.json({ apiKey: result.payload });
  } catch (error) {
    if (error instanceof UnbluUpstreamError) {
      res.status(error.status).json({ message: error.message });
      return;
    }
    res.status(502).json({
      message: 'Could not reach the Unblu endpoint. Check base URL, network access, and credentials.'
    });
  }
});

app.post('/api/account/list', async (req, res) => {
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
  if (session.kind !== 'global') {
    res.status(400).json({ message: 'list is only available for global sessions.' });
    return;
  }

  try {
    const accounts = await fetchAllAccounts(session);
    const apiKeysByAccountId: Record<string, unknown[]> = {};
    const accountIds = accounts
      .map((acc) => (typeof acc['id'] === 'string' ? acc['id'] : ''))
      .filter((id): id is string => id.length > 0);
    const keysPerAccount = await Promise.all(
      accountIds.map((accountId) => fetchApiKeysForAccount(session, accountId))
    );
    accountIds.forEach((accountId, idx) => {
      apiKeysByAccountId[accountId] = keysPerAccount[idx];
    });
    res.json({ accounts, apiKeysByAccountId });
  } catch (error) {
    if (error instanceof UnbluUpstreamError) {
      res.status(error.status).json({ message: error.message });
      return;
    }
    res.status(502).json({ message: 'Could not reach the Unblu endpoint.' });
  }
});

app.post('/api/global/get', async (req, res) => {
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
  if (session.kind !== 'global') {
    res.status(400).json({ message: 'Global configuration is only available for global sessions.' });
    return;
  }

  try {
    const globalData = await fetchGlobalData(session);
    res.json({ global: globalData });
  } catch (error) {
    if (error instanceof UnbluUpstreamError) {
      res.status(error.status).json({ message: error.message });
      return;
    }
    res.status(502).json({ message: 'Could not reach the Unblu endpoint.' });
  }
});

app.post('/api/global/update', async (req, res) => {
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
  if (session.kind !== 'global') {
    res.status(400).json({ message: 'Global configuration is only available for global sessions.' });
    return;
  }
  const globalRaw = req.body?.global;
  if (typeof globalRaw !== 'object' || globalRaw === null || Array.isArray(globalRaw)) {
    res.status(400).json({ message: 'global must be a JSON object.' });
    return;
  }

  const endpoint = `${session.baseUrl}/app/rest/v4/global/update?expand=configuration,text`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: session.authHeader,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(globalRaw)
    });
    if (!response.ok) {
      const detail = await readResponseDetail(response);
      res.status(response.status).json({
        message: detail || `Unblu request failed with HTTP ${response.status}.`
      });
      return;
    }
    const payload = (await response.json()) as unknown;
    res.json({ global: payload });
  } catch {
    res.status(502).json({
      message: 'Could not reach the Unblu endpoint. Check base URL, network access, and credentials.'
    });
  }
});

app.post('/api/account/disconnect', async (req, res) => {
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (!sessionId) {
    res.json({ ok: true });
    return;
  }
  const session = accountSessions.get(sessionId);
  accountSessions.delete(sessionId);
  // Best-effort logout of the cookie session so we don't leak server-side state.
  if (session?.cookieHeader) {
    fetch(`${session.baseUrl}/app/rest/v4/authenticator/logout`, {
      method: 'POST',
      headers: { Cookie: session.cookieHeader }
    }).catch(() => {});
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

/**
 * Single point where we attach the target account id to a global-mode request.
 * In account mode, returns the URL unchanged.
 * In global mode (with an accountId), appends `?accountId=…` (or `&accountId=…`).
 * If we ever need to switch to a header or `switchToAccount` call, this is the only place to change.
 */
function buildAccountScopedUrl(session: AccountSession, path: string, accountId?: string): string {
  const url = `${session.baseUrl}${path}`;
  if (session.kind === 'global' && accountId) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}accountId=${encodeURIComponent(accountId)}`;
  }
  return url;
}

class UnbluUpstreamError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function fetchAllAccounts(session: AccountSession): Promise<Record<string, unknown>[]> {
  const endpoint = `${session.baseUrl}/app/rest/v4/accounts/search?expand=configuration,text`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: session.authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ '$_type': 'AccountQuery' })
  });
  if (!response.ok) {
    const detail = await readResponseDetail(response);
    throw new UnbluUpstreamError(
      response.status,
      detail || `Listing accounts failed with HTTP ${response.status}.`
    );
  }
  const payload = (await response.json()) as Record<string, unknown> | unknown[];
  if (Array.isArray(payload)) {
    return payload as Record<string, unknown>[];
  }
  const items = payload.items;
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
}

/**
 * Collect Set-Cookie headers from a fetch response into a single Cookie request header.
 * Each entry like "JSESSIONID=abc; Path=/; HttpOnly" is reduced to "JSESSIONID=abc".
 */
function collectSetCookies(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length === 0) {
    return '';
  }
  return setCookies
    .map((sc) => sc.split(';')[0]?.trim() ?? '')
    .filter((pair) => pair.includes('='))
    .join('; ');
}

function mergeSetCookies(existing: string, response: Response): string {
  const fresh = collectSetCookies(response);
  if (!fresh) {
    return existing;
  }
  const map = new Map<string, string>();
  const ingest = (raw: string): void => {
    for (const part of raw.split('; ')) {
      const eq = part.indexOf('=');
      if (eq > 0) {
        map.set(part.slice(0, eq), part.slice(eq + 1));
      }
    }
  };
  if (existing) {
    ingest(existing);
  }
  ingest(fresh);
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * Start a cookie-based authentication session for global mode. The cookie is needed for
 * `switchToAccount` (and downstream apikeys/* calls), since those operate on the "current account"
 * of the auth session — something stateless Basic Auth can't express.
 */
async function startCookieSession(
  session: AccountSession,
  username: string,
  password: string
): Promise<void> {
  const url = `${session.baseUrl}/app/rest/v4/authenticator/login`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!response.ok) {
    const detail = await readResponseDetail(response);
    throw new UnbluUpstreamError(
      response.status,
      detail || `Login for cookie session failed with HTTP ${response.status}.`
    );
  }
  const cookies = collectSetCookies(response);
  if (!cookies) {
    throw new UnbluUpstreamError(
      500,
      'Login succeeded but the Unblu server did not return a session cookie.'
    );
  }
  session.cookieHeader = cookies;
  session.switchedAccountId = undefined;
}

/**
 * Run `fn` with the cookie session scoped to `accountId`. Calls switchToAccount if needed.
 * Serializes per-session via a Promise mutex so concurrent callers don't trample on the
 * shared "current account" state.
 */
async function withSwitchedAccount<T>(
  session: AccountSession,
  accountId: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = session.cookieMutex ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  session.cookieMutex = previous.then(() => next);
  await previous;
  try {
    if (!session.cookieHeader) {
      throw new UnbluUpstreamError(
        401,
        'No active cookie session. Reconnect in Global mode and retry.'
      );
    }
    if (session.switchedAccountId !== accountId) {
      const switchUrl = `${session.baseUrl}/app/rest/v4/authenticator/switchToAccount`;
      const switchResponse = await fetch(switchUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Cookie: session.cookieHeader
        },
        body: JSON.stringify({ accountId })
      });
      if (!switchResponse.ok) {
        const detail = await readResponseDetail(switchResponse);
        throw new UnbluUpstreamError(
          switchResponse.status,
          detail || `switchToAccount failed with HTTP ${switchResponse.status}.`
        );
      }
      session.cookieHeader = mergeSetCookies(session.cookieHeader, switchResponse);
      session.switchedAccountId = accountId;
    }
    return await fn();
  } finally {
    release();
  }
}

async function fetchGlobalData(session: AccountSession): Promise<Record<string, unknown>> {
  const endpoint = `${session.baseUrl}/app/rest/v4/global/read?expand=configuration,text`;
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: { Authorization: session.authHeader, Accept: 'application/json' }
  });
  if (!response.ok) {
    const detail = await readResponseDetail(response);
    throw new UnbluUpstreamError(
      response.status,
      detail || `Reading global configuration failed with HTTP ${response.status}.`
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Lists API keys for a specific account in global mode.
 * `apikeys/search` is "current account"-scoped, so we use the cookie session and switchToAccount.
 * In account mode, `accountId` is ignored and Basic Auth is sufficient.
 */
async function fetchApiKeysForAccount(
  session: AccountSession,
  accountId: string
): Promise<Record<string, unknown>[]> {
  const path = '/app/rest/v4/apikeys/search?expand=configuration,text';
  const body = JSON.stringify({ '$_type': 'ApiKeyQuery' });

  const runSearch = async (headers: Record<string, string>): Promise<Record<string, unknown>[]> => {
    const response = await fetch(`${session.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...headers
      },
      body
    });
    if (!response.ok) {
      const detail = await readResponseDetail(response);
      throw new UnbluUpstreamError(
        response.status,
        detail || `apikeys/search failed with HTTP ${response.status}.`
      );
    }
    const payload = (await response.json()) as Record<string, unknown> | unknown[];
    if (Array.isArray(payload)) {
      return payload as Record<string, unknown>[];
    }
    const items = payload.items;
    return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
  };

  if (session.kind !== 'global') {
    return runSearch({ Authorization: session.authHeader });
  }
  return withSwitchedAccount(session, accountId, () =>
    runSearch({ Cookie: session.cookieHeader ?? '' })
  );
}

function parseConnectPayload(body: unknown):
  | { ok: true; value: { baseUrl: string; username: string; password: string; kind: 'account' | 'global' } }
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
  const rawKind = (body as { kind?: unknown }).kind;
  const kind: 'account' | 'global' = rawKind === 'global' ? 'global' : 'account';

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

  return { ok: true, value: { baseUrl, username, password, kind } };
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
  kind: 'account' | 'global';
  /** Serialized "name=value; name=value" cookie header from /authenticator/login. Global only. */
  cookieHeader?: string;
  /** The account id the cookie session was last switched to. */
  switchedAccountId?: string;
  /** Per-session mutex chain: serialize switchToAccount + cookie-session calls. */
  cookieMutex?: Promise<void>;
}

function parseAccountUpdatePayload(body: unknown):
  | { ok: true; value: { sessionId: string; account: Record<string, unknown>; accountId: string } }
  | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'Missing request body.' };
  }

  const sessionId = typeof (body as { sessionId?: unknown }).sessionId === 'string'
    ? (body as { sessionId: string }).sessionId.trim()
    : '';
  const accountRaw = (body as { account?: unknown }).account;
  const accountId = typeof (body as { accountId?: unknown }).accountId === 'string'
    ? (body as { accountId: string }).accountId.trim()
    : '';

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
      account: accountRaw as Record<string, unknown>,
      accountId
    }
  };
}

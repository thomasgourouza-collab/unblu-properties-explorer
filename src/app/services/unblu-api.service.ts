import { Injectable } from '@angular/core';

export type UnbluRole =
  | 'SUPER_ADMIN'
  | 'TECHNICAL_ADMIN'
  | 'ADMIN'
  | 'SUPERVISOR'
  | 'REGISTERED_USER'
  | 'WEBUSER'
  | 'PARTIALLY_AUTHENTICATED'
  | 'ANONYMOUS_USER';

export interface UnbluEntitySummary {
  id: string;
  label: string;
}

export interface UnbluScopePayload {
  configuration: Record<string, string>;
  text: Record<string, Record<string, string>>;
}

export interface UnbluConnection {
  role: UnbluRole;
  accountId: string | null;
  personId: string | null;
  displayName: string;
}

export class UnbluApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'forbidden' | 'network' | 'cors' | 'server' | 'parse'
  ) {
    super(message);
    this.name = 'UnbluApiError';
  }
}

@Injectable({ providedIn: 'root' })
export class UnbluApiService {
  private baseUrl = '';
  private authHeader = '';

  isConnected(): boolean {
    return this.baseUrl !== '' && this.authHeader !== '';
  }

  reset(): void {
    this.baseUrl = '';
    this.authHeader = '';
  }

  async connect(serverUrl: string, username: string, password: string): Promise<UnbluConnection> {
    const normalized = this.normalizeServerUrl(serverUrl);
    if (!normalized) {
      throw new UnbluApiError('Server URL is required.', 'parse');
    }
    this.baseUrl = `${normalized}/app/rest/v4`;
    this.authHeader = `Basic ${this.b64(`${username}:${password}`)}`;

    const loginResult = await this.post<{ success?: boolean }>(`/authenticator/login`, {
      username,
      password
    });
    if (loginResult && loginResult.success === false) {
      this.reset();
      throw new UnbluApiError('Invalid credentials.', 'auth');
    }

    const person = await this.get<{
      id?: string;
      accountId?: string;
      authorizationRole?: UnbluRole;
      displayName?: string;
      username?: string;
    }>(`/authenticator/getCurrentPerson`);

    const role = person?.authorizationRole ?? 'ANONYMOUS_USER';
    if (role === 'ANONYMOUS_USER' || role === 'PARTIALLY_AUTHENTICATED') {
      this.reset();
      throw new UnbluApiError('Login did not produce an authenticated session.', 'auth');
    }
    return {
      role,
      accountId: person?.accountId ?? null,
      personId: person?.id ?? null,
      displayName: person?.displayName ?? person?.username ?? username
    };
  }

  async getCurrentAccount(): Promise<UnbluEntitySummary | null> {
    const account = await this.get<Record<string, unknown>>(`/accounts/getCurrentAccount`);
    const id = pickString(account, 'id');
    if (!id) return null;
    return { id, label: pickString(account, 'name') || id };
  }

  async searchAccounts(): Promise<UnbluEntitySummary[]> {
    const result = await this.post<{ entities?: Array<Record<string, unknown>> }>(
      `/accounts/search`,
      { offset: 0, limit: 200 }
    );
    return this.toSummaries(result?.entities, (e) => pickString(e, 'name'));
  }

  searchTeams(accountId: string): Promise<UnbluEntitySummary[]> {
    return this.searchScopedByAccount('/teams/search', accountId, (e) => pickString(e, 'name'));
  }

  searchConversationTemplates(accountId: string): Promise<UnbluEntitySummary[]> {
    return this.searchScopedByAccount('/conversationtemplates/search', accountId, (e) =>
      pickString(e, 'name')
    );
  }

  searchNamedAreas(accountId: string): Promise<UnbluEntitySummary[]> {
    return this.searchScopedByAccount('/namedareas/search', accountId, (e) => pickString(e, 'name'));
  }

  searchApiKeys(accountId: string): Promise<UnbluEntitySummary[]> {
    return this.searchScopedByAccount('/apikeys/search', accountId, (e) => pickString(e, 'name'));
  }

  searchUsers(accountId: string): Promise<UnbluEntitySummary[]> {
    return this.searchScopedByAccount('/users/search', accountId, (e) => {
      const first = pickString(e, 'firstName');
      const last = pickString(e, 'lastName');
      const display = [first, last].filter(Boolean).join(' ').trim();
      return display || pickString(e, 'username') || pickString(e, 'email') || pickString(e, 'id');
    });
  }

  searchConversations(accountId: string, templateId?: string): Promise<UnbluEntitySummary[]> {
    const filters: Array<Record<string, unknown>> = [
      {
        $_type: 'AccountIdConversationSearchFilter',
        field: 'ACCOUNT_ID',
        operator: { $_type: 'EqualsStringOperator', value: accountId }
      }
    ];
    if (templateId) {
      filters.push({
        $_type: 'TemplateIdConversationSearchFilter',
        field: 'TEMPLATE_ID',
        operator: { $_type: 'EqualsStringOperator', value: templateId }
      });
    }
    return this.searchWithFilters('/conversations/search', filters, (e) =>
      pickString(e, 'topic') || pickString(e, 'id')
    );
  }

  readGlobal(): Promise<UnbluScopePayload> {
    return this.readScope('/global/read', /* withText */ true);
  }

  readAccount(id: string): Promise<UnbluScopePayload> {
    return this.readScope(`/accounts/${encodeURIComponent(id)}/read`, true);
  }

  readTeam(id: string): Promise<UnbluScopePayload> {
    return this.readScope(`/teams/${encodeURIComponent(id)}/read`, true);
  }

  readConversationTemplate(id: string): Promise<UnbluScopePayload> {
    return this.readScope(`/conversationtemplates/${encodeURIComponent(id)}/read`, true);
  }

  readConversation(id: string): Promise<UnbluScopePayload> {
    return this.readScope(`/conversations/${encodeURIComponent(id)}/read`, true);
  }

  readNamedArea(id: string): Promise<UnbluScopePayload> {
    return this.readScope(`/namedareas/${encodeURIComponent(id)}/read`, true);
  }

  readApiKey(id: string): Promise<UnbluScopePayload> {
    return this.readScope(`/apikeys/${encodeURIComponent(id)}/read`, true);
  }

  readUser(id: string): Promise<UnbluScopePayload> {
    return this.readScope(`/users/${encodeURIComponent(id)}/read`, false);
  }

  private async readScope(path: string, withText: boolean): Promise<UnbluScopePayload> {
    const expand = withText ? 'configuration,text' : 'configuration';
    const data = await this.get<{
      configuration?: Record<string, unknown>;
      text?: Record<string, Record<string, unknown>>;
    }>(`${path}?expand=${expand}`);
    return {
      configuration: this.coerceConfigurationMap(data?.configuration),
      text: this.coerceTextMap(data?.text)
    };
  }

  private async searchScopedByAccount(
    path: string,
    accountId: string,
    labelOf: (entity: Record<string, unknown>) => string
  ): Promise<UnbluEntitySummary[]> {
    const filters = [
      {
        $_type: 'AccountIdSearchFilter',
        field: 'ACCOUNT_ID',
        operator: { $_type: 'EqualsStringOperator', value: accountId }
      }
    ];
    return this.searchWithFilters(path, filters, labelOf);
  }

  private async searchWithFilters(
    path: string,
    filters: Array<Record<string, unknown>>,
    labelOf: (entity: Record<string, unknown>) => string
  ): Promise<UnbluEntitySummary[]> {
    let result;
    try {
      result = await this.post<{ entities?: Array<Record<string, unknown>> }>(path, {
        offset: 0,
        limit: 200,
        filter: this.buildSearchFilter(filters)
      });
    } catch (err) {
      if (err instanceof UnbluApiError && err.kind === 'server') {
        result = await this.post<{ entities?: Array<Record<string, unknown>> }>(path, {
          offset: 0,
          limit: 200
        });
      } else {
        throw err;
      }
    }
    return this.toSummaries(result?.entities, labelOf);
  }

  private buildSearchFilter(filters: Array<Record<string, unknown>>): Record<string, unknown> | null {
    if (filters.length === 0) return null;
    if (filters.length === 1) return filters[0];
    return { $_type: 'AndSearchFilter', filters };
  }

  private toSummaries(
    entities: Array<Record<string, unknown>> | undefined,
    labelOf: (entity: Record<string, unknown>) => string
  ): UnbluEntitySummary[] {
    if (!Array.isArray(entities)) return [];
    const summaries: UnbluEntitySummary[] = [];
    for (const e of entities) {
      const id = pickString(e, 'id');
      if (!id) continue;
      summaries.push({ id, label: labelOf(e) || id });
    }
    return summaries.sort((a, b) => a.label.localeCompare(b.label));
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.baseUrl) {
      throw new UnbluApiError('Not connected.', 'auth');
    }
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: this.authHeader
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'include'
      });
    } catch (err) {
      throw new UnbluApiError(
        'Network error. Your Unblu server may not allow cross-origin requests from this app. ' +
          'Either host this app behind the Unblu reverse proxy, or enable CORS on the server.',
        'cors'
      );
    }
    if (response.status === 401) {
      throw new UnbluApiError('Invalid credentials or expired session.', 'auth');
    }
    if (response.status === 403) {
      throw new UnbluApiError('Your role is not allowed to read this resource.', 'forbidden');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new UnbluApiError(
        `Unblu server returned ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
        'server'
      );
    }
    const ct = response.headers.get('content-type') ?? '';
    if (!ct.includes('json')) {
      return undefined as unknown as T;
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new UnbluApiError('Could not parse Unblu server response.', 'parse');
    }
  }

  private coerceConfigurationMap(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
      else if (v != null) out[k] = String(v);
    }
    return out;
  }

  private coerceTextMap(value: unknown): Record<string, Record<string, string>> {
    if (!value || typeof value !== 'object') return {};
    const out: Record<string, Record<string, string>> = {};
    for (const [key, perLocale] of Object.entries(value as Record<string, unknown>)) {
      if (!perLocale || typeof perLocale !== 'object') continue;
      const localized: Record<string, string> = {};
      for (const [locale, text] of Object.entries(perLocale as Record<string, unknown>)) {
        if (typeof text === 'string') localized[locale] = text;
        else if (text != null) localized[locale] = String(text);
      }
      out[key] = localized;
    }
    return out;
  }

  private normalizeServerUrl(raw: string): string {
    let s = (raw ?? '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    s = s.replace(/\/+$/g, '');
    s = s.replace(/\/app$/i, '');
    return s;
  }

  private b64(input: string): string {
    const bytes = new TextEncoder().encode(input);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
}

function pickString(obj: Record<string, unknown> | null | undefined, key: string): string {
  if (!obj) return '';
  const value = obj[key];
  return typeof value === 'string' ? value : '';
}

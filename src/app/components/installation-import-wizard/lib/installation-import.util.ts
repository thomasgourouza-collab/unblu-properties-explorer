import unbluScopeEditorsJson from '../../../data/unblu-scope-editors.json';
import type { UnbluRole, UnbluScopePayload } from '../../../services/unblu-api.service';

export type WizardScope =
  | 'GLOBAL'
  | 'ACCOUNT'
  | 'TEAM'
  | 'CONVERSATION_TEMPLATE'
  | 'CONVERSATION'
  | 'AREA'
  | 'APIKEY'
  | 'USER';

const SCOPE_EDITORS = unbluScopeEditorsJson as Record<string, string[]>;

export function isScopeAllowedForRole(scope: WizardScope, role: UnbluRole): boolean {
  const allowedRoles = SCOPE_EDITORS[scope];
  if (!Array.isArray(allowedRoles)) return false;
  return allowedRoles.includes(role);
}

export function mergeConfigAndText(
  payload: UnbluScopePayload,
  locale: string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload.configuration ?? {})) {
    out[k] = v;
  }
  const normalizedLocale = (locale ?? 'en').trim() || 'en';
  for (const [key, perLocale] of Object.entries(payload.text ?? {})) {
    if (!perLocale) continue;
    const exact = perLocale[normalizedLocale];
    if (typeof exact === 'string') {
      out[key] = exact;
      continue;
    }
    const language = normalizedLocale.split(/[-_]/)[0];
    const languageMatch = Object.entries(perLocale).find(([loc]) => loc.split(/[-_]/)[0] === language);
    if (languageMatch && typeof languageMatch[1] === 'string') {
      out[key] = languageMatch[1];
      continue;
    }
    const firstNonEmpty = Object.entries(perLocale).find(([, value]) => typeof value === 'string' && value !== '');
    if (firstNonEmpty) {
      out[key] = firstNonEmpty[1];
    }
  }
  return out;
}

export function describeRole(role: UnbluRole): string {
  switch (role) {
    case 'SUPER_ADMIN':
      return 'Super admin';
    case 'TECHNICAL_ADMIN':
      return 'Technical admin';
    case 'ADMIN':
      return 'Admin';
    case 'SUPERVISOR':
      return 'Supervisor';
    case 'REGISTERED_USER':
      return 'Registered user';
    case 'WEBUSER':
      return 'Web user';
    case 'PARTIALLY_AUTHENTICATED':
      return 'Partially authenticated';
    case 'ANONYMOUS_USER':
      return 'Anonymous';
    default:
      return role;
  }
}

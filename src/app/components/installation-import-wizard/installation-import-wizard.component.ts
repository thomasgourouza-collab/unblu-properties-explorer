import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  UnbluApiError,
  UnbluApiService,
  UnbluConnection,
  UnbluEntitySummary,
  UnbluScopePayload
} from '../../services/unblu-api.service';
import { describeRole, isScopeAllowedForRole, mergeConfigAndText, WizardScope } from './lib/installation-import.util';

type WizardStep =
  | 'connect'
  | 'global-or-account'
  | 'sub-scope'
  | 'conversation-under-template';

type SubScope = 'TEAM' | 'CONVERSATION_TEMPLATE' | 'AREA' | 'APIKEY' | 'USER';

interface LocaleOption {
  label: string;
  value: string;
}

interface SubScopeOption {
  value: SubScope;
  label: string;
  scope: WizardScope;
}

@Component({
  selector: 'app-installation-import-wizard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './installation-import-wizard.component.html',
  styleUrl: './installation-import-wizard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InstallationImportWizardComponent implements OnChanges {
  @Input() visible = false;
  @Output() configImport = new EventEmitter<{ source: string; merged: Record<string, string> }>();
  @Output() closed = new EventEmitter<void>();

  step: WizardStep = 'connect';

  serverUrl = '';
  username = '';
  password = '';
  locale = 'en';

  loading = false;
  error = '';

  connection: UnbluConnection | null = null;

  accounts: UnbluEntitySummary[] = [];
  selectedAccount: UnbluEntitySummary | null = null;

  subScope: SubScope = 'TEAM';
  subScopeEntities: UnbluEntitySummary[] = [];
  selectedEntityId = '';

  conversationTemplate: UnbluEntitySummary | null = null;
  conversations: UnbluEntitySummary[] = [];
  selectedConversationId = '';

  readonly localeOptions: LocaleOption[] = [
    { label: 'English (en)', value: 'en' },
    { label: 'French (fr)', value: 'fr' },
    { label: 'German (de)', value: 'de' },
    { label: 'Italian (it)', value: 'it' },
    { label: 'Spanish (es)', value: 'es' },
    { label: 'Dutch (nl)', value: 'nl' },
    { label: 'Portuguese (pt)', value: 'pt' },
    { label: 'Polish (pl)', value: 'pl' },
    { label: 'Russian (ru)', value: 'ru' },
    { label: 'Japanese (ja)', value: 'ja' },
    { label: 'Chinese (zh)', value: 'zh' }
  ];

  readonly subScopeOptions: SubScopeOption[] = [
    { value: 'TEAM', label: 'Team', scope: 'TEAM' },
    { value: 'CONVERSATION_TEMPLATE', label: 'Conversation template', scope: 'CONVERSATION_TEMPLATE' },
    { value: 'AREA', label: 'Area', scope: 'AREA' },
    { value: 'APIKEY', label: 'API key', scope: 'APIKEY' },
    { value: 'USER', label: 'User', scope: 'USER' }
  ];

  constructor(
    private readonly api: UnbluApiService,
    private readonly cdr: ChangeDetectorRef
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['visible'] && this.visible) {
      this.resetState({ keepCredentials: false });
    }
  }

  get availableSubScopes(): SubScopeOption[] {
    if (!this.connection) return [];
    return this.subScopeOptions.filter((opt) => isScopeAllowedForRole(opt.scope, this.connection!.role));
  }

  get canImportGlobal(): boolean {
    return !!this.connection && isScopeAllowedForRole('GLOBAL', this.connection.role);
  }

  get canImportAccount(): boolean {
    return !!this.connection && isScopeAllowedForRole('ACCOUNT', this.connection.role);
  }

  get canImportConversation(): boolean {
    return !!this.connection && isScopeAllowedForRole('CONVERSATION', this.connection.role);
  }

  get roleDescription(): string {
    return this.connection ? describeRole(this.connection.role) : '';
  }

  closeDialog(): void {
    this.api.reset();
    this.resetState({ keepCredentials: false });
    this.closed.emit();
  }

  onBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement | null)?.classList.contains('iiw__backdrop')) {
      this.closeDialog();
    }
  }

  async connect(): Promise<void> {
    this.loading = true;
    this.error = '';
    this.cdr.markForCheck();
    try {
      this.connection = await this.api.connect(this.serverUrl, this.username, this.password);
      this.password = '';
      if (this.canImportGlobal) {
        this.step = 'global-or-account';
      } else {
        this.step = 'global-or-account';
      }
      await this.loadAccounts();
    } catch (err) {
      this.connection = null;
      this.api.reset();
      this.error = this.formatError(err);
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  private async loadAccounts(): Promise<void> {
    if (!this.connection) return;
    try {
      if (this.connection.role === 'SUPER_ADMIN') {
        this.accounts = await this.api.searchAccounts();
      } else {
        const current = await this.api.getCurrentAccount();
        this.accounts = current ? [current] : [];
      }
      if (this.accounts.length === 1) {
        this.selectedAccount = this.accounts[0];
      } else if (this.connection.accountId) {
        this.selectedAccount =
          this.accounts.find((a) => a.id === this.connection!.accountId) ?? null;
      }
    } catch (err) {
      this.error = this.formatError(err);
    }
  }

  async importGlobal(): Promise<void> {
    await this.runImport('global', () => this.api.readGlobal());
  }

  async goToSubScope(): Promise<void> {
    if (!this.selectedAccount) {
      this.error = 'Please choose an account.';
      this.cdr.markForCheck();
      return;
    }
    const allowed = this.availableSubScopes;
    if (allowed.length > 0 && !allowed.some((opt) => opt.value === this.subScope)) {
      this.subScope = allowed[0].value;
    }
    this.error = '';
    this.step = 'sub-scope';
    await this.loadSubScopeEntities();
  }

  async importAccount(): Promise<void> {
    if (!this.selectedAccount) return;
    const account = this.selectedAccount;
    await this.runImport(`account "${account.label}"`, () => this.api.readAccount(account.id));
  }

  async onSubScopeChanged(): Promise<void> {
    this.selectedEntityId = '';
    await this.loadSubScopeEntities();
  }

  private async loadSubScopeEntities(): Promise<void> {
    if (!this.selectedAccount) return;
    this.loading = true;
    this.error = '';
    this.subScopeEntities = [];
    this.cdr.markForCheck();
    try {
      const accountId = this.selectedAccount.id;
      switch (this.subScope) {
        case 'TEAM':
          this.subScopeEntities = await this.api.searchTeams(accountId);
          break;
        case 'CONVERSATION_TEMPLATE':
          this.subScopeEntities = await this.api.searchConversationTemplates(accountId);
          break;
        case 'AREA':
          this.subScopeEntities = await this.api.searchNamedAreas(accountId);
          break;
        case 'APIKEY':
          this.subScopeEntities = await this.api.searchApiKeys(accountId);
          break;
        case 'USER':
          this.subScopeEntities = await this.api.searchUsers(accountId);
          break;
      }
      if (this.subScopeEntities.length === 1) {
        this.selectedEntityId = this.subScopeEntities[0].id;
      }
    } catch (err) {
      this.error = this.formatError(err);
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  async importSubScope(): Promise<void> {
    if (!this.selectedEntityId) {
      this.error = 'Please choose an entity.';
      this.cdr.markForCheck();
      return;
    }
    const entity = this.subScopeEntities.find((e) => e.id === this.selectedEntityId);
    if (!entity) return;

    if (this.subScope === 'CONVERSATION_TEMPLATE') {
      this.conversationTemplate = entity;
      this.error = '';
      this.step = 'conversation-under-template';
      await this.loadConversations();
      return;
    }

    const labelByScope: Record<Exclude<SubScope, 'CONVERSATION_TEMPLATE'>, string> = {
      TEAM: `team "${entity.label}"`,
      AREA: `area "${entity.label}"`,
      APIKEY: `api key "${entity.label}"`,
      USER: `user "${entity.label}"`
    };
    const readerByScope: Record<Exclude<SubScope, 'CONVERSATION_TEMPLATE'>, () => Promise<UnbluScopePayload>> = {
      TEAM: () => this.api.readTeam(entity.id),
      AREA: () => this.api.readNamedArea(entity.id),
      APIKEY: () => this.api.readApiKey(entity.id),
      USER: () => this.api.readUser(entity.id)
    };
    const key = this.subScope as Exclude<SubScope, 'CONVERSATION_TEMPLATE'>;
    await this.runImport(labelByScope[key], readerByScope[key]);
  }

  async importTemplate(): Promise<void> {
    if (!this.conversationTemplate) return;
    const template = this.conversationTemplate;
    await this.runImport(`conversation template "${template.label}"`, () =>
      this.api.readConversationTemplate(template.id)
    );
  }

  private async loadConversations(): Promise<void> {
    if (!this.selectedAccount || !this.conversationTemplate) return;
    this.loading = true;
    this.cdr.markForCheck();
    try {
      this.conversations = await this.api.searchConversations(
        this.selectedAccount.id,
        this.conversationTemplate.id
      );
    } catch (err) {
      this.error = this.formatError(err);
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  async importConversation(): Promise<void> {
    if (!this.selectedConversationId) {
      this.error = 'Please choose a conversation.';
      this.cdr.markForCheck();
      return;
    }
    const entity = this.conversations.find((c) => c.id === this.selectedConversationId);
    if (!entity) return;
    await this.runImport(`conversation "${entity.label}"`, () => this.api.readConversation(entity.id));
  }

  goBack(): void {
    this.error = '';
    switch (this.step) {
      case 'global-or-account':
        this.step = 'connect';
        break;
      case 'sub-scope':
        this.step = 'global-or-account';
        break;
      case 'conversation-under-template':
        this.conversationTemplate = null;
        this.conversations = [];
        this.selectedConversationId = '';
        this.step = 'sub-scope';
        break;
    }
    this.cdr.markForCheck();
  }

  private async runImport(scopeLabel: string, reader: () => Promise<UnbluScopePayload>): Promise<void> {
    this.loading = true;
    this.error = '';
    this.cdr.markForCheck();
    try {
      const payload = await reader();
      const merged = mergeConfigAndText(payload, this.locale);
      const source = `installation: ${scopeLabel}`;
      this.configImport.emit({ source, merged });
      this.api.reset();
      this.resetState({ keepCredentials: false });
    } catch (err) {
      this.error = this.formatError(err);
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  private resetState(options: { keepCredentials: boolean }): void {
    this.step = 'connect';
    if (!options.keepCredentials) {
      this.password = '';
    }
    this.connection = null;
    this.accounts = [];
    this.selectedAccount = null;
    this.subScope = 'TEAM';
    this.subScopeEntities = [];
    this.selectedEntityId = '';
    this.conversationTemplate = null;
    this.conversations = [];
    this.selectedConversationId = '';
    this.loading = false;
    this.error = '';
  }

  private formatError(err: unknown): string {
    if (err instanceof UnbluApiError) return err.message;
    if (err instanceof Error) return err.message;
    return 'Unexpected error.';
  }

  trackById(_index: number, item: UnbluEntitySummary): string {
    return item.id;
  }

  compareById = (a: UnbluEntitySummary | null, b: UnbluEntitySummary | null): boolean =>
    !!a && !!b && a.id === b.id;

  entityLabel(scope: SubScope): string {
    switch (scope) {
      case 'TEAM':
        return 'Team';
      case 'CONVERSATION_TEMPLATE':
        return 'Conversation template';
      case 'AREA':
        return 'Area';
      case 'APIKEY':
        return 'API key';
      case 'USER':
        return 'User';
    }
  }
}

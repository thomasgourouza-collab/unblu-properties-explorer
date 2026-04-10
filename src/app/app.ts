import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, HostListener, OnInit, ViewChild } from '@angular/core';
import { ToastModule } from 'primeng/toast';

import { ConfigTableComponent } from './components/config-table/config-table.component';
import { ConfigRow } from './models/config-row.model';

interface PropertiesApiResponse {
  rows: ConfigRow[];
  warnings: string[];
  metadata?: {
    scrapedAt?: string;
    authRefreshed?: boolean;
    fromCache?: boolean;
  };
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, ConfigTableComponent, ToastModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  @ViewChild(ConfigTableComponent) private configTable?: ConfigTableComponent;

  rows: ConfigRow[] = [];
  parseWarnings: string[] = [];
  parseError = '';
  isLoading = false;
  lastScrapedAt = '';
  authRefreshed = false;
  loadedFromCache = false;
  /** Hidden via X until next full page load (not persisted). */
  statusBannerDismissed = false;
  isHelpOpen = false;
  private readonly loadTimeoutMs = 90_000;

  constructor(private readonly cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    void this.reloadProperties();
  }

  async reloadProperties(forceLogin = false): Promise<void> {
    const query = forceLogin ? '?forceLogin=1' : '';
    this.isLoading = true;
    this.parseError = '';
    const abortController = new AbortController();
    const timeoutId = globalThis.setTimeout(() => abortController.abort(), this.loadTimeoutMs);

    try {
      const response = await fetch(`/api/properties${query}`, {
        signal: abortController.signal
      });
      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null);
        const backendMessage =
          errorPayload &&
          typeof errorPayload === 'object' &&
          'message' in errorPayload &&
          typeof (errorPayload as { message?: unknown }).message === 'string'
            ? (errorPayload as { message: string }).message
            : `HTTP ${response.status}`;
        const backendDetail =
          errorPayload &&
          typeof errorPayload === 'object' &&
          'detail' in errorPayload &&
          typeof (errorPayload as { detail?: unknown }).detail === 'string'
            ? (errorPayload as { detail: string }).detail
            : '';
        const composed = backendDetail ? `${backendMessage}

${backendDetail}` : backendMessage;
        throw new Error(composed);
      }

      const payload = (await response.json()) as PropertiesApiResponse;
      this.rows = payload.rows ?? [];
      this.parseWarnings = payload.warnings ?? [];
      this.lastScrapedAt = payload.metadata?.scrapedAt ?? '';
      this.authRefreshed = payload.metadata?.authRefreshed ?? false;
      this.loadedFromCache = payload.metadata?.fromCache ?? false;
      this.refreshView();
    } catch (error) {
      this.parseError = error instanceof Error ? error.message : 'Could not load properties.';
      this.rows = [];
      this.parseWarnings = [];
      this.loadedFromCache = false;
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.parseError =
          'Loading timed out. If a login window opened, complete Google sign-in, then click "Re-login + retry".';
      } else {
        this.parseError = error instanceof Error ? error.message : 'Could not load properties.';
      }
      this.refreshView();
    } finally {
      globalThis.clearTimeout(timeoutId);
      this.isLoading = false;
      this.refreshView();
    }
  }

  get isAccountConnected(): boolean {
    return this.configTable?.isAccountConnected ?? false;
  }

  onConnectDisconnectAccountClick(): void {
    if (!this.configTable) {
      return;
    }
    if (this.configTable.isAccountConnected) {
      this.configTable.disconnectAccount();
    } else {
      this.configTable.openConnectAccountDialog();
    }
  }

  dismissStatusBanner(): void {
    this.statusBannerDismissed = true;
    this.refreshView();
  }

  toggleHelpModal(): void {
    this.isHelpOpen = !this.isHelpOpen;
  }

  closeHelpModal(): void {
    this.isHelpOpen = false;
  }

  closeCsvParseErrorDialog(): void {
    this.parseError = '';
  }

  onHelpModalContentClick(event: MouseEvent): void {
    event.stopPropagation();
  }


  /** Stop backdrop close when clicking the dialog panel (loading + error). */
  onCsvImportDialogPanelClick(event: MouseEvent): void {
    event.stopPropagation();
  }

  private refreshView(): void {
    try {
      this.cdr.markForCheck();
      this.cdr.detectChanges();
    } catch {
      // Ignore teardown timing edge cases.
    }
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') {
      return;
    }
    if (this.isHelpOpen) {
      event.preventDefault();
      this.closeHelpModal();
      return;
    }
  }
}

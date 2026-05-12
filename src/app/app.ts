import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, HostListener, OnInit, ViewChild, ElementRef } from '@angular/core';
import { ToastModule } from 'primeng/toast';

import { ConfigTableComponent } from './components/config-table/config-table.component';
import { ConfigRow } from './models/config-row.model';
import { isMergedConfigurationSchema, mapSchemaToRows } from './utils/schema-mapper.util';

type LoadSource = '' | 'bundled' | 'upload';

const BUNDLED_SCHEMA_URL = 'assets/mergedConfigurationSchema_en.json';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, ConfigTableComponent, ToastModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  @ViewChild('schemaFileInput') private readonly schemaFileInputRef?: ElementRef<HTMLInputElement>;

  rows: ConfigRow[] = [];
  parseWarnings: string[] = [];
  parseError = '';
  isLoading = false;
  productVersion = '';
  lastLoadedFrom: LoadSource = '';
  uploadedFileName = '';
  isDropZoneActive = false;
  /** Hidden via X until next full page load (not persisted). */
  statusBannerDismissed = false;
  isHelpOpen = false;

  constructor(private readonly cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    void this.loadBundledSchema();
  }

  async loadBundledSchema(): Promise<void> {
    this.isLoading = true;
    this.parseError = '';

    try {
      const response = await fetch(BUNDLED_SCHEMA_URL);
      if (!response.ok) {
        // 404 (file absent) is a valid empty-state path, not an error.
        this.applyEmptyState();
        return;
      }

      const payload = (await response.json()) as unknown;
      this.applySchema(payload, 'bundled', '');
    } catch {
      // Network failure or invalid JSON — fall back to empty state and let the user upload.
      this.applyEmptyState();
    } finally {
      this.isLoading = false;
      this.refreshView();
    }
  }

  triggerSchemaUpload(): void {
    this.schemaFileInputRef?.nativeElement?.click();
  }

  onSchemaFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (file) {
      void this.readAndApplySchemaFile(file);
    }
    if (input) {
      input.value = '';
    }
  }

  onDropZoneDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDropZoneActive = true;
  }

  onDropZoneDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDropZoneActive = false;
  }

  onDropZoneDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDropZoneActive = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      void this.readAndApplySchemaFile(file);
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

  private async readAndApplySchemaFile(file: File): Promise<void> {
    this.isLoading = true;
    this.parseError = '';
    this.refreshView();
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.parseError = `Could not parse ${file.name}: invalid JSON.`;
        return;
      }
      if (!isMergedConfigurationSchema(parsed)) {
        this.parseError = `${file.name} is not a valid mergedConfigurationSchema file (missing cls = "IConfigurationSchema" or children).`;
        return;
      }
      this.applySchema(parsed, 'upload', file.name);
    } catch (error) {
      this.parseError = error instanceof Error ? error.message : `Could not read ${file.name}.`;
    } finally {
      this.isLoading = false;
      this.refreshView();
    }
  }

  private applySchema(payload: unknown, loadedFrom: LoadSource, fileName: string): void {
    const result = mapSchemaToRows(payload);
    this.rows = result.rows;
    this.parseWarnings = result.warnings;
    this.productVersion = result.productVersion;
    this.lastLoadedFrom = loadedFrom;
    this.uploadedFileName = loadedFrom === 'upload' ? fileName : '';
    this.statusBannerDismissed = false;
  }

  private applyEmptyState(): void {
    this.rows = [];
    this.parseWarnings = [];
    this.productVersion = '';
    this.lastLoadedFrom = '';
    this.uploadedFileName = '';
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
    }
  }
}

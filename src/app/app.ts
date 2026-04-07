import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, HostListener } from '@angular/core';

import { ConfigTableComponent } from './components/config-table/config-table.component';
import { ConfigRow, CsvParseFileResult } from './models/config-row.model';
import { CsvParserService } from './services/csv-parser.service';

type UploadSlot = 1 | 2;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, ConfigTableComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  rows: ConfigRow[] = [];
  parseWarnings: string[] = [];
  parseError = '';
  fileLabel1 = '';
  fileLabel2 = '';
  isParsing = false;
  draggingSlot: UploadSlot | null = null;
  isHelpOpen = false;

  private slot1Parsed: CsvParseFileResult | null = null;
  private slot2Parsed: CsvParseFileResult | null = null;

  constructor(
    private readonly csvParserService: CsvParserService,
    private readonly cdr: ChangeDetectorRef
  ) {}

  async onFileSelected(event: Event, slot: UploadSlot): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    await this.loadFileIntoSlot(slot, file);
    input.value = '';
  }

  onDragOver(event: DragEvent, slot: UploadSlot): void {
    event.preventDefault();
    this.draggingSlot = slot;
  }

  onDragLeave(event: DragEvent, slot: UploadSlot): void {
    event.preventDefault();
    if (this.draggingSlot === slot) {
      this.draggingSlot = null;
    }
  }

  async onDrop(event: DragEvent, slot: UploadSlot): Promise<void> {
    event.preventDefault();
    this.draggingSlot = null;
    const file = event.dataTransfer?.files?.[0];

    if (!file) {
      return;
    }

    await this.loadFileIntoSlot(slot, file);
  }

  clearSlot(slot: UploadSlot): void {
    this.parseError = '';
    if (slot === 1) {
      this.slot1Parsed = null;
      this.fileLabel1 = '';
    } else {
      this.slot2Parsed = null;
      this.fileLabel2 = '';
    }
    this.applyMerge();
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

  onCsvParseErrorBackdropClick(): void {
    this.closeCsvParseErrorDialog();
  }

  /** Stop backdrop close when clicking the dialog panel (loading + error). */
  onCsvImportDialogPanelClick(event: MouseEvent): void {
    event.stopPropagation();
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
    if (this.parseError) {
      event.preventDefault();
      this.closeCsvParseErrorDialog();
    }
  }

  get slot1RowCount(): number {
    return this.slot1Parsed?.rows.length ?? 0;
  }

  get slot2RowCount(): number {
    return this.slot2Parsed?.rows.length ?? 0;
  }

  private async loadFileIntoSlot(slot: UploadSlot, file: File): Promise<void> {
    this.isParsing = true;
    this.parseError = '';
    this.cdr.detectChanges();

    const rowKeyPrefix = slot === 1 ? 'slot1' : 'slot2';

    try {
      const result = await this.csvParserService.parseFile(file, {
        displayLabel: file.name,
        rowKeyPrefix
      });
      if (slot === 1) {
        this.slot1Parsed = result;
        this.fileLabel1 = file.name;
      } else {
        this.slot2Parsed = result;
        this.fileLabel2 = file.name;
      }
      this.applyMerge();
    } catch (error) {
      this.parseError =
        error instanceof Error ? error.message : 'The CSV file could not be parsed.';
    } finally {
      this.isParsing = false;
    }
    this.cdr.detectChanges();
  }

  private applyMerge(): void {
    const merged = this.csvParserService.mergeParsedFiles(this.slot1Parsed, this.slot2Parsed);
    this.rows = merged.rows;
    this.parseWarnings = merged.warnings;
  }
}

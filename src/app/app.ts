import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';

import { ConfigTableComponent } from './components/config-table/config-table.component';
import { ConfigRow } from './models/config-row.model';
import { CsvParserService } from './services/csv-parser.service';

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
  currentFileName = '';
  isParsing = false;
  isDragging = false;

  constructor(private readonly csvParserService: CsvParserService) {}

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    await this.loadFile(file);
    input.value = '';
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragging = true;
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isDragging = false;
  }

  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.isDragging = false;
    const file = event.dataTransfer?.files?.[0];

    if (!file) {
      return;
    }

    await this.loadFile(file);
  }

  resetData(): void {
    this.rows = [];
    this.parseWarnings = [];
    this.parseError = '';
    this.currentFileName = '';
  }

  private async loadFile(file: File): Promise<void> {
    this.isParsing = true;
    this.parseError = '';

    try {
      const result = await this.csvParserService.parse(file);
      this.rows = result.rows;
      this.parseWarnings = result.warnings;
      this.currentFileName = file.name;
    } catch (error) {
      this.rows = [];
      this.parseWarnings = [];
      this.currentFileName = '';
      this.parseError = error instanceof Error ? error.message : 'The CSV file could not be parsed.';
    } finally {
      this.isParsing = false;
    }
  }
}

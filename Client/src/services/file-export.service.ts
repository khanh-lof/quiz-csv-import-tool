import { Injectable } from '@angular/core';
import { GimkitCsvBuilder } from './gimkit-csv-builder';
import { BlooketCsvBuilder } from './blooket-csv-builder';
import { QuestionDefinition } from '../models/question-definition';
import { ExportType } from '../models/export-type';
import { WaygroundCsvBuilder } from './wayground-csv-builder';
import * as XLSX from 'xlsx';

// What an export built. For Wayground it also carries the .xlsx itself, so the same file (with the
// same randomly drawn wrong answers) can be handed to the QuizTool browser extension.
export interface ExportedFile {
  fileName: string;
  xlsx?: Uint8Array;
}

@Injectable({
  providedIn: 'root',
})
export class FileExportService {

  constructor(private readonly gimKitCsvBuilder: GimkitCsvBuilder,
              private readonly blooketCsvBuilder: BlooketCsvBuilder,
              private readonly waygroundCsvBuilder: WaygroundCsvBuilder) {
  }

  // Both exports return the file they built (Wayground's becomes .xlsx), or null when there was nothing
  // to export. The file is downloaded unless `download` is false, as when the extension takes the
  // Wayground file instead.
  public exportFile(filename: string, rows: QuestionDefinition[], exportType: ExportType = ExportType.GimKit,
                    download = true): ExportedFile | null {
    if (!rows || !rows.length) return null;

    const csvResult = this.buildCsvStringForExportTypeFromRows(exportType, rows);
    return this.buildFile(filename, csvResult, exportType, download);
  }

  public exportFileFromCsvContent(filename: string, csvContent: string, exportType: ExportType = ExportType.GimKit,
                                  download = true): ExportedFile | null {
    if (!csvContent || !csvContent.length) return null;

    const csvResult = this.buildCsvStringForExportTypeFromCsvContent(exportType, csvContent);
    return this.buildFile(filename, csvResult, exportType, download);
  }

  public downloadXlsx(fileName: string, xlsx: Uint8Array): void {
    this.downloadBlob(fileName, new Blob([xlsx as BlobPart],
      {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  }

  public static platformName(exportType: ExportType): string {
    switch (exportType) {
      case ExportType.GimKit:
        return 'Gimkit';
      case ExportType.Blooket:
        return 'Blooket';
      case ExportType.Wayground:
        return 'Wayground';
      default:
        return 'Quiz';
    }
  }

  // A download name that says what the file is, e.g. "HSK3-Bai5-Gimkit.csv". Characters a file system
  // rejects are dropped and spaces become dashes.
  public static buildFileName(label: string, exportType: ExportType): string {
    const safeLabel = label.replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '-') || 'QuizTool';
    return `${safeLabel}-${FileExportService.platformName(exportType)}.csv`;
  }

  // Reads the CSV text into a workbook and writes it back out as .xlsx bytes.
  public static buildXlsx(csvData: string): Uint8Array {
    const workbook = XLSX.read(csvData, { type: 'string' });
    return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }));
  }

  private buildCsvStringForExportTypeFromRows(exportType: ExportType, rows: QuestionDefinition[]) {
    switch (exportType) {
      case ExportType.GimKit:
        return this.gimKitCsvBuilder.buildFromRows(rows);
      case ExportType.Blooket:
        return this.blooketCsvBuilder.buildFromRows(rows);
      case ExportType.Wayground:
        return this.waygroundCsvBuilder.buildFromRows(rows);
      default:
        throw new Error(`Unsupported export type: ${exportType}`);
    }
  }
  private buildCsvStringForExportTypeFromCsvContent(exportType: ExportType, csvContent: string): string {
    switch (exportType) {
      case ExportType.GimKit:
        return this.gimKitCsvBuilder.buildFromCsvContent(csvContent);
      case ExportType.Blooket:
        return this.blooketCsvBuilder.buildFromCsvContent(csvContent);
      case ExportType.Wayground:
        return this.waygroundCsvBuilder.buildFromCsvContent(csvContent);
      default:
        throw new Error(`Unsupported export type: ${exportType}`);
    }
  }

  private downloadBlob(filename: string, blob: Blob) {
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  private buildFile(filename: string, csvResult: string, exportType: ExportType, download: boolean): ExportedFile {
    switch (exportType) {
      case ExportType.Wayground: {
        const xlsx = FileExportService.buildXlsx(csvResult);
        const xlsxName = filename.replace(/\.csv$/i, '') + '.xlsx';
        if (download) this.downloadXlsx(xlsxName, xlsx);
        return {fileName: xlsxName, xlsx};
      }
      case ExportType.GimKit:
      case ExportType.Blooket:
      default:
        if (download) this.downloadBlob(filename, new Blob([csvResult], {type: 'text/csv;charset=utf-8'}));
        return {fileName: filename};
    }
  }
}

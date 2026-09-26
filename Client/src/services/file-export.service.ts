import { Injectable } from '@angular/core';
import { GimkitCsvBuilder } from './gimkit-csv-builder';
import { BlooketCsvBuilder } from './blooket-csv-builder';
import { QuestionDefinition } from '../models/question-definition';
import { ExportType } from '../models/export-type';
import { WaygroundCsvBuilder } from './wayground-csv-builder';
import * as XLSX from 'xlsx';

@Injectable({
  providedIn: 'root',
})
export class FileExportService {

  constructor(private readonly gimKitCsvBuilder: GimkitCsvBuilder,
              private readonly blooketCsvBuilder: BlooketCsvBuilder,
              private readonly waygroundCsvBuilder: WaygroundCsvBuilder) {
  }

  // Both exports return the name the file was downloaded under (Wayground's becomes .xlsx), or null
  // when there was nothing to export.
  public exportFile(filename: string, rows: QuestionDefinition[], exportType: ExportType = ExportType.GimKit): string | null {
    if (!rows || !rows.length) return null;

    const csvResult = this.buildCsvStringForExportTypeFromRows(exportType, rows);
    return this.download(filename, csvResult, exportType);
  }

  public exportFileFromCsvContent(filename: string, csvContent: string, exportType: ExportType = ExportType.GimKit): string | null {
    if (!csvContent || !csvContent.length) return null;

    const csvResult = this.buildCsvStringForExportTypeFromCsvContent(exportType, csvContent);
    return this.download(filename, csvResult, exportType);
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

  private convertCsvToXlsx(csvData: string, originalName: string): string {
    // 1. Read the CSV text string into a temporary workbook object
    const workbook = XLSX.read(csvData, { type: 'string' });

    // 2. Derive a fresh output name by stripping out the .csv extension
    const outputFileName = originalName.replace(/\.csv$/i, '') + '.xlsx';

    // 3. Write the file out and automatically trigger a client-side download
    XLSX.writeFile(workbook, outputFileName);
    return outputFileName;
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

  private downloadCsv(filename: string, csvResult: string) {

    // Create blob using FileSaver
    const blob = new Blob([csvResult], {type: 'text/csv;charset=utf-8'});
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  private download(filename: string, csvResult: string, exportType: ExportType): string {
    switch (exportType) {
      case ExportType.Wayground:
        return this.convertCsvToXlsx(csvResult, filename);
      case ExportType.GimKit:
      case ExportType.Blooket:
      default:
        this.downloadCsv(filename, csvResult);
        return filename;
    }
  }
}

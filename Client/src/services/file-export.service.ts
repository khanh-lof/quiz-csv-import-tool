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

  public exportFile(filename: string, rows: QuestionDefinition[], exportType: ExportType = ExportType.GimKit) {
    if (!rows || !rows.length) return;

    const csvResult = this.buildCsvStringForExportTypeFromRows(exportType, rows);
    this.download(filename, csvResult, exportType);
  }

  public exportFileFromCsvContent(filename: string, csvContent: string, exportType: ExportType = ExportType.GimKit) {
    if (!csvContent || !csvContent.length) return;

    const csvResult = this.buildCsvStringForExportTypeFromCsvContent(exportType, csvContent);
    this.download(filename, csvResult, exportType);
  }
  private convertCsvToXlsx(csvData: string, originalName: string): void {
    // 1. Read the CSV text string into a temporary workbook object
    const workbook = XLSX.read(csvData, { type: 'string' });

    // 2. Derive a fresh output name by stripping out the .csv extension
    const outputFileName = originalName.replace(/\.csv$/i, '') + '.xlsx';

    // 3. Write the file out and automatically trigger a client-side download
    XLSX.writeFile(workbook, outputFileName);
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

  private download(filename: string, csvResult: string, exportType: ExportType) {
    switch (exportType) {
      case ExportType.GimKit:
      case ExportType.Blooket:
        this.downloadCsv(filename, csvResult);
        break;
      case ExportType.Wayground:
        this.convertCsvToXlsx(csvResult, filename);
        break;
    }
  }
}

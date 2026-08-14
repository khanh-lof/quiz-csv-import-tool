import { Injectable } from '@angular/core';
import {ExportType, QuestionDefinition} from '../components/vocabulary-table/vocabulary-table';
import {GimkitCsvBuilder} from './gimkit-csv-builder';
import {BlooketCsvBuilder} from './blooket-csv-builder';
@Injectable({
  providedIn: 'root',
})
export class CsvExportService {

  constructor(private readonly gimKitCsvBuilder: GimkitCsvBuilder, private readonly blooketCsvBuilder: BlooketCsvBuilder) {
  }
  public exportToCsv(filename: string, rows: QuestionDefinition[], exportType: ExportType = ExportType.GimKit) {
    if (!rows || !rows.length) return;

    const csvResult = this.BuildCsvStringForExportType(exportType, rows);

    // Create blob using FileSaver
    const blob = new Blob([csvResult], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  private BuildCsvStringForExportType(exportType: ExportType, rows: QuestionDefinition[]) {
    switch (exportType) {
      case ExportType.GimKit:
        return this.gimKitCsvBuilder.build(rows);
      case ExportType.Blooket:
        return this.blooketCsvBuilder.build(rows);
    }
  }
}

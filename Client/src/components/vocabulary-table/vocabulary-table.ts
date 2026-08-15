import { Component, DestroyRef, ElementRef, QueryList, ViewChildren } from '@angular/core';
import { CommonModule, NgTemplateOutlet } from '@angular/common';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzTableModule } from 'ng-zorro-antd/table';
import {
  AbstractControl,
  FormArray,
  FormBuilder,
  FormControl,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  ValidationErrors,
  ValidatorFn,
  Validators
} from '@angular/forms';
import { NzInputDirective } from 'ng-zorro-antd/input';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzOptionComponent, NzSelectComponent } from 'ng-zorro-antd/select';
import { CsvExportService } from '../../services/csv-export.service';
import { Utils } from '../../utils';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { CsvImportService } from '../../services/csv-import.service';
import { ImageImportPopupComponent } from './image-import-popup/image-import-popup.component';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

export interface QuestionDefinition {
  question: string;
  answer: string;
}

export interface QuestionDefinitionForm {
  question: FormControl<string>;
  answer: FormControl<string>;
}

export enum ExportType {
  GimKit,
  Blooket
}

@Component({
  selector: 'app-vocabulary-table',
  imports: [
    CommonModule,
    NzButtonComponent,
    NzTableModule,
    FormsModule,
    NzInputDirective,
    NzIconDirective,
    NzSelectComponent,
    NzOptionComponent,
    ReactiveFormsModule,
    NgTemplateOutlet,
    NzModalModule
  ],
  templateUrl: './vocabulary-table.html',
  styleUrl: './vocabulary-table.css',
})
export class VocabularyTable {
  protected listOfData: FormGroup<QuestionDefinitionForm>[];

  protected get questionForms() {
    return this.formGroup.get('listOfData') as FormArray<FormGroup<QuestionDefinitionForm>>;
  }

  protected readonly ExportType = ExportType;

  protected readonly minRows = 4;

  protected readonly duplicateErrorKey = 'duplicate';

  formGroup: FormGroup;

  @ViewChildren('rowSourceInputs') rowSourceInputs!: QueryList<ElementRef>;

  constructor(private readonly csvExportService: CsvExportService,
              private readonly csvImportService: CsvImportService,
              private readonly notificationService: NzNotificationService,
              private readonly modalService: NzModalService,
              private readonly destroyRef: DestroyRef,
              formBuilder: FormBuilder) {
    this.formGroup = formBuilder.group({
      listOfData: formBuilder.array<FormGroup<QuestionDefinitionForm>>(this.createDefaultQuestionFormGroups(), [Validators.minLength(this.minRows), this.duplicateValidator]),
      exportType: new FormControl<ExportType | null>(null, [Validators.required])
    });
    this.listOfData = this.questionForms.controls;

    // Prevent default drag/drop behavior on document to avoid opening files in new tab
    if (typeof document !== 'undefined') {
      document.addEventListener('dragover', (e) => e.preventDefault(), false);
      document.addEventListener('drop', (e) => e.preventDefault(), false);
    }
  }

  addRow() {
    this.questionForms.push(this.createQuestionFormGroup());
    this.refreshTable();
    // Wait for DOM update then focus the last input
    setTimeout(() => {
      const inputs = this.rowSourceInputs.toArray();
      const lastInput = inputs[inputs.length - 1];
      lastInput.nativeElement.focus();
    });
  }

  importFromCsv(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const content = reader.result as string;
      const rows = this.csvImportService.parseCsv(content);

      if (!rows.length) {
        this.notificationService.warning('Không có dữ liệu', 'File CSV không có dữ liệu hợp lệ để nhập.', {nzPlacement: 'top'});
        return;
      }

      this.applyImportedRows(rows);
    };

    reader.readAsText(file);
    input.value = '';
  }

  openImagePopup(): void {
    const modalRef = this.modalService.create({
      nzTitle: 'Nhập từ ảnh',
      nzContent: ImageImportPopupComponent,
      nzFooter: null,
      nzWidth: '720px',
      nzCentered: true,
      nzMaskClosable: true
    });

    const componentInstance = modalRef.componentInstance as ImageImportPopupComponent;
    componentInstance.importedRows.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe((rows: QuestionDefinition[]) => {
      this.applyImportedRows(rows);
    });
  }

  private applyImportedRows(rows: QuestionDefinition[]) {
    this.removeEmptyControls();
    rows.forEach((row) => {
      this.questionForms.push(this.createQuestionFormGroupWithValues(row.question, row.answer));
    });

    this.refreshTable();
    this.notificationService.success('Nhập thành công', `Đã nhập ${rows.length} dòng.`, {nzPlacement: 'top'});

    setTimeout(() => {
      const inputs = this.rowSourceInputs.toArray();
      const firstInput = inputs[0];
      firstInput?.nativeElement.focus();
    });
  }

  private refreshTable() {
    this.listOfData = [...this.questionForms.controls];
    this.formGroup.updateValueAndValidity();
  }

  deleteRow(index: number) {
    this.questionForms.removeAt(index);
    this.refreshTable();
  }

  exportCsv() {
    this.formGroup.markAllAsDirty();
    if (this.formGroup.invalid) {
      this.notificationService.error('Tập trung vàoooo', 'Nhập cho đúng kàaaa', {nzPlacement: 'top'});
      return;
    }
    this.csvExportService.exportToCsv("NhapFileName.csv", this.listOfData.map(x => ({
      answer: x.controls.answer.value,
      question: x.controls.question.value
    } as QuestionDefinition)), this.formGroup.get('exportType')?.value);
  }

  private createQuestionFormGroup(): FormGroup<QuestionDefinitionForm> {
    return this.createQuestionFormGroupWithValues('', '');
  }

  private createQuestionFormGroupWithValues(question: string, answer: string): FormGroup<QuestionDefinitionForm> {
    return new FormGroup<QuestionDefinitionForm>({
      question: new FormControl<string>(question, [Validators.required]),
      answer: new FormControl<string>(answer, [Validators.required]),
    } as QuestionDefinitionForm);
  }

  private duplicateValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
    const formArray = control as FormArray<FormGroup<QuestionDefinitionForm>>;
    const questionMap = new Map<string, FormGroup<QuestionDefinitionForm>[]>();
    const answerMap = new Map<string, FormGroup<QuestionDefinitionForm>[]>();

    // Build lookup maps
    formArray.controls.forEach(group => {
      const question = group.controls.question.value?.trim();
      const answer = group.controls.answer.value?.trim();

      if (question) {
        if (!questionMap.has(question)) questionMap.set(question, []);
        questionMap.get(question)!.push(group);
      }

      if (answer) {
        if (!answerMap.has(answer)) answerMap.set(answer, []);
        answerMap.get(answer)!.push(group);
      }
    });

    let hasAnyDuplicate = false;

    // First remove all previous duplicate errors
    formArray.controls.forEach(g => {
      Utils.removeError(g.controls.question, this.duplicateErrorKey);
      Utils.removeError(g.controls.answer, this.duplicateErrorKey);
    });

    // Apply new duplicate errors
    for (const groups of questionMap.values()) {
      if (groups.length > 1) {
        hasAnyDuplicate = true;
        for (const g of groups) Utils.addError(g.controls.question, this.duplicateErrorKey);
      }
    }

    for (const groups of answerMap.values()) {
      if (groups.length > 1) {
        hasAnyDuplicate = true;
        for (const g of groups) Utils.addError(g.controls.answer, this.duplicateErrorKey);
      }
    }

    return hasAnyDuplicate ? {duplicateExists: true} : null;
  };

  protected deleteAllRows() {
    this.questionForms.clear();
    for (const defaultQuestionFormGroup of this.createDefaultQuestionFormGroups()) {
      this.questionForms.push(defaultQuestionFormGroup);
    }
    this.refreshTable();
  }

  private removeEmptyControls(): void {
    for (const emptyControl of this.questionForms.controls.filter(x => x.controls.question.value === '' && x.controls.answer.value === '')) {
      this.questionForms.removeAt(this.questionForms.controls.indexOf(emptyControl));
    }
  }

  private createDefaultQuestionFormGroups(formCount: number = this.minRows): FormGroup<QuestionDefinitionForm>[] {
    const forms: FormGroup<QuestionDefinitionForm>[] = [];
    for (let i = 0; i < formCount; i++) {
      forms.push(this.createQuestionFormGroup());
    }
    return forms;
  }
}


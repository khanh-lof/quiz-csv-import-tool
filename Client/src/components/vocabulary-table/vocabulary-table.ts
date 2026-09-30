import { Component, DestroyRef, ElementRef, OnInit, QueryList, ViewChildren, ChangeDetectionStrategy } from '@angular/core';
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
import { FileExportService } from '../../services/file-export.service';
import { Utils } from '../../utils';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { CsvImportService } from '../../services/csv-import.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { QuestionDefinitionForm } from '../../models/question-definition-form';
import { QuestionDefinition } from '../../models/question-definition';
import { ExportType } from '../../models/export-type';
import { QuestionType } from '../../models/question-type';
import { CdkTextareaAutosize } from '@angular/cdk/text-field';
import { debounceTime } from 'rxjs';
import { PendingImportService } from '../../services/pending-import.service';
import { WaygroundExtensionService } from '../../services/wayground-extension.service';
import { UsageGuide } from '../usage-guide/usage-guide';
import { NzContentComponent, NzLayoutComponent, NzSiderComponent } from 'ng-zorro-antd/layout';

// The table's rows and chosen template, kept in the browser so a reload or a visit to another screen
// (the AI page, the login) does not lose what the user typed.
const DRAFT_STORAGE_KEY = 'vocabulary-table-draft';

interface TableDraft {
  rows: QuestionDefinition[];
  exportType: ExportType | null;
}

@Component({
  selector: 'app-vocabulary-table',
  imports: [
    CommonModule,
    UsageGuide,
    NzLayoutComponent,
    NzSiderComponent,
    NzContentComponent,
    NzButtonComponent,
    NzTableModule,
    FormsModule,
    NzInputDirective,
    NzIconDirective,
    NzSelectComponent,
    NzOptionComponent,
    ReactiveFormsModule,
    NgTemplateOutlet,
    NzModalModule,
    CdkTextareaAutosize
  ],
  templateUrl: './vocabulary-table.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './vocabulary-table.css',
})
export class VocabularyTable implements OnInit {
  protected listOfData: FormGroup<QuestionDefinitionForm>[];

  protected get questionForms() {
    return this.formGroup.get('listOfData') as FormArray<FormGroup<QuestionDefinitionForm>>;
  }

  protected readonly ExportType = ExportType;

  protected readonly minRows = 4;

  protected readonly duplicateErrorKey = 'duplicate';

  formGroup: FormGroup;

  @ViewChildren('rowSourceInputs') rowSourceInputs!: QueryList<ElementRef>;

  constructor(private readonly fileExportService: FileExportService,
              private readonly csvImportService: CsvImportService,
              private readonly notificationService: NzNotificationService,
              private readonly modalService: NzModalService,
              private readonly destroyRef: DestroyRef,
              private readonly pendingImportService: PendingImportService,
              private readonly waygroundExtensionService: WaygroundExtensionService,
              formBuilder: FormBuilder) {
    this.formGroup = formBuilder.group({
      listOfData: formBuilder.array<FormGroup<QuestionDefinitionForm>>(this.createDefaultQuestionFormGroups(), [Validators.minLength(this.minRows), this.duplicateValidator]),
      exportType: new FormControl<ExportType | null>(null, [Validators.required])
    });
    this.restoreDraft();
    this.listOfData = this.questionForms.controls;
    this.formGroup.valueChanges.pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.saveDraft());
  }

  private restoreDraft(): void {
    let draft: TableDraft | null = null;
    try {
      draft = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) ?? 'null');
    } catch {
      return;
    }
    if (!draft) {
      return;
    }
    const rows = (draft.rows ?? []).filter(row => row.question || row.answer);
    if (rows.length) {
      this.questionForms.clear();
      rows.forEach(row => this.questionForms.push(
        this.createQuestionFormGroupWithValues(row.question ?? '', row.answer ?? '', row.questionType ?? QuestionType.MultipleChoice)));
      for (let i = rows.length; i < this.minRows; i++) {
        this.questionForms.push(this.createQuestionFormGroup());
      }
    }
    this.formGroup.patchValue({exportType: draft.exportType ?? null});
  }

  private saveDraft(): void {
    const draft: TableDraft = {rows: this.currentRows(), exportType: this.formGroup.get('exportType')?.value ?? null};
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch {
      // Keeping the draft is only a convenience.
    }
  }

  private currentRows(): QuestionDefinition[] {
    return this.questionForms.controls.map(x => ({
      question: x.controls.question.value,
      answer: x.controls.answer.value,
      questionType: x.controls.questionType.value
    } as QuestionDefinition));
  }

  // Rows the AI page generated in its formatted mode arrive here to be reviewed before export.
  ngOnInit(): void {
    const rows = this.pendingImportService.take();
    if (rows?.length) {
      this.applyImportedRows(rows);
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

  exportFile() {
    const exportTypeControl = this.formGroup.get('exportType')!;
    if (exportTypeControl.value === null) {
      exportTypeControl.markAsDirty();
      this.notificationService.error('Chưa chọn template', 'Chọn Gimkit, Blooket hoặc Wayground trước khi tải file nhé.', {nzPlacement: 'top'});
      return;
    }
    // Rows left completely empty are ignored rather than blocking the export, as long as enough real
    // rows remain for the builders to draw wrong answers from.
    const filledRowCount = this.questionForms.controls.filter(x => !this.isEmptyRow(x)).length;
    if (filledRowCount < this.minRows) {
      this.notificationService.error('Chưa đủ câu hỏi',
        `Cần ít nhất ${this.minRows} câu hỏi có đáp án để tạo đáp án sai cho mỗi câu.`, {nzPlacement: 'top'});
      return;
    }
    this.removeEmptyControls();
    this.refreshTable();

    this.formGroup.markAllAsDirty();
    if (this.formGroup.invalid) {
      const message = this.questionForms.hasError('duplicateExists')
        ? 'Có câu hỏi hoặc đáp án bị trùng, sửa lại chỗ báo đỏ nhé.'
        : 'Còn ô trống, điền nốt chỗ báo đỏ nhé.';
      this.notificationService.error('Tập trung vàoooo', message, {nzPlacement: 'top'});
      return;
    }
    const exportType: ExportType = exportTypeControl.value;
    const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD in local time
    const title = `QuizTool-${today}`;
    const exported = this.fileExportService.exportFile(
      FileExportService.buildFileName(title, exportType), this.currentRows(), exportType);
    if (!exported) return;
    if (exported.xlsx && this.waygroundExtensionService.isInstalled()) {
      this.waygroundExtensionService.sendImport(title, exported.fileName, exported.xlsx);
      this.notificationService.success('Đang mở Wayground để import…',
        `Đã tải ${exported.fileName}. Kiểm tra câu hỏi trong tab Wayground vừa mở rồi bấm Publish nhé.`, {nzPlacement: 'top'});
      return;
    }
    this.notificationService.success('Tải file thành công',
      `Đã tải ${exported.fileName}, import vào ${FileExportService.platformName(exportType)} là dùng được nhaa.`, {nzPlacement: 'top'});
  }

  private isEmptyRow(row: FormGroup<QuestionDefinitionForm>): boolean {
    return !row.controls.question.value?.trim() && !row.controls.answer.value?.trim();
  }
  private createQuestionFormGroup(): FormGroup<QuestionDefinitionForm> {
    return this.createQuestionFormGroupWithValues('', '');
  }

  private createQuestionFormGroupWithValues(question: string, answer: string, questionType: QuestionType = QuestionType.MultipleChoice): FormGroup<QuestionDefinitionForm> {
    return new FormGroup<QuestionDefinitionForm>({
      question: new FormControl<string>(question, [Validators.required]),
      answer: new FormControl<string>(answer, [Validators.required]),
      questionType: new FormControl(questionType, [Validators.required])
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

  protected confirmDeleteAllRows() {
    if (this.questionForms.controls.every(x => this.isEmptyRow(x))) {
      this.deleteAllRows();
      return;
    }
    this.modalService.confirm({
      nzTitle: 'Xóa tất cả câu hỏi?',
      nzContent: 'Toàn bộ câu hỏi và đáp án trong bảng sẽ bị xóa.',
      nzOkText: 'Xóa',
      nzOkDanger: true,
      nzClassName: 'qt-confirm-danger',
      nzIconType: 'delete',
      nzCancelText: 'Giữ lại',
      nzCentered: true,
      nzOnOk: () => this.deleteAllRows()
    });
  }

  private deleteAllRows() {
    this.questionForms.clear();
    for (const defaultQuestionFormGroup of this.createDefaultQuestionFormGroups()) {
      this.questionForms.push(defaultQuestionFormGroup);
    }
    this.refreshTable();
  }

  private removeEmptyControls(): void {
    for (const emptyControl of this.questionForms.controls.filter(x => this.isEmptyRow(x))) {
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

  protected readonly QuestionType = QuestionType;
}


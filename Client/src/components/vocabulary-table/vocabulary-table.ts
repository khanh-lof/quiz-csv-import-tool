import { Component, DestroyRef, ElementRef, OnInit, QueryList, ViewChildren, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
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
import { ImageImportPopup } from './image-import-popup/image-import-popup';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { QuestionDefinitionForm } from '../../models/question-definition-form';
import { QuestionDefinition } from '../../models/question-definition';
import { ExportType } from '../../models/export-type';
import { QuestionType } from '../../models/question-type';
import { CdkTextareaAutosize } from '@angular/cdk/text-field';
import { AuthService } from '../../services/auth.service';

// Query param telling the table to open the AI popup on arrival, set when the login screen sends the user back.
const OPEN_AI_POPUP_PARAM = 'openAi';

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
              private readonly authService: AuthService,
              private readonly router: Router,
              private readonly route: ActivatedRoute,
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

  ngOnInit(): void {
    if (!this.route.snapshot.queryParamMap.has(OPEN_AI_POPUP_PARAM)) {
      return;
    }
    // Drop the param so a reload or a later visit does not open the popup again; open it only once that
    // navigation is done, so it cannot close the popup.
    this.router.navigate([], {relativeTo: this.route, queryParams: {[OPEN_AI_POPUP_PARAM]: null}, replaceUrl: true})
      .then(() => {
        if (this.authService.hasAccessToken()) {
          this.openImagePopup();
        }
      });
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

  // The rest of the table works anonymously; only AI generation needs an account (the server requires a
  // token on that endpoint), so an anonymous user is asked to log in and brought back with the popup open.
  openImagePopup(): void {
    if (!this.authService.hasAccessToken()) {
      this.modalService.confirm({
        nzTitle: 'Cần đăng nhập',
        nzContent: 'Tính năng tạo câu hỏi bằng AI cần đăng nhập. Đăng nhập ngay nhé?',
        nzOkText: 'Đăng nhập',
        nzCancelText: 'Để sau',
        nzCentered: true,
        nzOnOk: () => {
          this.router.navigate(['/login'], {queryParams: {returnUrl: `/quiz?${OPEN_AI_POPUP_PARAM}=1`}});
        }
      });
      return;
    }

    const modalRef = this.modalService.create({
      nzTitle: 'Tạo câu hỏi bằng AI',
      nzContent: ImageImportPopup,
      nzFooter: null,
      nzWidth: '720px',
      nzCentered: true,
      nzMaskClosable: true
    });

    const componentInstance = modalRef.componentInstance as ImageImportPopup;
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

  exportFile() {
    this.formGroup.markAllAsDirty();
    if (this.formGroup.invalid) {
      this.notificationService.error('Tập trung vàoooo', 'Nhập cho đúng kàaaa', {nzPlacement: 'top'});
      return;
    }
    this.fileExportService.exportFile("NhapFileName.csv", this.listOfData.map(x => ({
      answer: x.controls.answer.value,
      question: x.controls.question.value,
      questionType: x.controls.questionType.value
    } as QuestionDefinition)), this.formGroup.get('exportType')?.value);
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

  protected readonly QuestionType = QuestionType;
}


import { Component, DestroyRef, Directive, HostListener, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { Router } from '@angular/router';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { AiCsvService } from '../../services/ai-csv.service';
import { AiJobService } from '../../services/ai-job.service';
import { NzInputNumberComponent } from 'ng-zorro-antd/input-number';
import { NzCheckboxGroupComponent, NzCheckboxOption } from 'ng-zorro-antd/checkbox';
import {
  AbstractControl,
  ControlContainer,
  FormBuilder, FormControl,
  FormGroup,
  FormsModule, ReactiveFormsModule,
  ValidationErrors,
  ValidatorFn,
  Validators
} from '@angular/forms';
import { NzRadioComponent, NzRadioGroupComponent } from 'ng-zorro-antd/radio';
import { AIGenerationMode } from '../../models/aigeneration-mode';
import { Utils } from '../../utils';
import { AiGenerationRequest } from '../../models/ai-generation-request';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NzOptionComponent, NzSelectComponent } from 'ng-zorro-antd/select';
import { NzInputDirective } from 'ng-zorro-antd/input';
import { ExportType } from '../../models/export-type';
import { CourseType } from '../../models/course-type';
import { HskStandard, hskMaxLevel } from '../../models/hsk-standard';
import {
  ALL_GESTURE_STAGES,
  gestureStagesOf,
  QUESTIONS_PER_STAGE_DEFAULT,
  QUESTIONS_PER_STAGE_MAX,
  QUESTIONS_PER_STAGE_MIN,
  questionsPerStageOf
} from '../../models/gesture-quiz-options';
import { STAGES } from '../../game/stages';
import { finalize } from 'rxjs';
import { NzSpinComponent } from 'ng-zorro-antd/spin';
import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { ImageCompressionService, UploadTooLargeError } from '../../services/image-compression.service';
import { UsageGuide } from '../usage-guide/usage-guide';
import { NzContentComponent, NzLayoutComponent } from 'ng-zorro-antd/layout';

interface ImageItem {
  file: File;
  preview: string;
}
// The page's choices, remembered between visits so a teacher going lesson by lesson does not
// re-enter the course, level and platform every time.
const SETTINGS_STORAGE_KEY = 'ai-generation-settings';
// Polls without a running job to wait out after submitting, since the new job may not show up in the first one.
const NEW_JOB_IDLE_POLLS = 3;

// ng-zorro's checkbox keeps an ngModel on its own inner <input>, and Angular warns (NG01354) about every one of
// them when the checkbox sits inside a [formGroup], as the games' group does. That input is not meant to join
// the form: this hides the form from it, so it stays quiet. The group itself is bound with [formControl],
// which needs no container.
@Directive({
  selector: '[appOutsideFormContainer]',
  providers: [{provide: ControlContainer, useValue: null}]
})
class OutsideFormContainer {
}

interface AiGenerationForm {
  courseType: FormControl<CourseType | null>;
  courseName: FormControl<string | null>;
  hskStandard: FormControl<HskStandard | null>;
  level: FormControl<number | null>;
  lessonNumber: FormControl<number | null>;
  AIMode: FormControl<AIGenerationMode | null>;
  exportType: FormControl<ExportType | null>;
  intelligence: FormControl<number | null>;
  // Only for a Quiz cử chỉ: the stage numbers of the games the quiz has, and the questions each gets.
  gestureStages: FormControl<number[] | null>;
  questionsPerStage: FormControl<number | null>;
}

@Component({
  selector: 'app-ai-generation',
  imports: [
    CommonModule,
    UsageGuide,
    NzLayoutComponent,
    NzContentComponent,
    NzButtonComponent,
    NzIconDirective,
    FormsModule,
    NzRadioGroupComponent,
    NzRadioComponent,
    NzInputNumberComponent,
    NzCheckboxGroupComponent,
    OutsideFormContainer,
    ReactiveFormsModule,
    NzOptionComponent,
    NzSelectComponent,
    NzInputDirective,
    NzSpinComponent
  ],
  templateUrl: './ai-generation.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './ai-generation.css'
})
export class AiGeneration {
  // Signals, not plain fields, so a change made from an async callback (FileReader, HTTP) re-renders
  // right away.
  protected readonly selectedImages = signal<ImageItem[]>([]);
  protected isDragOver = false;
  protected readonly isGenerating = signal(false);
  protected dragEnterCounter = 0;

  protected readonly AIGenerationMode = AIGenerationMode;
  protected formGroup: FormGroup<AiGenerationForm>;
  private requiredIfAIAutoMode: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
    const aiGenerationForm = control as FormGroup<AiGenerationForm>;
    const isAutoMode = aiGenerationForm.controls.AIMode.value === AIGenerationMode.Auto;
    const courseType = aiGenerationForm.controls.courseType.value;

    this.setRequired(aiGenerationForm.controls.exportType, isAutoMode);
    this.setRequired(aiGenerationForm.controls.courseType, isAutoMode);
    this.setRequired(aiGenerationForm.controls.lessonNumber, isAutoMode);
    // HSK and YCT always have a level; a course typed in by hand may not, so there the level is optional.
    this.setRequired(aiGenerationForm.controls.level, isAutoMode && courseType !== null && courseType !== CourseType.Other);
    this.setRequired(aiGenerationForm.controls.courseName, isAutoMode && courseType === CourseType.Other);
    // The level box caps what is typed, but switching HSK 3.0 back to 2.0 can leave a level 7 to 9 behind.
    const level = aiGenerationForm.controls.level.value;
    this.setError(aiGenerationForm.controls.level, 'max', isAutoMode && courseType === CourseType.Hsk && level !== null
      && level > hskMaxLevel(aiGenerationForm.controls.hskStandard.value));
    // The game and question-count controls are only on the page for a Quiz cử chỉ; for any other platform
    // they are hidden, so they must not block the form.
    const isGestureQuiz = isAutoMode && aiGenerationForm.controls.exportType.value === ExportType.GestureQuiz;
    this.setRequired(aiGenerationForm.controls.gestureStages, isGestureQuiz);
    this.setRequired(aiGenerationForm.controls.questionsPerStage, isGestureQuiz);
    return null;
  };

  private setRequired(control: AbstractControl, isRequired: boolean): void {
    this.setError(control, 'required', isRequired && Validators.required(control) !== null);
  }

  private setError(control: AbstractControl, errorKey: string, hasError: boolean): void {
    if (hasError) {
      Utils.addError(control, errorKey);
    }
    else {
      Utils.removeError(control, errorKey);
    }
  }

  constructor(
    private readonly router: Router,
    private readonly aiCsvService: AiCsvService,
    private readonly aiJobService: AiJobService,
    private readonly imageCompressionService: ImageCompressionService,
    private readonly notificationService: NzNotificationService,
    private readonly destroyRef: DestroyRef,
    formBuilder: FormBuilder
  ) {
    this.formGroup = formBuilder.group<AiGenerationForm>({
      AIMode: formBuilder.control<AIGenerationMode | null>(AIGenerationMode.Auto, Validators.required),
      courseType: formBuilder.control<CourseType | null>(null),
      courseName: formBuilder.control<string | null>(null),
      hskStandard: formBuilder.control<HskStandard | null>(HskStandard.V2),
      level: formBuilder.control<number | null>(null),
      lessonNumber: formBuilder.control<number | null>(null),
      exportType: formBuilder.control<ExportType | null>(null),
      intelligence: formBuilder.control<number | null>(1),
      gestureStages: formBuilder.control<number[] | null>([...ALL_GESTURE_STAGES]),
      questionsPerStage: formBuilder.control<number | null>(QUESTIONS_PER_STAGE_DEFAULT),
    },{
      validators : [this.requiredIfAIAutoMode]
    })
    this.restoreSettings();
  }

  private restoreSettings(): void {
    try {
      const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (saved) {
        const settings = JSON.parse(saved);
        // The two quiz options go through their sanitizers: a save from before they existed, or one
        // that was edited or corrupted, still gives a form the server will accept.
        this.formGroup.patchValue({
          ...settings,
          gestureStages: gestureStagesOf(settings?.gestureStages),
          questionsPerStage: questionsPerStageOf(settings?.questionsPerStage),
        });
      }
    } catch {
      // Storage unavailable or corrupted: start from the defaults.
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this.formGroup.getRawValue()));
    } catch {
      // Remembering the settings is only a convenience.
    }
  }

  // True while the request is being prepared and uploaded; the server's work on it is not waited for.
  private setGenerating(isGenerating: boolean): void {
    this.isGenerating.set(isGenerating);
  }

  onDropZoneEnter(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragEnterCounter++;
    this.isDragOver = true;
  }

  onDropZoneDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  onDropZoneDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragEnterCounter--;
    if (this.dragEnterCounter <= 0) {
      this.isDragOver = false;
      this.dragEnterCounter = 0;
    }
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;
    this.dragEnterCounter = 0;
    if (this.isGenerating()) {
      return;
    }

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }

    this.processImageFiles(Array.from(files));
  }

  // Listens on the whole document so Ctrl+V works as soon as the page is open, without clicking the
  // drop zone first. Only a paste carrying images is taken over; pasting text into a field still works.
  @HostListener('document:paste', ['$event'])
  onPaste(event: ClipboardEvent): void {
    const items = event.clipboardData?.items;
    if (!items || this.isGenerating()) {
      return;
    }

    const pastedFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          pastedFiles.push(file);
        }
      }
    }

    if (pastedFiles.length > 0) {
      event.preventDefault();
      this.processImageFiles(pastedFiles);
    }
  }

  importFromImage(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;

    if (!files || files.length === 0) {
      return;
    }

    this.processImageFiles(Array.from(files));
    input.value = '';
  }

  private processImageFiles(files: File[]): void {
    const validFiles = files.filter(file => {
      if (!file.type.startsWith('image/')) {
        this.notificationService.error('File không hợp lệ', `${file.name} không phải là ảnh.`, {nzPlacement: 'top'});
        return false;
      }
      return true;
    });

    validFiles.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const preview = reader.result as string;
        // Compared by content, not name/size/date: every paste yields a fresh "image.png" stamped with
        // the current time, so pasting the same image twice would otherwise slip through.
        if (this.selectedImages().some(x => x.preview === preview)) {
          this.notificationService.error('Ảnh trùng lặp', `${file.name} đã được thêm trước đó.`, {nzPlacement: 'top'});
          return;
        }
        this.selectedImages.update(images => [...images, { file, preview }]);
      };
      reader.readAsDataURL(file);
    });
  }

  removeImage(index: number): void {
    this.selectedImages.update(images => images.filter((_, i) => i !== index));
  }

  clearAllImages(): void {
    this.selectedImages.set([]);
  }

  async generate(): Promise<void> {
    this.formGroup.markAllAsDirty();
    this.formGroup.updateValueAndValidity();
    if (this.formGroup.invalid) {
      this.notificationService.error('Tập trung vàoooo', 'Nhập đủ thông tin ei', {nzPlacement: 'top'});
      return;
    }
    // Only the formatted mode needs images: the creative mode can work from the lesson identifiers alone.
    if (this.selectedImages().length === 0 && this.formGroup.controls.AIMode.value === AIGenerationMode.Formatted) {
      this.notificationService.warning('Thiếu ảnh', 'Chế độ này cần ít nhất 1 ảnh bài học.', {nzPlacement: 'top'});
      return;
    }

    this.saveSettings();
    this.setGenerating(true);

    let imageFiles: File[];
    try {
      imageFiles = await this.imageCompressionService.compressForUpload(this.selectedImages().map(img => img.file));
    } catch (err) {
      this.setGenerating(false);
      this.showGenerationError(err);
      return;
    }
    const isFormatted = this.formGroup.controls.AIMode.value === AIGenerationMode.Formatted;
    const submit$ = isFormatted
      ? this.aiCsvService.submitFormatted(imageFiles, `Từ ảnh (${imageFiles.length} ảnh)`)
      : this.aiCsvService.submitCreative(imageFiles, {
        courseType: this.formGroup.controls.courseType.value,
        courseName: this.formGroup.controls.courseName.value,
        hskStandard: this.formGroup.controls.hskStandard.value,
        level: this.formGroup.controls.level.value,
        AIMode: this.formGroup.controls.AIMode.value,
        lessonNumber: this.formGroup.controls.lessonNumber.value,
        exportType: this.formGroup.controls.exportType.value,
        intelligence: this.formGroup.controls.intelligence.value,
        gestureStages: this.formGroup.controls.gestureStages.value,
        questionsPerStage: this.formGroup.controls.questionsPerStage.value,
      } satisfies AiGenerationRequest, this.lessonLabel());
    submit$.pipe(takeUntilDestroyed(this.destroyRef), finalize(() => this.setGenerating(false))).subscribe({
      next: () => {
        // From here the server works on its own: the page may be left or closed, and the history tab
        // follows the job.
        this.clearAllImages();
        this.notificationService.info('Đã gửi yêu cầu',
          'AI đang tạo trên máy chủ, bạn có thể làm việc khác hoặc đóng trang. Kết quả sẽ hiện ở tab Lịch sử AI.',
          {nzPlacement: 'top'});
        // The first polls can come before the job is visible, so keep polling a little longer than usual.
        this.aiJobService.watch(NEW_JOB_IDLE_POLLS);
      },
      error: err => this.showGenerationError(err),
    });
  }

  // Names the lesson for the download, e.g. "HSK3-Bai5" (HSK 2.0), "HSK3.0-3-Bai5", or "Boya-Bai2" for a
  // course typed in by hand.
  private lessonLabel(): string {
    const {courseType, courseName, hskStandard, level, lessonNumber} = this.formGroup.getRawValue();
    const course = courseType === CourseType.Hsk ? (hskStandard === HskStandard.V3 ? 'HSK3.0-' : 'HSK')
      : courseType === CourseType.Yct ? 'YCT'
      : (courseName ?? '');
    return `${course}${level ?? ''}-Bai${lessonNumber ?? ''}`;
  }

  // Only what can go wrong before the server accepts the job. A job that fails later (AI error, timeout)
  // is reported by AiJobService when the history table sees it fail.
  private showGenerationError(err: unknown): void {
    const status = err instanceof HttpErrorResponse ? err.status : null;
    const serverMessage = err instanceof HttpErrorResponse && typeof err.error === 'string' ? err.error.trim() : '';
    if (status === HttpStatusCode.Unauthorized) {
      this.notificationService.warning('Hết phiên đăng nhập', 'Vui lòng đăng nhập lại để tiếp tục tạo câu hỏi.', {nzPlacement: 'top'});
      this.setGenerating(false);
      this.router.navigate(['/login'], {queryParams: {returnUrl: '/ai'}});
      return;
    }
    if (status === HttpStatusCode.Forbidden) {
      // The server answers 403 both for the per-user AI rate limit (with a message) and for a role
      // that may not use AI (empty body).
      if (serverMessage) {
        this.notificationService.warning('Hết lượt dùng AI',
          'Bạn đã dùng hết lượt tạo câu hỏi bằng AI cho lúc này. Vui lòng thử lại sau ít phút.',
          {nzPlacement: 'top', nzDuration: 0});
      } else {
        this.notificationService.error('Không có quyền', 'Tài khoản của bạn chưa được cấp quyền dùng AI.', {nzPlacement: 'top'});
      }
      return;
    }
    if (status === 0) {
      this.notificationService.error('Mất kết nối',
        'Không thể kết nối đến máy chủ. Vui lòng kiểm tra mạng rồi thử lại.', {nzPlacement: 'top'});
      return;
    }
    if (status === HttpStatusCode.BadRequest && serverMessage) {
      this.notificationService.error('Yêu cầu không hợp lệ', serverMessage, {nzPlacement: 'top'});
      return;
    }
    if (err instanceof UploadTooLargeError || status === HttpStatusCode.PayloadTooLarge) {
      this.notificationService.error('Ảnh quá lớn',
        'Tổng dung lượng ảnh vượt quá giới hạn tải lên. Vui lòng giảm số lượng ảnh rồi thử lại.',
        {nzPlacement: 'top', nzDuration: 0});
      return;
    }
    this.notificationService.error('Lỗi tạo câu hỏi', err instanceof Error ? err.message : 'Không thể tạo câu hỏi.', {nzPlacement: 'top'});
  }

  protected get submitButtonLabel(): string {
    if (this.isGenerating()) {
      return 'Đang gửi...';
    }
    return this.selectedImages().length > 0
      ? `Tạo câu hỏi (${this.selectedImages().length} ảnh)`
      : 'Tạo câu hỏi';
  }

  protected readonly ExportType = ExportType;
  protected readonly CourseType = CourseType;
  protected readonly HskStandard = HskStandard;
  protected readonly questionsPerStageMin = QUESTIONS_PER_STAGE_MIN;
  protected readonly questionsPerStageMax = QUESTIONS_PER_STAGE_MAX;

  // One checkbox per game, easiest first; the value is the stage number the game is known by everywhere.
  protected readonly gestureStageOptions: NzCheckboxOption[] = STAGES.map(def => ({
    label: `${def.icon} ${def.name}`,
    value: def.stage,
  }));

  // Tells the teacher what the choice makes: the games are played easiest first, each as one màn.
  protected get gestureQuizHint(): string {
    const intro = 'Quiz chơi ngay trên QuizTool bằng camera';
    const stageCount = this.formGroup.controls.gestureStages.value?.length ?? 0;
    const perStage = this.formGroup.controls.questionsPerStage.value;
    if (stageCount === 0 || perStage === null) {
      // The messages above say what is missing; there is no count to announce yet.
      return `${intro}.`;
    }
    return stageCount === 1
      ? `${intro}: 1 màn, ${perStage} câu.`
      : `${intro}: ${stageCount} màn từ dễ đến khó, ${perStage} câu mỗi màn (${stageCount * perStage} câu).`;
  }

  protected get maxLevel(): number {
    return this.formGroup.controls.courseType.value === CourseType.Hsk
      ? hskMaxLevel(this.formGroup.controls.hskStandard.value)
      : 9;
  }
}

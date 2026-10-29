import { ChangeDetectionStrategy, Component, DestroyRef, Directive, HostListener, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { Router } from '@angular/router';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { AiCsvService } from '../../services/ai-csv.service';
import { AiJobService, NEW_JOB_IDLE_POLLS } from '../../services/ai-job.service';
import { NzInputNumberComponent } from 'ng-zorro-antd/input-number';
import { NzCheckboxGroupComponent, NzCheckboxOption } from 'ng-zorro-antd/checkbox';
import {
  AbstractControl,
  ControlContainer,
  FormBuilder,
  FormControl,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
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
import { hskMaxLevel, HskStandard } from '../../models/hsk-standard';
import { Textbook, textbookFor } from '../../models/textbook';
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
import { WaygroundExtensionService } from '../../services/wayground-extension.service';
import { NzContentComponent, NzLayoutComponent } from 'ng-zorro-antd/layout';

interface ImageItem {
  file: File;
  preview: string;
}

// The page's choices, remembered between visits so a teacher going lesson by lesson does not
// re-enter the course, level and platform every time.
const SETTINGS_STORAGE_KEY = 'ai-generation-settings';

// ng-zorro's checkbox keeps an ngModel on its own inner <input>, and Angular warns (NG01354) about every one of
// them when the checkbox sits inside a [formGroup], as the games' group does. That input is not meant to join
// the form: this hides the form from it, so it stays quiet. The group itself is bound with [formControl],
// which needs no container.
@Directive({
  selector: '[appOutsideFormContainer]',
  providers: [{
    provide: ControlContainer,
    useValue: null
  }]
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
  // Only for a Game: the stage numbers of the games the quiz has, and the questions each gets.
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

  constructor(
    private readonly router: Router,
    private readonly aiCsvService: AiCsvService,
    private readonly aiJobService: AiJobService,
    private readonly imageCompressionService: ImageCompressionService,
    private readonly notificationService: NzNotificationService,
    private readonly destroyRef: DestroyRef,
    private readonly waygroundExtensionService: WaygroundExtensionService,
    formBuilder: FormBuilder
  ) {
    this.formGroup = formBuilder.group<AiGenerationForm>({
      AIMode: formBuilder.control<AIGenerationMode | null>(AIGenerationMode.Auto, Validators.required),
      courseType: formBuilder.control<CourseType | null>(null),
      courseName: formBuilder.control<string | null>(null),
      // 3.0 by default: the textbooks the server holds are all HSK 3.0.
      hskStandard: formBuilder.control<HskStandard | null>(HskStandard.V3),
      level: formBuilder.control<number | null>(null),
      lessonNumber: formBuilder.control<number | null>(null),
      exportType: formBuilder.control<ExportType | null>(null),
      intelligence: formBuilder.control<number | null>(1),
      gestureStages: formBuilder.control<number[] | null>([...ALL_GESTURE_STAGES]),
      questionsPerStage: formBuilder.control<number | null>(QUESTIONS_PER_STAGE_DEFAULT),
    }, {
      validators: [this.requiredIfAIAutoMode]
    })
    this.restoreSettings();
  }

  protected downloadExtension(event: Event): void {
    event.preventDefault();
    this.waygroundExtensionService.downloadExtension();
  }

  protected get submitButtonLabel(): string {
    if (this.isGenerating()) {
      return 'Đang gửi...';
    }
    return this.selectedImages().length > 0
      ? `Tạo câu hỏi (${this.selectedImages().length} ảnh)`
      : 'Tạo câu hỏi';
  }

  // Tells the teacher what the choice makes: the games are played easiest first, each as one màn.
  protected get gestureQuizHint(): string {
    const stageCount = this.formGroup.controls.gestureStages.value?.length ?? 0;
    const perStage = this.formGroup.controls.questionsPerStage.value;
    if (stageCount === 0 || perStage === null) {
      return '';
    }
    return `${stageCount} màn, ${stageCount * perStage} câu.`;
  }

  protected get maxLevel(): number {
    return this.formGroup.controls.courseType.value === CourseType.Hsk
      ? hskMaxLevel(this.formGroup.controls.hskStandard.value)
      : 9;
  }

  // The book of the chosen course, if the server holds one: its lessons are used instead of photos.
  protected get textbook(): Textbook | undefined {
    return this.textbookOf(this.formGroup);
  }

  protected get maxLesson(): number {
    return this.textbook?.lessons ?? 100;
  }

  // Listens on the whole document so Ctrl+V works as soon as the page is open, without clicking the

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

  // Names the lesson for the download, e.g. "HSK3-Bai5" (HSK 2.0), "HSK3.0-3-Bai5", or "Boya-Bai2" for a

  removeImage(index: number): void {
    this.selectedImages.update(images => images.filter((_, i) => i !== index));
  }

  // Only what can go wrong before the server accepts the job. A job that fails later (AI error, timeout)

  clearAllImages(): void {
    this.selectedImages.set([]);
  }

  async generate(): Promise<void> {
    this.formGroup.markAllAsDirty();
    this.formGroup.updateValueAndValidity();
    if (this.formGroup.invalid) {
      this.notificationService.error('Thiếu thông tin', 'Nhập đủ thông tin.', { nzPlacement: 'top' });
      return;
    }
    // Only the formatted mode needs images: the creative mode can work from the lesson identifiers alone.
    if (this.selectedImages().length === 0 && this.formGroup.controls.AIMode.value === AIGenerationMode.Formatted) {
      this.notificationService.warning('Thiếu ảnh', 'Cần ít nhất 1 ảnh.', { nzPlacement: 'top' });
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
          'Kết quả ở AI › Lịch sử.',
          { nzPlacement: 'top' });
        // The first polls can come before the job is visible, so keep polling a little longer than usual.
        this.aiJobService.watch(NEW_JOB_IDLE_POLLS);
      },
      error: err => this.showGenerationError(err),
    });
  }

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
    // A course with a textbook has as many lessons as the book; switching from HSK 3.0 level 3 (18 lessons) to
    // level 1 can leave a lesson 16 to 18 behind, which the server would refuse.
    const lesson = aiGenerationForm.controls.lessonNumber.value;
    const book = this.textbookOf(aiGenerationForm);
    this.setError(aiGenerationForm.controls.lessonNumber, 'max', isAutoMode && book !== undefined && lesson !== null
      && lesson > book.lessons);
    // The game and question-count controls are only on the page for a Game; for any other platform
    // they are hidden, so they must not block the form.
    const isGestureQuiz = isAutoMode && aiGenerationForm.controls.exportType.value === ExportType.GestureQuiz;
    this.setRequired(aiGenerationForm.controls.gestureStages, isGestureQuiz);
    this.setRequired(aiGenerationForm.controls.questionsPerStage, isGestureQuiz);
    return null;
  };

  private textbookOf(form: FormGroup<AiGenerationForm>): Textbook | undefined {
    const {
      courseType,
      hskStandard,
      level
    } = form.controls;
    return textbookFor(courseType.value, hskStandard.value, level.value);
  }

  private setRequired(control: AbstractControl, isRequired: boolean): void {
    this.setError(control, 'required', isRequired && Validators.required(control) !== null);
  }

  private setError(control: AbstractControl, errorKey: string, hasError: boolean): void {
    if (hasError) {
      Utils.addError(control, errorKey);
    } else {
      Utils.removeError(control, errorKey);
    }
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

  private processImageFiles(files: File[]): void {
    const validFiles = files.filter(file => {
      if (!file.type.startsWith('image/')) {
        this.notificationService.error('File không hợp lệ', file.name, { nzPlacement: 'top' });
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
          this.notificationService.error('Ảnh trùng lặp', file.name, { nzPlacement: 'top' });
          return;
        }
        this.selectedImages.update(images => [...images, {
          file,
          preview
        }]);
      };
      reader.readAsDataURL(file);
    });
  }

  // course typed in by hand.
  private lessonLabel(): string {
    const {
      courseType,
      courseName,
      hskStandard,
      level,
      lessonNumber
    } = this.formGroup.getRawValue();
    const course = courseType === CourseType.Hsk ? (hskStandard === HskStandard.V3 ? 'HSK3.0-' : 'HSK')
      : courseType === CourseType.Yct ? 'YCT'
        : (courseName ?? '');
    return `${course}${level ?? ''}-Bai${lessonNumber ?? ''}`;
  }

  // is reported by AiJobService when the history table sees it fail.
  private showGenerationError(err: unknown): void {
    const status = err instanceof HttpErrorResponse ? err.status : null;
    const serverMessage = err instanceof HttpErrorResponse && typeof err.error === 'string' ? err.error.trim() : '';
    if (status === HttpStatusCode.Unauthorized) {
      this.notificationService.warning('Hết phiên đăng nhập', 'Đăng nhập lại để tiếp tục.', { nzPlacement: 'top' });
      this.setGenerating(false);
      this.router.navigate(['/login'], { queryParams: { returnUrl: '/ai' } });
      return;
    }
    if (status === HttpStatusCode.Forbidden) {
      // The server answers 403 both for the per-user AI rate limit (with a message) and for a role
      // that may not use AI (empty body).
      if (serverMessage) {
        this.notificationService.warning('Hết lượt dùng AI',
          'Thử lại sau ít phút.',
          {
            nzPlacement: 'top',
            nzDuration: 0
          });
      } else {
        this.notificationService.error('Không có quyền', 'Tài khoản chưa có quyền dùng AI.', { nzPlacement: 'top' });
      }
      return;
    }
    if (status === 0) {
      this.notificationService.error('Mất kết nối',
        'Kiểm tra mạng rồi thử lại.', { nzPlacement: 'top' });
      return;
    }
    if (status === HttpStatusCode.BadRequest && serverMessage) {
      this.notificationService.error('Yêu cầu không hợp lệ', serverMessage, { nzPlacement: 'top' });
      return;
    }
    if (err instanceof UploadTooLargeError || status === HttpStatusCode.PayloadTooLarge) {
      this.notificationService.error('Ảnh quá lớn',
        'Giảm số ảnh rồi thử lại.',
        {
          nzPlacement: 'top',
          nzDuration: 0
        });
      return;
    }
    this.notificationService.error('Lỗi tạo câu hỏi', err instanceof Error ? err.message : 'Không thể tạo câu hỏi.', { nzPlacement: 'top' });
  }
}

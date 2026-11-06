import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { Router } from '@angular/router';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { AiCsvService } from '../../services/ai-csv.service';
import { notifyAiRefusal } from '../../services/ai-refusal';
import { MessagePipe, Messages } from '../../i18n/messages';
import { httpFailure } from '../../models/http-failure';
import { AiJobService, NEW_JOB_IDLE_POLLS } from '../../services/ai-job.service';
import { NzInputNumberComponent } from 'ng-zorro-antd/input-number';
import { NzTooltipDirective } from 'ng-zorro-antd/tooltip';
import {
  AbstractControl,
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
import { CourseType, courseHasLevels } from '../../models/course-type';
import { hskMaxLevel, HskStandard } from '../../models/hsk-standard';
import { DEFAULT_LESSON_UNIT, Textbook, textbookFor } from '../../models/textbook';
import {
  LANGUAGES,
  LanguageSpec,
  languageSpec,
  offersExportType,
  QuizLanguage,
  quizLanguageOf,
  teachesCourse
} from '../../models/quiz-language';
import {
  ALL_GESTURE_STAGES,
  gestureStagesOf,
  QUESTIONS_PER_STAGE_DEFAULT,
  QUESTIONS_PER_STAGE_MAX,
  QUESTIONS_PER_STAGE_MIN,
  questionsPerStageOf
} from '../../models/gesture-quiz-options';
import { formatLessonNumbers, lessonNumbersOf, MAX_LESSONS } from '../../models/lesson-numbers';
import { stagePosition, STAGES } from '../../game/stages';
import { finalize } from 'rxjs';
import { NzSpinComponent } from 'ng-zorro-antd/spin';
import { HttpStatusCode } from '@angular/common/http';
import { ImageCompressionService, UploadTooLargeError } from '../../services/image-compression.service';
import { UsageGuide } from '../usage-guide/usage-guide';
import { WaygroundExtensionService } from '../../services/wayground-extension.service';
import { escapeHtml } from '../../services/escape-html';
import { NzContentComponent, NzLayoutComponent } from 'ng-zorro-antd/layout';
import { NzTagComponent } from 'ng-zorro-antd/tag';
import { GestureStageCard } from '../gesture-play/stage-card/stage-card';

interface ImageItem {
  file: File;
  preview: string;
}

// The page's choices, remembered between visits so a teacher going lesson by lesson does not
// re-enter the course, level and platform every time.
const SETTINGS_STORAGE_KEY = 'ai-generation-settings';

// The choices each language keeps for itself, so switching language and back loses nothing. The mode and the
// intelligence stay the teacher's whatever the language.
const LANGUAGE_CHOICES = ['courseType', 'courseName', 'hskStandard', 'level', 'lessonNumbers', 'exportType', 'gestureStages',
  'questionsPerStage'] as const;

interface AiGenerationForm {
  language: FormControl<QuizLanguage | null>;
  courseType: FormControl<CourseType | null>;
  courseName: FormControl<string | null>;
  hskStandard: FormControl<HskStandard | null>;
  level: FormControl<number | null>;
  lessonNumbers: FormControl<number[] | null>;
  AIMode: FormControl<AIGenerationMode | null>;
  exportType: FormControl<ExportType | null>;
  intelligence: FormControl<number | null>;
  // Only for a Game: the stage numbers of the games the quiz has, and the questions each gets.
  gestureStages: FormControl<number[] | null>;
  questionsPerStage: FormControl<number | null>;
}

interface PlatformOption {
  value: ExportType;
  label: string;
  icon: string;
  logo?: string;
  // What the teacher gets from the job.
  output: string;
}

const PLATFORMS: readonly PlatformOption[] = [
  { value: ExportType.GimKit, label: 'Gimkit', icon: 'thunderbolt', logo: 'platforms/gimkit.png', output: 'File CSV' },
  { value: ExportType.Blooket, label: 'Blooket', icon: 'appstore', logo: 'platforms/blooket.png', output: 'File CSV' },
  { value: ExportType.Wayground, label: 'Wayground', icon: 'global', logo: 'platforms/wayground.png', output: 'File Excel' },
  { value: ExportType.GestureQuiz, label: 'Game', icon: 'camera', output: 'Chơi bằng camera' },
  { value: ExportType.Radicals, label: 'Ghép bộ thủ', icon: 'build', output: 'Trang bài tập' },
];

type LanguageChoices =Pick<ReturnType<FormGroup<AiGenerationForm>['getRawValue']>, typeof LANGUAGE_CHOICES[number]>;

@Component({
  selector: 'kt-quiz-ai-generation',
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
    NzTagComponent,
    GestureStageCard,
    ReactiveFormsModule,
    NzOptionComponent,
    NzSelectComponent,
    NzInputDirective,
    NzSpinComponent,
    NzTooltipDirective,
    MessagePipe
  ],
  templateUrl: './ai-generation.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['../gesture-play/game-themes.css', './ai-generation.css']
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
  protected readonly courseHasLevels = courseHasLevels;
  protected readonly HskStandard = HskStandard;
  protected readonly languages = LANGUAGES;
  protected readonly questionsPerStageMin = QUESTIONS_PER_STAGE_MIN;
  protected readonly questionsPerStageMax = QUESTIONS_PER_STAGE_MAX;
  protected readonly maxLessons = MAX_LESSONS;
  // One card per game, easiest first.
  protected readonly stages = STAGES;

  private readonly messages = inject(Messages);
  private readonly choicesByLanguage = new Map<QuizLanguage, LanguageChoices>();
  private readonly defaultChoices: LanguageChoices;
  // The language whose choices the form holds, which `choicesByLanguage` gets back when another one is chosen.
  private shownLanguage = QuizLanguage.Chinese;

  // The options are rebuilt only when `lessonOptionsKey` changes, so the select is not handed a new list on every check.
  private lessonOptionsKey = '';
  private lessonOptionsList: number[] = [];

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
      language: formBuilder.control<QuizLanguage | null>(QuizLanguage.Chinese),
      AIMode: formBuilder.control<AIGenerationMode | null>(AIGenerationMode.Auto, Validators.required),
      courseType: formBuilder.control<CourseType | null>(null),
      courseName: formBuilder.control<string | null>(null),
      // 3.0 by default: the textbooks the server holds are all HSK 3.0.
      hskStandard: formBuilder.control<HskStandard | null>(HskStandard.V3),
      level: formBuilder.control<number | null>(null),
      lessonNumbers: formBuilder.control<number[] | null>([]),
      exportType: formBuilder.control<ExportType | null>(null),
      intelligence: formBuilder.control<number | null>(1),
      gestureStages: formBuilder.control<number[] | null>([...ALL_GESTURE_STAGES]),
      questionsPerStage: formBuilder.control<number | null>(QUESTIONS_PER_STAGE_DEFAULT),
    }, {
      validators: [this.requiredIfAIAutoMode]
    })
    this.defaultChoices = this.currentChoices();
    this.restoreSettings();
    this.showLanguageChoices();
    this.formGroup.controls.language.valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(language => this.switchLanguage(language));
  }

  protected get language(): LanguageSpec {
    return languageSpec(this.formGroup.controls.language.value);
  }

  protected offers(exportType: ExportType): boolean {
    return offersExportType(this.formGroup.controls.language.value, exportType);
  }

  protected get isAutoMode(): boolean {
    return this.formGroup.controls.AIMode.value === AIGenerationMode.Auto;
  }

  protected get platforms(): readonly PlatformOption[] {
    return PLATFORMS.filter(platform => this.offers(platform.value));
  }

  protected downloadExtension(event: Event): void {
    event.preventDefault();
    this.waygroundExtensionService.downloadExtension();
  }

  protected get submitButtonLabel(): string {
    if (this.isGenerating()) {
      return 'Đang gửi…';
    }
    return this.shownImages.length > 0
      ? `Tạo câu hỏi (${this.shownImages.length} ảnh)`
      : 'Tạo câu hỏi';
  }

  protected isGestureStageChosen(stage: number): boolean {
    return this.formGroup.controls.gestureStages.value?.includes(stage) ?? false;
  }

  // "Màn N" as the quiz will number the game, by its place among the chosen ones; none for a game left out.
  protected gestureStageLabel(stage: number): string | null {
    const chosen = this.formGroup.controls.gestureStages.value ?? [];
    return chosen.includes(stage) ? `Màn ${stagePosition(chosen, stage)}` : null;
  }

  protected toggleGestureStage(stage: number): void {
    const control = this.formGroup.controls.gestureStages;
    const chosen = control.value ?? [];
    control.setValue(chosen.includes(stage)
      ? chosen.filter(other => other !== stage)
      : [...chosen, stage].sort((a, b) => a - b));
    control.markAsDirty();
  }

  // HSK has its standard's levels; any other course up to 12, the school grades of an English course.
  protected get maxLevel(): number {
    return this.formGroup.controls.courseType.value === CourseType.Hsk
      ? hskMaxLevel(this.formGroup.controls.hskStandard.value)
      : 12;
  }

  // The book of the chosen course, if the server holds one: its lessons are used instead of photos.
  protected get textbook(): Textbook | undefined {
    return this.textbookOf(this.formGroup);
  }

  // A course with a book needs no photo, so the photos are shut.
  protected get photosDisabled(): boolean {
    return this.isAutoMode && this.textbook !== undefined;
  }

  // Why they are shut, in the zone's tooltip and its accessible name.
  protected get photosDisabledReason(): string | null {
    return this.photosDisabled ? this.messages.get('ai.form.textbookHasBook', { title: this.textbook?.title ?? '' }) : null;
  }

  // The photos shown and sent: none while they are shut, though those added before the book was picked are kept
  // for a course without one.
  protected get shownImages(): ImageItem[] {
    return this.photosDisabled ? [] : this.selectedImages();
  }

  protected get maxLesson(): number {
    return this.textbook?.lessons ?? 100;
  }

  // "Bài", or what the book calls its lessons ("Topic").
  protected get lessonUnit(): string {
    return this.textbook?.lessonUnit ?? DEFAULT_LESSON_UNIT;
  }

  protected lessonOptionLabel(lesson: number): string {
    const name = this.textbook?.lessonNames?.[lesson - 1];
    return name === undefined ? String(lesson) : `${lesson}. ${name}`;
  }

  // 1 to the book's lessons, plus any chosen lesson past them (left over from another level): the select hides
  // a value that has no option, so without its option the teacher could not see or remove what the form refuses.
  protected get lessonOptions(): number[] {
    const max = this.maxLesson;
    const leftOver = (this.formGroup.controls.lessonNumbers.value ?? []).filter(lesson => lesson > max);
    const key = [max, ...leftOver].join(',');
    if (key !== this.lessonOptionsKey) {
      this.lessonOptionsKey = key;
      this.lessonOptionsList = [...Array.from({ length: max }, (_, index) => index + 1), ...leftOver];
    }
    return this.lessonOptionsList;
  }

  onDropZoneEnter(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.photosDisabled) {
      return;
    }
    this.dragEnterCounter++;
    this.isDragOver = true;
  }

  // Prevented even while the photos are shut, so a file dropped there is not opened by the browser.
  onDropZoneDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.photosDisabled && event.dataTransfer) {
      event.dataTransfer.dropEffect = 'none';
    }
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
    if (this.isGenerating() || this.photosDisabled) {
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
    if (!items || this.isGenerating() || this.photosDisabled) {
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
      return;
    }
    // Only the formatted mode needs images: the creative mode can work from the lesson identifiers alone.
    if (this.selectedImages().length === 0 && this.formGroup.controls.AIMode.value === AIGenerationMode.Formatted) {
      this.notificationService.warning(this.messages.get('ai.form.needImage'), '');
      return;
    }

    this.saveSettings();
    this.setGenerating(true);

    let imageFiles: File[];
    try {
      imageFiles = await this.imageCompressionService.compressForUpload(this.shownImages.map(img => img.file));
    } catch (err) {
      this.setGenerating(false);
      this.showGenerationError(err);
      return;
    }
    const isFormatted = this.formGroup.controls.AIMode.value === AIGenerationMode.Formatted;
    const submit$ = isFormatted
      ? this.aiCsvService.submitFormatted(imageFiles, `Từ (${imageFiles.length} ảnh)`, this.language.value)
      : this.aiCsvService.submitCreative(imageFiles, {
        language: this.language.value,
        courseType: this.formGroup.controls.courseType.value,
        courseName: this.formGroup.controls.courseName.value,
        hskStandard: this.formGroup.controls.hskStandard.value,
        level: this.formGroup.controls.level.value,
        AIMode: this.formGroup.controls.AIMode.value,
        lessonNumbers: this.formGroup.controls.lessonNumbers.value,
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
        this.aiJobService.notifySent();
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
    this.setRequired(aiGenerationForm.controls.lessonNumbers, isAutoMode);
    // HSK and YCT always have a level; a course typed in by hand may not, so there the level is optional, and a
    // single-book course has none.
    this.setRequired(aiGenerationForm.controls.level,
      isAutoMode && courseType !== null && courseType !== CourseType.Other && courseHasLevels(courseType));
    this.setRequired(aiGenerationForm.controls.courseName, isAutoMode && courseType === CourseType.Other);
    // The level box caps what is typed, but switching HSK 3.0 back to 2.0 can leave a level 7 to 9 behind.
    const level = aiGenerationForm.controls.level.value;
    this.setError(aiGenerationForm.controls.level, 'max', isAutoMode && courseType === CourseType.Hsk && level !== null
      && level > hskMaxLevel(aiGenerationForm.controls.hskStandard.value));
    // A course with a textbook has as many lessons as the book; switching from HSK 3.0 level 3 (18 lessons) to
    // level 1 can leave a lesson 16 to 18 behind, which the server would refuse.
    const lessons = aiGenerationForm.controls.lessonNumbers.value ?? [];
    const book = this.textbookOf(aiGenerationForm);
    this.setError(aiGenerationForm.controls.lessonNumbers, 'max', isAutoMode && book !== undefined
      && lessons.some(lesson => lesson > book.lessons));
    // The game and question-count controls are only on the page for a Game; for any other platform
    // they are hidden, so they must not block the form.
    const isGestureQuiz = isAutoMode && aiGenerationForm.controls.exportType.value === ExportType.GestureQuiz;
    this.setRequired(aiGenerationForm.controls.gestureStages, isGestureQuiz);
    this.setRequired(aiGenerationForm.controls.questionsPerStage, isGestureQuiz);
    return null;
  };

  private switchLanguage(language: QuizLanguage | null): void {
    this.choicesByLanguage.set(this.shownLanguage, this.currentChoices());
    this.shownLanguage = quizLanguageOf(language);
    this.showLanguageChoices();
  }

  // Puts the shown language's choices in the form, as fresh fields: a field left empty in the other language
  // does not greet the teacher with its error.
  private showLanguageChoices(): void {
    this.formGroup.patchValue(this.choicesByLanguage.get(this.shownLanguage) ?? this.defaultChoices);
    LANGUAGE_CHOICES.forEach(key => this.formGroup.controls[key].markAsPristine());
    this.fitChoicesToLanguage();
  }

  private currentChoices(): LanguageChoices {
    const raw = this.formGroup.getRawValue();
    return Object.fromEntries(LANGUAGE_CHOICES.map(key => [key, raw[key]])) as LanguageChoices;
  }

  // A saved language's choices, read through the sanitizers: a save from before a choice existed, or one that was
  // edited or corrupted, still gives a form the server will accept.
  private choicesOf(saved: Partial<LanguageChoices> | undefined): LanguageChoices {
    const given = LANGUAGE_CHOICES.filter(key => saved?.[key] !== undefined).map(key => [key, saved![key]]);
    return {
      ...this.defaultChoices,
      ...Object.fromEntries(given),
      lessonNumbers: lessonNumbersOf(saved?.lessonNumbers),
      gestureStages: gestureStagesOf(saved?.gestureStages),
      questionsPerStage: questionsPerStageOf(saved?.questionsPerStage),
    };
  }

  // A course or platform of the other language is cleared, so the form never sends what the server refuses. A
  // language with a default course gets it chosen for the teacher (English: the one typed in by hand).
  private fitChoicesToLanguage(): void {
    const { language, courseType, exportType } = this.formGroup.controls;
    if (!teachesCourse(language.value, courseType.value)) {
      courseType.setValue(this.language.defaultCourse);
    }
    if (!offersExportType(language.value, exportType.value)) {
      exportType.setValue(null);
    }
  }

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
        const language = quizLanguageOf(settings?.language);
        // A save from before each language kept its own holds its language's choices at the top level.
        const byLanguage = settings?.byLanguage ?? { [language]: settings };
        for (const { value } of LANGUAGES) {
          if (byLanguage?.[value]) {
            this.choicesByLanguage.set(value, this.choicesOf(byLanguage[value]));
          }
        }
        const shared = (['AIMode'] as const).filter(key => settings?.[key] !== undefined);
        this.formGroup.patchValue({ language, ...Object.fromEntries(shared.map(key => [key, settings[key]])) }, { emitEvent: false });
        this.shownLanguage = language;
      }
    } catch {
      // Storage unavailable or corrupted: start from the defaults.
    }
  }

  private saveSettings(): void {
    try {
      this.choicesByLanguage.set(this.shownLanguage, this.currentChoices());
      const { language, AIMode } = this.formGroup.getRawValue();
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
        language,
        AIMode,
        byLanguage: Object.fromEntries(this.choicesByLanguage)
      }));
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
        this.notificationService.error(this.messages.get('ai.form.notImage'), escapeHtml(file.name));
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
          this.notificationService.error(this.messages.get('ai.form.duplicateImage'), escapeHtml(file.name));
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

  // Names the lesson for the download, e.g. "HSK3-Bai5" (HSK 2.0), "HSK3.0-3-Bai5", "HSK3.0-3-Bai3-5+7" for
  // several lessons, or "Boya-Bai2" for a course typed in by hand.
  private lessonLabel(): string {
    const {
      courseType,
      courseName,
      hskStandard,
      level,
      lessonNumbers
    } = this.formGroup.getRawValue();
    const course = courseType === CourseType.Hsk ? (hskStandard === HskStandard.V3 ? 'HSK3.0-' : 'HSK')
      : courseType === CourseType.Yct ? 'YCT'
        : courseType === CourseType.VocabReview10 ? 'Lop10'
          : (courseName ?? '');
    const shownLevel = courseHasLevels(courseType) ? level : null;
    return `${course}${shownLevel ?? ''}-${courseType === CourseType.VocabReview10 ? 'Topic' : 'Bai'}${formatLessonNumbers(lessonNumbers ?? [], '-', '+')}`;
  }

  // Only what can go wrong before the server accepts the job. A job that fails later (AI error, timeout)
  // is reported by AiJobService when the history table sees it fail.
  private showGenerationError(err: unknown): void {
    const failure = httpFailure(err);
    const status = failure.status;
    if (status === HttpStatusCode.Unauthorized) {
      this.notificationService.warning(this.messages.get('ai.form.sessionExpired'), '');
      this.setGenerating(false);
      this.router.navigate(['/login'], { queryParams: { returnUrl: '/ai' } });
      return;
    }
    if (notifyAiRefusal(this.notificationService, this.messages, failure)) {
      return;
    }
    if (status === HttpStatusCode.BadRequest) {
      this.notificationService.error(this.messages.get('ai.form.invalidRequest'), '');
      return;
    }
    if (err instanceof UploadTooLargeError || status === HttpStatusCode.PayloadTooLarge) {
      this.notificationService.error(this.messages.get('ai.form.imageTooLarge'),
        this.messages.get('ai.form.reduceImages'), { nzDuration: 0 });
      return;
    }
    this.notificationService.error(this.messages.get('ai.form.sendFailed'), this.messages.get('common.tryAgain'));
  }
}

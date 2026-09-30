// Every reference to Wayground's own page lives here, so a Wayground UI change means editing only this
// file. Recorded from wayground.com on 2026-09-30 (free Basic plan). Prefer data-testid and aria
// attributes: the class names are generated and change with every Wayground release.
const WAYGROUND = {
  // Paths, matched against location.pathname.
  loginPath: /^\/login/,
  startPath: /^\/activity\/admin\/assessment\/?$/,
  editorPath: /^\/activity\/admin\/quiz\/[^/]+\/edit/,
  // Where Publish lands; the id is the quiz's.
  publishedPath: /^\/activity\/admin\/quiz\/([^/]+)\/?$/,

  // The link the quiz's Share → "Share with teachers" → Copy Link gives.
  shareUrl: quizId => `https://wayground.com/admin/assessment/${quizId}?source=lesson_share`,

  // Start page ("How would you like to get started?"). Every card shares this test id; the one to
  // click is found by its text. ("Import via template" on this page is a paid feature, so it is not used.)
  creationOption: '[data-testid="resource-creation-option-selector"]',
  startFromScratchText: 'Start from scratch',

  // Editor: "Import existing files" → Spreadsheet opens the import modal.
  sheetsButton: '[data-testid="sheets-button"]',
  importModal: '[data-testid="import-from-sheet-modal"]',
  importFileInput: '[data-testid="import-from-sheet-modal"] input[type="file"]',
  importButton: '[data-testid="import-from-sheet-modal"] [data-testid="primary-modal-cta-button"]',

  // Editor: Publish opens the quiz settings modal, whose primary button then publishes. Subject and
  // Grade are required there.
  publishButton: '[data-testid="publish-quiz-button"]',
  settingsModal: '[data-testid="quiz-settings-modal"]',
  nameInput: '[data-testid="quiz-name-input"]',
  subjectSelect: '[data-testid="quiz-subject-select-box"]',
  gradeSelect: '[data-testid="publish-modal-grade-input-select-box"]',
  languageSelect: '[data-testid="publish-modal-language-input-select-box"]',
  selectOption: '[role="option"]',
  settingsPrimary: '[data-testid="quiz-settings-modal-primary-button"]',
};

// What every published quiz is filed under, written exactly as Wayground's dropdowns show them
// (languages appear under their own names). Visibility is left at Wayground's default, "Publicly
// visible": the other choices are paid features.
const PUBLISH_SETTINGS = {
  subject: 'World Languages',
  grade: 'University',
  language: 'Tiếng Việt',
};

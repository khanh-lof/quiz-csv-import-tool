// Every reference to Wayground's own page lives here, so a Wayground UI change means editing only this
// file. Recorded from wayground.com on 2026-09-30 (free Basic plan). Prefer data-testid and aria
// attributes: the class names are generated and change with every Wayground release.
const WAYGROUND = {
  // Paths, matched against location.pathname.
  loginPath: /^\/login/,
  startPath: /^\/activity\/admin\/assessment\/?$/,
  editorPath: /^\/activity\/admin\/quiz\/[^/]+\/edit/,

  // Start page ("How would you like to get started?"). Every card shares this test id; the one to
  // click is found by its text. ("Import via template" on this page is a paid feature, so it is not used.)
  creationOption: '[data-testid="resource-creation-option-selector"]',
  startFromScratchText: 'Start from scratch',

  // Editor: the quiz name opens the quiz settings modal, which holds the name field.
  editNameButton: '[data-testid="edit-name-button"]',
  settingsModal: '[data-testid="quiz-settings-modal"]',
  nameInput: '[data-testid="quiz-name-input"]',
  settingsSave: '[data-testid="quiz-settings-modal-primary-button"]',

  // Editor: "Import existing files" → Spreadsheet opens the import modal.
  sheetsButton: '[data-testid="sheets-button"]',
  importModal: '[data-testid="import-from-sheet-modal"]',
  importFileInput: '[data-testid="import-from-sheet-modal"] input[type="file"]',
  importButton: '[data-testid="import-from-sheet-modal"] [data-testid="primary-modal-cta-button"]',
};

// Every reference to Gimkit's own page lives here, so a Gimkit UI change means editing only this file.
// Recorded from www.gimkit.com on 2026-11-09. Gimkit is built on Ant Design with generated class names and
// no data-testid, so elements are found by Ant Design's stable `ant-*` classes, roles and visible text.
const GIMKIT = {
  // Paths, matched against location.pathname.
  loginPath: /^\/login/,
  // "New Kit": name, language and subject, then a cover photo. Choosing the photo creates the kit.
  createPath: /^\/create\/?$/,
  // The kit's editor; the id is the kit's.
  editorPath: /^\/create\/([^/]+)\/editor\/?$/,
  // "Import from Spreadsheet" opens its dialog as this sub-page, and goes back to the editor once the file is in.
  spreadsheetPath: /^\/create\/[^/]+\/editor\/spreadsheet/,
  // Where "All Done" lands: the teacher's kit list.
  kitsPath: /^\/me\/?$/,

  // The kit's public page, which is also the link its Share tab gives (it needs no Gimkit account to open).
  shareUrl: kitId => `https://www.gimkit.com/view/${kitId}`,

  // New Kit dialog. Language and Subject are the dialog's first and second Ant Design selects.
  modal: '.ant-modal',
  nameInput: '.ant-modal input[placeholder="Kit name"]',
  select: '.ant-modal .ant-select',
  selectValue: '.ant-select-selection-item',
  selectSelector: '.ant-select-selector',
  selectOption: '.ant-select-item-option',
  buttonNextText: 'Next',
  // Each cover photo is a tile of the picture and, after it, a link to the photographer captioned
  // "Image by <photographer>". That link opens Pexels in a new tab, so the click goes to the picture before
  // it; any tile will do.
  coverPhotoCredit: '.ant-modal a',
  coverPhotoCreditText: 'Image by',

  // Editor: a menu item opens the import dialog, whose file input takes the CSV straight away.
  importMenuText: 'Import from Spreadsheet',
  fileInput: 'input[type="file"]',
  buttonAllDoneText: 'All Done',
  saved: 'All changes saved',
};

// What every kit is filed under, written exactly as Gimkit's dropdowns show them. Gimkit has no free-form
// default for a language, so the lesson's own language is not guessed.
const GIMKIT_SETTINGS = {
  language: 'English',
  subject: 'Speech and Language',
  // Gimkit refuses a longer kit name.
  maxNameLength: 30,
};

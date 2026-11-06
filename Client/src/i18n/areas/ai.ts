export const ai = {
  retryLater: 'Thử lại sau ít phút.',
  label: {
    mode: 'Chế độ',
    platform: 'Nền tảng',
    course: 'Giáo trình',
    level: 'Cấp',
    lesson: 'Bài',
    uncertain: 'AI không chắc',
    dropped: 'Đã bỏ'
  },
  refusal: {
    quotaTitle: 'Hết lượt dùng AI',
    forbiddenTitle: 'Không có quyền',
    forbiddenBody: 'Chưa được dùng AI.',
    offlineTitle: 'Mất kết nối'
  },
  failure: {
    timeout: 'Quá lâu. Gửi lại hoặc giảm số ảnh.',
    interrupted: 'Bị gián đoạn. Gửi lại.',
    truncated: 'Đề quá dài. Giảm số câu hoặc số bài.',
    filtered: 'Nội dung bị chặn. Đổi ảnh hoặc bài.',
    overloaded: 'AI đang quá tải. Thử lại sau ít phút.',
    badOutput: 'Kết quả lỗi. Gửi lại.',
    providerConfig: 'AI tạm ngưng. Báo quản trị viên.',
    nothingToPlay: 'Không bài nào đủ từ. Chọn bài khác.',
    unknown: 'Không rõ lỗi.'
  },
  job: {
    sentTitle: 'Đã gửi yêu cầu',
    sentLead: 'Kết quả ở',
    historyLink: 'AI › Lịch sử.',
    doneTitle: 'AI đã tạo xong',
    doneLead: '"%title%" — xem ở',
    failedTitle: 'AI không tạo được',
    failedBody: '"%title%": %reason%'
  },
  form: {
    hsk2MaxLevel: 'HSK 2.0 chỉ có cấp 1–6',
    lessonMax: '%title% chỉ có %unit% 1–%max%',
    pickCourse: 'Chọn giáo trình',
    optional: 'Không bắt buộc',
    pickLesson: 'Chọn %unit%',
    pickPlatform: 'Chọn nền tảng',
    pickGame: 'Chọn ít nhất 1 trò chơi',
    dropHint: 'Kéo thả, dán (Ctrl+V) hoặc',
    chooseFile: 'chọn file',
    textbookHasBook: 'Có sẵn %title%, không cần ảnh.',
    intelligenceMaintenance: 'Đang bảo trì.',
    intelligenceSlower: 'Chậm hơn.',
    needImage: 'Cần ít nhất 1 ảnh',
    notImage: 'Không phải ảnh',
    duplicateImage: 'Ảnh trùng lặp',
    sessionExpired: 'Hết phiên đăng nhập',
    invalidRequest: 'Yêu cầu không hợp lệ',
    imageTooLarge: 'Ảnh quá lớn',
    reduceImages: 'Giảm số ảnh.',
    sendFailed: 'Chưa gửi được yêu cầu'
  },
  history: {
    empty: 'Chưa có lần tạo nào.',
    noData: 'Không có dữ liệu.',
    loadFailed: 'Không tải được',
    wayground: {
    },
    downloaded: {
      title: 'Đã tải file',
      body: 'Mở file ở trang Chơi game.'
    },
    resend: 'Gửi lại ở AI › Tạo quiz.',
    imagesExpired: 'Ảnh đã hết hạn lưu. Gửi lại ở AI › Tạo quiz.',
    tooOld: 'Quá cũ để tạo lại. Gửi lại ở AI › Tạo quiz.',
    retryFailed: 'Không tạo lại được',
    removeTitle: 'Xóa lần tạo này?',
    removeFailed: 'Không xóa được'
  },
  radicals: {
    stale: 'Bài cũ, không sửa được.',
    noLesson: 'Không bài nào đủ từ.',
    loadRetry: 'Không tải được. Thử lại.',
    saveRetry: 'Không lưu được. Thử lại.',
    loadReload: 'Không tải được. Tải lại trang.',
    fixRedCells: 'Sửa các ô đỏ.',
    savedReload: 'Đã lưu. Tải lại trang để xem bài mới.',
    notFinished: 'AI chưa tạo xong bài này.',
    discardTitle: 'Bỏ các thay đổi chưa lưu?',
    discardOk: 'Bỏ',
    discardCancel: 'Sửa tiếp',
    nothingToEdit: 'Không có mục nào để sửa.',
    droppedHint: 'Từ "Đã bỏ": nhập pinyin để đưa vào bài.',
    pinyinMismatch: 'Pinyin không khớp số chữ',
    review: {
      title: 'Cần xem lại',
      aiWords: 'Pinyin, nghĩa do AI điền',
      pinyinWarning: 'Pinyin cần xem (bài %lesson%)',
      pinyinWarningText: '%word%: %char% ghi "%syllable%", đọc %readings%',
      reading: '%char% đọc %readings%',
      dropped: 'Bỏ vì thiếu pinyin',
      skippedLesson: 'Bài %lesson% bị bỏ',
      skippedLessonText: 'chỉ %count% từ ghép bộ được',
      aiChars: 'Nghĩa chữ do AI điền',
      aiComponents: 'Bộ do AI điền',
      missingGlyphs: 'Không vẽ được'
    }
  }
};

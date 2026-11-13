export const assignments = {
  action: {
    delete: 'Xóa',
    reopen: 'Mở lại',
    closeAssignment: 'Đóng bài',
    scheduleClose: 'Hẹn giờ đóng',
    preview: 'Xem thử',
    copyLink: 'Sao chép link',
    qrCode: 'Mã QR',
    refresh: 'Làm mới',
    retry: 'Thử lại',
    showPinyin: 'Hiện pinyin'
  },
  stage: {
    label: 'Màn %position%',
    labelWithName: 'Màn %position% (%name%)',
    labelDotName: 'Màn %position% · %name%',
    percent: 'Màn %position% %percent%'
  },
  status: {
    open: 'Đang mở',
    closed: 'Đã đóng',
    openUntil: 'Đang mở · đóng lúc %time%'
  },
  timeMode: {
    standard: 'Chuẩn',
    extra: 'Thêm giờ (×1,5)',
    unlimited: 'Không giới hạn'
  },
  stageLock: {
    sequential: 'Phải qua màn trước mới mở màn sau',
    open: 'Mở tất cả các màn'
  },
  error: {
    sessionExpired: 'Hết phiên đăng nhập. Đăng nhập lại.',
    invalidInput: 'Thông tin chưa hợp lệ.',
    jobNotFound: 'Không tìm thấy quiz này.',
    playerNotFound: 'Học sinh này đã bị xóa.',
    tooManyAssignments: 'Tối đa 100 bài. Xóa bớt ở Bài đã giao.',
    jobNotFinished: 'Chỉ giao được Game đã tạo xong và có câu hỏi hợp lệ.',
    invalidClosingTime: 'Giờ đóng phải sau bây giờ, tối đa 180 ngày.',
    labelTooLong: 'Tên lớp / nhóm tối đa 60 ký tự.',
    invalidPassPercents: 'Tỉ lệ đúng để qua màn phải từ 10% đến 100%.',
    invalidReplayLimit: 'Số lần chơi mỗi màn: 1–10, chỉ khi mở tất cả các màn.'
  },
  failure: {
    closeAssignment: 'Không đóng được bài',
    reopenAssignment: 'Không mở lại được bài',
    scheduleClose: 'Không hẹn giờ được',
    changePinyin: 'Không đổi được cài đặt pinyin',
    removePlayer: 'Không xóa được học sinh',
    removeAssignment: 'Không xóa được bài'
  },
  share: {
    copied: 'Đã sao chép link',
    copyFailed: 'Chưa sao chép được',
    fallbackQr: 'Lấy link ở Mã QR.',
    fallbackManual: 'Nhấn Ctrl+C để sao chép.',
    linkLabel: 'Link bài',
    codeLabel: 'Mã bài:'
  },
  confirmDelete: {
    keep: 'Giữ lại'
  },
  deadline: {
    closesAt: 'Đóng lúc %time%.',
    inThePast: 'Giờ này đã qua.',
    pickerLabel: 'Giờ đóng bài',
    pickerPlaceholder: 'Chọn ngày và giờ',
    none: 'Không hẹn giờ',
    in45Minutes: 'Sau 45 phút',
    endOfToday: 'Hết hôm nay',
    custom: 'Chọn giờ…'
  },
  assignDialog: {
    title: 'Giao bài cho học sinh',
    done: 'Đã giao bài.',
    summary: '%questions% câu · %stages% màn',
    skipped: 'Bỏ qua %count% dòng không hợp lệ.',
    noQuestions: 'Không có câu hỏi hợp lệ để giao.',
    optional: '(không bắt buộc)',
    attemptsLimited: 'Giới hạn',
    attemptsUnlimited: 'Không',
    attemptsUnit: 'lần mỗi màn',
    passNeed: 'cần đúng %mark%/%count% câu',
    finish: 'Xong',
    viewLeaderboard: 'Xem bảng xếp hạng',
    classLabel: 'Lớp / nhóm',
    timePerQuestion: 'Thời gian mỗi câu',
    stageLockLabel: 'Mở khóa các màn',
    attemptsLabel: 'Giới hạn số lần chơi mỗi màn',
    passLabel: 'Tỉ lệ đúng để qua màn',
    showBoard: 'Học sinh xem bảng xếp hạng',
    submit: 'Giao bài'
  },
  leaderboard: {
    notFound: 'Không tìm thấy bài này',
    loadFailed: 'Chưa tải được bảng xếp hạng',
    hiddenFromStudents: 'Học sinh không xem bảng xếp hạng',
    noPlayers: 'Chưa có học sinh.',
    closeConfirm: 'Đóng bài? Học sinh sẽ không vào chơi được nữa.',
    reopenTitle: 'Mở lại bài',
    removePlayer: 'Xóa %name%',
    removePlayerConfirm: 'Xóa %name% khỏi bảng xếp hạng?',
    removePlayerTooltip: 'Xóa khỏi bảng xếp hạng',
    backToList: 'Về Bài đã giao',
    metaTimeMode: 'Thời gian mỗi câu: %mode%',
    metaStageLock: 'Các màn: %lock%',
    metaPass: 'Tỉ lệ đúng để qua màn: %pass%',
    metaLimit: 'Giới hạn: %count% lần/màn',
    metaAssignedAt: 'Giao lúc %time%',
    metaPlayers: '%count% học sinh',
    download: 'Tải bảng xếp hạng',
    fullscreen: 'Toàn màn hình',
    exitFullscreen: 'Thoát toàn màn hình',
    attemptsCount: '%count% lần',
    waitingTitle: 'Chưa có kết quả (%count%)',
    joinedAt: 'Vào lúc %time%',
    pipNotPlayed: '%head%: chưa chơi',
    pipPlayed: '%head%: %result% · %attempts% lần',
    moveUp: 'Lên %places% hạng',
    moveDown: 'Xuống %places% hạng'
  },
  csv: {
    rank: 'Hạng',
    name: 'Tên',
    stagesPassed: 'Màn đã qua',
    correct: 'Câu đúng',
    attempts: 'Lần chơi',
    updated: 'Cập nhật'
  },
  list: {
    ariaLabel: 'Bài đã giao',
    clearFilters: 'Bỏ lọc',
    columnTitle: 'Bài',
    columnStudents: 'Học sinh',
    columnAssignedAt: 'Lúc giao',
    toAiHistory: 'Đến AI › Lịch sử',
    actions: 'Thao tác',
    loadFailed: 'Chưa tải được danh sách.',
    emptyHelp: 'Giao bài ở AI › Lịch sử.',
    closeTitle: 'Đóng bài?',
    closeContent: 'Học sinh sẽ không vào chơi được nữa.',
    deleteTitle: 'Xóa bài này?',
    deleteContent: 'Bài và kết quả của học sinh sẽ bị xóa.',
    reopenTitle: 'Mở lại: %title%'
  }
};

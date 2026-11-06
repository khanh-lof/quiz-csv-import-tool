export const play = {
  action: {
    backToMap: 'Về bản đồ',
    retry: 'Thử lại',
    retryLoad: 'Thử tải lại'
  },
  connection: {
    lost: 'Mất kết nối.'
  },
  stage: {
    label: 'Màn %position%',
    questionCount: '%count% câu',
    passRule: 'Đúng ít nhất <b>%passMark%/%total%</b> câu để qua màn.',
    hint: {
      trueFalse: 'Ngón cái lên = Đúng, xuống = Sai. Giữ để chọn.',
      headTilt: 'Nghiêng đầu về đáp án đúng và giữ yên.',
      frogBite: 'Dịch đầu sang làn đúng, há rồi khép miệng.',
      fruitSlice: 'Vung ngón trỏ chém quả cùng màu với đáp án đúng.',
      fingerCount: 'Giơ 1–4 ngón (không tính ngón cái) theo số đáp án.',
      wordOrder: 'Chỉ vào từng mảnh theo thứ tự, giữ yên hoặc chụm ngón để chọn.'
    }
  },
  answer: {
    label: 'Đáp án:',
    correct: 'Đáp án đúng'
  },
  camera: {
    turnOn: 'Bật camera',
    turnOff: 'Tắt camera',
    starting: 'Đang bật camera…',
    unusable: 'Không dùng được camera',
    privacy: 'Camera không ghi hình.',
    blocked: 'Camera bị chặn. Cho phép camera cho trang này rồi bật lại.',
    notFound: 'Không tìm thấy camera.',
    unsupported: 'Trình duyệt không hỗ trợ camera. Dùng Chrome hoặc Edge qua HTTPS.',
    inUse: 'Camera đang được ứng dụng khác dùng. Đóng nó rồi bật lại.',
    failed: 'Không bật được camera.',
    disconnected: 'Camera bị ngắt. Cắm lại rồi bật lại.',
    standHand: 'Đứng cách camera 0,6–1,2 m, đủ sáng.',
    standFace: 'Cách camera 0,6–1,2 m, nhìn thẳng, đủ sáng.'
  },
  model: {
    loading: 'Đang tải nhận diện…',
    failed: 'Chưa tải được nhận diện.'
  },
  tracking: {
    handSeen: 'Đã thấy tay ✓',
    faceSeen: 'Đã thấy mặt ✓',
    multiple: 'Chỉ một người trước camera',
    putHandIn: 'Đưa tay vào khung hình'
  },
  hand: {
    notSeen: 'Chưa thấy bàn tay'
  },
  face: {
    notSeen: 'Chưa thấy mặt',
    onlyOne: 'Chỉ một khuôn mặt',
    lookStraight: 'Nhìn thẳng vào camera',
    recalibrate: 'Hiệu chỉnh lại'
  },
  finger: {
    fist: 'Nắm tay',
    count: '%count% ngón',
    fistAgain: 'Nắm tay lại'
  },
  frog: {
    closeToBite: 'Khép miệng để đớp',
    closeAgain: 'Khép miệng lại',
    openThenClose: 'Há rồi khép miệng để đớp',
    missed: 'Giữ yên ở một làn rồi đớp'
  },
  tilt: {
    left: 'Trái',
    right: 'Phải',
    backToCenter: 'Đưa đầu về giữa'
  },
  thumb: {
    handDown: 'Hạ tay xuống'
  },
  fruit: {
    dragMouse: 'Kéo chuột qua quả để chém',
    pointFinger: 'Đưa ngón trỏ vào khung hình'
  },
  wordOrder: {
    undo: 'Hoàn tác'
  },
  verdict: {
    timeUp: '⏱ Hết giờ',
    correct: '✓ Chính xác! +%points%',
    wrong: '✗ Chưa đúng',
    waiting: 'Đang chờ kết quả…'
  },
  pause: {
    title: 'Tạm dừng',
    resume: 'Chơi tiếp',
    pauseKey: 'Tạm dừng (P)',
    resumeKey: 'Chơi tiếp (P)',
    locked: 'Đang tính giờ, không tạm dừng được'
  },
  sound: {
    on: 'Bật âm thanh',
    off: 'Tắt âm thanh'
  },
  fullscreen: {
    enter: 'Toàn màn hình',
    exit: 'Thoát toàn màn hình',
    failed: 'Không bật được toàn màn hình'
  },
  hud: {
    question: 'Câu %current%/%total%',
    streak: 'Chuỗi đúng %streak%',
    unlimitedTime: 'Không giới hạn thời gian'
  },
  intro: {
    timed: '%count% câu, %seconds% giây mỗi câu.',
    untimed: '%count% câu, không giới hạn thời gian.'
  },
  page: {
    preview: 'Xem thử: không lưu kết quả.',
    guideCreate: 'Tạo Game ở <b>AI › Tạo quiz</b> rồi bấm <b>Chơi ngay</b> ở <b>AI › Lịch sử</b>, hoặc <b>Mở file quiz</b> đã tải.',
    guidePass: 'Đúng từ <b>70%</b> số câu là qua màn.',
    guideNoCamera: 'Không có camera vẫn chơi được bằng chuột, cảm ứng hoặc bàn phím.',
    backToHistory: 'Về Lịch sử',
    backToLeaderboard: 'Về Bảng xếp hạng',
    backToManualQuiz: 'Về Quiz thủ công',
    backToAssignments: 'Về Bài đã giao'
  },
  load: {
    noQuestions: 'Không có câu hỏi hợp lệ.',
    skippedRows: 'Bỏ qua %count% dòng không dùng được',
    fileUnreadable: 'Không đọc được file này.',
    quizFailed: 'Không tải được quiz. Kiểm tra mạng rồi thử lại.',
    quizMissing: 'Không tìm thấy quiz này trong Lịch sử.',
    quizRunning: 'AI chưa tạo xong quiz này.',
    quizNotGame: 'Quiz này không phải Game.',
    assignmentFailed: 'Không tải được bài.'
  },
  shared: {
    closed: 'Bài này đã đóng.',
    missing: 'Không tìm thấy bài này. Kiểm tra lại link.',
    failed: 'Không tải được bài. Tải lại trang.',
    empty: 'Bài này chưa có câu hỏi. Báo thầy cô.',
    notYou: 'Không phải bạn?'
  },
  join: {
    closesAt: 'Bài đóng lúc %time%',
    nameLabel: 'Tên của bạn',
    pickAvatar: 'Chọn hình đại diện',
    submit: 'Vào chơi',
    nameTaken: 'Tên này đã có người dùng. Thêm họ hoặc số.',
    full: 'Bài đã đủ học sinh. Báo thầy cô.',
    nameLength: 'Tên cần từ 1 đến 40 ký tự.',
    failed: 'Chưa vào được bài. Thử lại.'
  },
  avatar: {
    label: 'Hình đại diện',
    change: 'Đổi hình đại diện',
    changeFailed: 'Chưa đổi được hình đại diện',
    random: 'Ngẫu nhiên'
  },
  run: {
    ended: 'Lượt chơi đã kết thúc',
    endedInOtherTab: 'Màn này đang mở ở tab khác.',
    stageLocked: 'Màn này chưa mở',
    stageLockedDetail: 'Hãy qua màn trước.',
    noAttempts: 'Hết lượt chơi',
    startFailed: 'Chưa bắt đầu được màn'
  },
  map: {
    celebration: 'Chúc mừng! Bạn đã qua tất cả các màn',
    totalScore: 'Tổng điểm tốt nhất: <b>%score%</b>',
    summaryOne: '1 màn, <b>%total%</b> câu.',
    summaryMany: '<b>%stages%</b> màn, <b>%total%</b> câu.',
    passRule: 'Đúng từ %percent%% số câu là qua màn.',
    unlockRule: 'Đúng từ %percent%% số câu để mở màn sau.',
    passFrom: 'qua màn từ %percent%%',
    passed: 'Đã qua ✓',
    noAttempts: 'Hết lượt',
    locked: 'Khóa 🔒',
    attemptsLeft: 'Còn %count% lượt',
    best: 'Tốt nhất: <b>%correct%/%total%</b> · %points% điểm',
    notPlayed: 'Chưa chơi',
    timePerQuestion: 'Thời gian mỗi câu',
    sound: 'Âm thanh',
    showPinyin: 'Hiện pinyin',
    resetConfirm: 'Xóa tiến độ và chơi lại từ đầu?',
    resetOk: 'Chơi lại',
    reset: 'Chơi lại từ đầu'
  },
  result: {
    passed: 'Qua màn %position%!',
    failed: 'Chưa qua màn %position%',
    score: 'Đúng <b>%correct%/%total%</b> câu · <b>%points%</b> điểm',
    bestStreak: 'chuỗi đúng dài nhất <b>%streak%</b>',
    saved: 'Đã lưu kết quả cho thầy cô ✓',
    noAttempts: 'Hết lượt chơi màn này.',
    review: 'Những câu cần xem lại',
    timedOut: 'Hết giờ'
  },
  board: {
    topThree: 'Ba hạng đầu',
    empty: 'Chưa ai có kết quả.',
    cheer: 'Chúc mừng! Bạn trong top 3 🎉',
    you: 'Bạn',
    rank: 'Hạng %rank%',
    score: '%passed%/%stages% màn · %correct%/%possible% câu'
  }
};

# Cài tiện ích QuizTool → Wayground

Tiện ích này giúp QuizTool tự tạo quiz trên Wayground: chọn **Tiện ích tự publish** trong QuizTool, một tab
Wayground sẽ mở ra, tự import câu hỏi, đặt tên và **publish** quiz, rồi tự đóng lại. Link chia sẻ của
quiz hiện ngay trong QuizTool (và được copy sẵn).

Quiz được publish với Subject **World Languages**, Grade **University**, Language **Tiếng Việt**, và ở
chế độ **Publicly visible** (với tài khoản Wayground miễn phí, chỉ có chế độ này).

Tiện ích chạy ngay trong tab Wayground mà bạn đã đăng nhập, nên không cần nhập mật khẩu Wayground vào
QuizTool.

Dùng được trên **Google Chrome** và **Microsoft Edge** trên máy tính (không dùng được trên điện thoại).

## 1. Tải thư mục tiện ích

1. Mở trang mã nguồn QuizTool trên GitHub:
   https://github.com/khanh-lof/quiz-csv-import-tool
2. Bấm nút xanh **Code** → **Download ZIP**.
3. Giải nén file ZIP vừa tải (chuột phải → **Extract All...**).
4. Chuyển thư mục **`Extension`** trong đó tới một chỗ cố định, ví dụ `Documents\QuizTool-Extension`.
   Đừng để trong thư mục Downloads rồi xoá đi: xoá thư mục này là tiện ích ngừng chạy.

## 2. Cài vào trình duyệt

1. Mở trang quản lý tiện ích:
   - Chrome: gõ `chrome://extensions` vào thanh địa chỉ rồi Enter.
   - Edge: gõ `edge://extensions` rồi Enter.
2. Bật **Developer mode** (Chế độ dành cho nhà phát triển). Trên Chrome, công tắc nằm ở góc trên bên
   phải. Trên Edge, nó nằm ở cột bên trái.
3. Bấm **Load unpacked** (Tải tiện ích đã giải nén).
4. Chọn thư mục **`Extension`** ở bước 1 (thư mục có file `manifest.json` bên trong), rồi bấm
   **Select Folder**.
5. Tiện ích **QuizTool → Wayground** hiện ra trong danh sách là cài xong.

## 3. Dùng thử

1. Đăng nhập Wayground (https://wayground.com) trên cùng trình duyệt đó.
2. Mở QuizTool (nếu QuizTool đang mở sẵn thì tải lại trang bằng F5).
3. Tạo quiz như bình thường, chọn nền tảng **Wayground** và chọn **Tiện ích tự publish** (chọn
   **Tải file** thì QuizTool chỉ tải file `.xlsx` về để bạn tự import, tiện ích không làm gì):
   - **Tạo thủ công**: nhập bảng câu hỏi rồi bấm **Publish lên Wayground**.
   - **Tạo bằng AI**: chọn chế độ AI tự nghĩ câu hỏi rồi bấm tạo.
4. QuizTool mở một tab Wayground mới. Khung thông báo ở
   cuối trang Wayground báo tiến trình. Đừng bấm gì trong tab đó khi tiện ích đang chạy.
5. Khi publish xong, tab Wayground tự đóng và QuizTool hiện thông báo **Đã publish quiz trên Wayground**
   kèm link chia sẻ (đã copy sẵn, dán được luôn).

Nếu tiện ích bị kẹt ở một bước, tab Wayground vẫn mở với khung báo **màu đỏ** cho biết kẹt ở đâu, và
QuizTool báo **Wayground chưa publish được** và tải file `.xlsx` về. Làm tiếp bằng tay trong tab đó.
Nếu câu hỏi chưa được import, chọn **Import existing files → Spreadsheet** rồi chọn file `.xlsx` vừa
tải về.

Nếu chưa đăng nhập Wayground, tab mới sẽ mở trang đăng nhập. Đăng nhập xong là tiện ích tự làm tiếp.

## Cập nhật tiện ích

Khi có bản mới, tải lại ZIP như ở bước 1 và chép đè thư mục `Extension` cũ. Sau đó mở
`chrome://extensions` (hoặc `edge://extensions`) và bấm nút tải lại (mũi tên vòng tròn) trên thẻ
**QuizTool → Wayground**.

## Gặp lỗi?

- **Không chọn được "Tiện ích tự publish"** (nút bị mờ), hoặc **không thấy tab Wayground mở ra**:
  kiểm tra tiện ích đang bật trong `chrome://extensions`, rồi tải lại trang QuizTool (F5). Tiện ích chỉ chạy với QuizTool mở ở https://kt-quiz-csv-import-tool.vercel.app.
- **Chrome báo "Disable developer mode extensions"** khi mở trình duyệt: bấm **Cancel** (Huỷ) để giữ
  tiện ích.
- **Khung báo màu đỏ liên tục**: có thể Wayground vừa đổi giao diện. Vẫn làm bằng tay được như
  hướng dẫn ở mục 3, và báo lại để tiện ích được cập nhật.
- **Lỡ đóng tab QuizTool trong lúc chờ**: tab Wayground sẽ không tự đóng, và link chia sẻ hiện trong
  khung báo màu xanh ở cuối trang Wayground.
- **Không muốn dùng nữa**: chọn **Tải file** trong QuizTool, hoặc vào `chrome://extensions` và bấm
  **Remove** trên thẻ tiện ích. QuizTool vẫn tải file như bình thường.

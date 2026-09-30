# Cài tiện ích QuizTool → Wayground

Tiện ích này giúp QuizTool tự import file quiz vào Wayground: bấm tải file Wayground trong QuizTool,
một tab Wayground sẽ mở ra, tự tạo quiz, đặt tên và import câu hỏi. Bạn chỉ cần kiểm tra lại rồi
bấm **Publish**.

Tiện ích chạy ngay trong tab Wayground mà bạn đã đăng nhập, nên không cần nhập mật khẩu Wayground vào
QuizTool. Tiện ích không bao giờ tự bấm Publish.

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
3. Tạo quiz như bình thường, chọn nền tảng **Wayground**:
   - **Tạo thủ công**: nhập bảng câu hỏi rồi bấm **Tải file**.
   - **Tạo bằng AI**: chọn chế độ AI tự nghĩ câu hỏi rồi bấm tạo.
4. QuizTool vẫn tải file `.xlsx` về như trước, đồng thời mở một tab Wayground mới. Đợi vài giây, khung
   thông báo ở cuối trang sẽ báo tiến trình:
   - **Màu xanh lá**: import xong. Kiểm tra câu hỏi rồi bấm **Publish**.
   - **Màu đỏ**: tiện ích bị kẹt ở một bước. Làm tiếp bằng tay: trong quiz đang mở, chọn
     **Import existing files → Spreadsheet** rồi chọn file `.xlsx` vừa tải về.

Nếu chưa đăng nhập Wayground, tab mới sẽ mở trang đăng nhập. Đăng nhập xong là tiện ích tự làm tiếp.

## Cập nhật tiện ích

Khi có bản mới, tải lại ZIP như ở bước 1 và chép đè thư mục `Extension` cũ. Sau đó mở
`chrome://extensions` (hoặc `edge://extensions`) và bấm nút tải lại (mũi tên vòng tròn) trên thẻ
**QuizTool → Wayground**.

## Gặp lỗi?

- **Không thấy tab Wayground mở ra**: kiểm tra tiện ích đang bật trong `chrome://extensions`, rồi tải
  lại trang QuizTool (F5). Tiện ích hiện chỉ chạy với QuizTool mở ở `http://localhost:4200`.
- **Chrome báo "Disable developer mode extensions"** khi mở trình duyệt: bấm **Cancel** (Huỷ) để giữ
  tiện ích.
- **Khung báo màu đỏ liên tục**: có thể Wayground vừa đổi giao diện. Vẫn import bằng tay được như
  hướng dẫn ở mục 3, và báo lại để tiện ích được cập nhật.
- **Không muốn dùng nữa**: vào `chrome://extensions` và bấm **Remove** trên thẻ tiện ích. QuizTool vẫn
  tải file như bình thường.

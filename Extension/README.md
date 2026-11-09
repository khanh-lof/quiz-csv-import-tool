# Cài tiện ích QuizTool → Wayground & Gimkit

Tiện ích này giúp QuizTool tự tạo quiz trên **Wayground** và **Gimkit**: chọn **Tiện ích tự publish** trong
QuizTool, một tab Wayground (hoặc Gimkit) sẽ mở ra, tự import câu hỏi, đặt tên và tạo quiz, rồi tự đóng
lại. Link chia sẻ của quiz hiện ngay trong QuizTool (và được copy sẵn). Chỉ cần cài **một** tiện ích cho
cả hai nền tảng.

- **Wayground**: quiz được publish với Subject **World Languages**, Grade **University**, Language
  **Tiếng Việt**, và ở chế độ **Publicly visible** (với tài khoản Wayground miễn phí, chỉ có chế độ này).
- **Gimkit**: kit được tạo với Language **English**, Subject **Speech and Language**, ảnh bìa là ảnh đầu
  tiên Gimkit gợi ý, và ở chế độ **Public** (mặc định của Gimkit). Tên kit tối đa 30 ký tự nên tên dài
  sẽ bị cắt bớt. Link chia sẻ là trang kit, ai có link cũng mở xem được.

Tiện ích chạy ngay trong tab Wayground/Gimkit mà bạn đã đăng nhập, nên không cần nhập mật khẩu
Wayground hay Gimkit vào QuizTool.

Dùng được trên **Google Chrome** và **Microsoft Edge** trên máy tính (không dùng được trên điện thoại).

## 1. Tải thư mục tiện ích

1. Đăng nhập QuizTool. Ở phần **Hướng dẫn sử dụng** của trang **Tạo bằng AI** hoặc **Tạo thủ công**, bấm
   **tải về** cạnh dòng tiện ích Wayground, Gimkit.
2. Giải nén file ZIP vừa tải (chuột phải → **Extract All...**). Trong đó có thư mục **`QuizTool-Extension`**.
3. Chuyển thư mục **`QuizTool-Extension`** tới một chỗ cố định, ví dụ `Documents\QuizTool-Extension`.
   Đừng để trong thư mục Downloads rồi xoá đi: xoá thư mục này là tiện ích ngừng chạy.

## 2. Cài vào trình duyệt

1. Mở trang quản lý tiện ích:
   - Chrome: gõ `chrome://extensions` vào thanh địa chỉ rồi Enter.
   - Edge: gõ `edge://extensions` rồi Enter.
2. Bật **Developer mode** (Chế độ dành cho nhà phát triển). Trên Chrome, công tắc nằm ở góc trên bên
   phải. Trên Edge, nó nằm ở cột bên trái.
3. Bấm **Load unpacked** (Tải tiện ích đã giải nén).
4. Chọn thư mục **`QuizTool-Extension`** ở bước 1 (thư mục có file `manifest.json` bên trong), rồi bấm
   **Select Folder**.
5. Tiện ích **QuizTool → Wayground & Gimkit** hiện ra trong danh sách là cài xong.

## 3. Dùng thử

1. Đăng nhập Wayground (https://wayground.com) và/hoặc Gimkit (https://www.gimkit.com) trên cùng trình
   duyệt đó.
2. Mở QuizTool (nếu QuizTool đang mở sẵn thì tải lại trang bằng F5).
3. Tạo quiz như bình thường, chọn nền tảng **Wayground** hoặc **Gimkit** và chọn **Tiện ích tự publish**
   (chọn **Tải file** thì QuizTool chỉ tải file về để bạn tự import, tiện ích không làm gì):
   - **Tạo thủ công**: nhập bảng câu hỏi rồi bấm **Publish lên Wayground** (hoặc **Publish lên Gimkit**).
   - **Tạo bằng AI**: chọn chế độ AI tự nghĩ câu hỏi rồi bấm tạo; khi xong, mở menu của bài trong
     **AI › Lịch sử** và chọn **Tiện ích tự publish**.
4. QuizTool mở một tab Wayground (hoặc Gimkit) mới. Khung thông báo ở
   cuối trang báo tiến trình. Đừng bấm gì trong tab đó khi tiện ích đang chạy.
5. Khi xong, tab tự đóng và QuizTool hiện thông báo **Đã publish quiz trên Wayground** (hoặc **Gimkit**)
   kèm link chia sẻ (đã copy sẵn, dán được luôn).

Nếu tiện ích bị kẹt ở một bước, tab Wayground/Gimkit vẫn mở với khung báo **màu đỏ** cho biết kẹt ở đâu, và
QuizTool báo **chưa publish được** và tải file về (`.xlsx` cho Wayground, `.csv` cho Gimkit). Làm tiếp bằng
tay trong tab đó:
- Wayground: chọn **Import existing files → Spreadsheet** rồi chọn file `.xlsx` vừa tải về.
- Gimkit: trong trang soạn kit, chọn **Import from Spreadsheet** rồi chọn file `.csv` vừa tải về.

Nếu chưa đăng nhập, tab mới sẽ mở trang đăng nhập. Đăng nhập xong là tiện ích tự làm tiếp.

## Cập nhật tiện ích

Khi có bản mới, tải lại ZIP như ở bước 1 và chép đè thư mục `QuizTool-Extension` cũ. Sau đó mở
`chrome://extensions` (hoặc `edge://extensions`) và bấm nút tải lại (mũi tên vòng tròn) trên thẻ
**QuizTool → Wayground & Gimkit**. Bản cũ chỉ có Wayground: cần cập nhật như trên để dùng được Gimkit.

## Gặp lỗi?

- **Không chọn được "Tiện ích tự publish"** (nút bị mờ), hoặc **không thấy tab Wayground/Gimkit mở ra**:
  kiểm tra tiện ích đang bật trong `chrome://extensions`, rồi tải lại trang QuizTool (F5). Tiện ích chỉ chạy với QuizTool mở ở địa chỉ web của QuizTool.
- **Chrome báo "Disable developer mode extensions"** khi mở trình duyệt: bấm **Cancel** (Huỷ) để giữ
  tiện ích.
- **Khung báo màu đỏ liên tục**: có thể Wayground hoặc Gimkit vừa đổi giao diện. Vẫn làm bằng tay được như
  hướng dẫn ở mục 3, và báo lại để tiện ích được cập nhật.
- **Lỡ đóng tab QuizTool trong lúc chờ**: tab Wayground/Gimkit sẽ không tự đóng, và link chia sẻ hiện trong
  khung báo màu xanh ở cuối trang.
- **Gimkit tạo kit nhưng thiếu câu hỏi**: kiểm tra file `.csv` có đủ câu, rồi import lại bằng tay như trên.
  Kit lỗi có thể lưu trữ (**Archive**) ở trang Kits của Gimkit.
- **Không muốn dùng nữa**: chọn **Tải file** trong QuizTool, hoặc vào `chrome://extensions` và bấm
  **Remove** trên thẻ tiện ích. QuizTool vẫn tải file như bình thường.

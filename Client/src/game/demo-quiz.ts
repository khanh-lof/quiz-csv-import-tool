export const DEMO_QUIZ_TITLE = 'Quiz mẫu HSK 1';

// A ready-made quiz in the format the AI returns for a gesture quiz (no header row): Stage, Question,
// Correct Answer, Wrong Answer 1-3, Explanation. It lets a player try the games without generating
// anything, and uses only very basic HSK 1 words. A cell with a comma is quoted.
export const DEMO_QUIZ_CSV = `1,你好 (nǐ hǎo) nghĩa là xin chào.,Đúng,,,,你好 là lời chào thông dụng nhất khi gặp nhau.
1,谢谢 (xièxie) nghĩa là xin lỗi.,Sai,,,,谢谢 nghĩa là cảm ơn; xin lỗi là 对不起 (duìbuqǐ).
1,老师 (lǎoshī) nghĩa là giáo viên.,Đúng,,,,老师 là giáo viên; 学生 (xuésheng) là học sinh.
1,喝 (hē) nghĩa là ăn.,Sai,,,,喝 nghĩa là uống; ăn là 吃 (chī).
1,苹果 (píngguǒ) nghĩa là quả táo.,Đúng,,,,苹果 (píngguǒ) là quả táo.
2,Từ nào có nghĩa là nước?,水 (shuǐ),茶 (chá),,,水 (shuǐ) là nước còn 茶 (chá) là trà.
2,谢谢 (xièxie) nghĩa là gì?,Cảm ơn,Tạm biệt,,,谢谢 là cảm ơn; tạm biệt là 再见 (zàijiàn).
2,Con mèo trong tiếng Trung là gì?,猫 (māo),狗 (gǒu),,,"猫 (māo) là mèo, còn 狗 (gǒu) là chó."
2,妈妈 (māma) là ai?,Mẹ,Bố,,,妈妈 là mẹ; bố là 爸爸 (bàba).
2,我 (wǒ) nghĩa là gì?,Tôi,Bạn,,,我 là tôi; 你 (nǐ) là bạn.
3,Chữ Hán nào có nghĩa là trà?,茶 (chá),水 (shuǐ),喝 (hē),,茶 (chá) là trà; 水 (shuǐ) là nước; 喝 (hē) là uống.
3,Từ nào có nghĩa là uống?,喝 (hē),吃 (chī),茶 (chá),,喝 (hē) là uống còn 吃 (chī) là ăn.
3,你好 (nǐ hǎo) nghĩa là gì?,Xin chào,Tạm biệt,Cảm ơn,,你好 là xin chào; 再见 (zàijiàn) là tạm biệt; 谢谢 (xièxie) là cảm ơn.
3,Giáo viên trong tiếng Trung là gì?,老师 (lǎoshī),学生 (xuésheng),朋友 (péngyou),,老师 là giáo viên; 学生 là học sinh; 朋友 là bạn bè.
3,Quả táo trong tiếng Trung là gì?,苹果 (píngguǒ),水 (shuǐ),茶 (chá),,苹果 (píngguǒ) là quả táo.
4,我 ____ 水。 (Tôi uống nước.),喝 (hē),吃 (chī),是 (shì),,Uống nước là 喝水; 吃 (chī) dùng cho đồ ăn.
4,我 ____ 苹果。 (Tôi ăn táo.),吃 (chī),喝 (hē),好 (hǎo),,Ăn táo là 吃苹果; 喝 (hē) chỉ dùng cho đồ uống.
4,我 ____ 越南人。 (Tôi là người Việt Nam.),是 (shì),喝 (hē),好 (hǎo),,是 (shì) nghĩa là 'là' và nối chủ ngữ với danh từ.
4,你 ____ 吗？ (Bạn khỏe không?),好 (hǎo),不 (bù),是 (shì),,你好吗？ là câu hỏi thăm sức khỏe.
4,我有三 ____ 苹果。 (Tôi có ba quả táo.),个 (gè),本 (běn),喝 (hē),,个 (gè) là lượng từ chung; 本 (běn) dùng cho sách.
5,再见 (zàijiàn) nghĩa là gì?,Tạm biệt,Xin chào,Cảm ơn,Xin lỗi,再见 là tạm biệt; 你好 (nǐ hǎo) là xin chào.
5,Từ nào có nghĩa là học sinh?,学生 (xuésheng),老师 (lǎoshī),朋友 (péngyou),妈妈 (māma),学生 là học sinh còn 老师 là giáo viên.
5,Nước Trung Quốc trong tiếng Trung là gì?,中国 (Zhōngguó),越南 (Yuènán),学校 (xuéxiào),苹果 (píngguǒ),中国 (Zhōngguó) là Trung Quốc; 越南 (Yuènán) là Việt Nam.
5,Con chó trong tiếng Trung là gì?,狗 (gǒu),猫 (māo),水 (shuǐ),茶 (chá),狗 (gǒu) là chó còn 猫 (māo) là mèo.
5,Từ nào có nghĩa là bạn bè?,朋友 (péngyou),老师 (lǎoshī),学生 (xuésheng),爸爸 (bàba),朋友 (péngyou) là bạn bè; 爸爸 (bàba) là bố.
6,Tôi là người Việt Nam.,我 / 是 / 越南人,,,,我是越南人 (wǒ shì Yuènánrén): chủ ngữ + 是 + danh từ.
6,Tôi uống trà.,我 / 喝 / 茶,,,,我喝茶 (wǒ hē chá): chủ ngữ + động từ + tân ngữ.
6,Bạn là học sinh phải không?,你 / 是 / 学生 / 吗,,,,你是学生吗？ (nǐ shì xuésheng ma): thêm 吗 (ma) ở cuối câu để hỏi.
6,Tôi không ăn táo.,我 / 不 / 吃 / 苹果,,,,我不吃苹果 (wǒ bù chī píngguǒ): 不 (bù) đứng trước động từ.
6,Anh ấy là giáo viên của tôi.,他 / 是 / 我的 / 老师,,,,他是我的老师 (tā shì wǒ de lǎoshī): 的 (de) chỉ sự sở hữu.`;

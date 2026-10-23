CC-BY-SA-4.0
https://creativecommons.org/licenses/by-sa/4.0/

Nguyen, Viet-Anh và Neural Research Lab (2026): *Vietnamese spell-correction training pairs* và *Vietnamese spell-correction evaluation grid*. Nhiễu tổng hợp bằng `nom.text.noise` của https://github.com/nrl-ai/nom-vn (mã Apache-2.0). Trích dẫn hai dataset Hugging Face ở dưới cùng tác giả và năm trên.

Nguồn clean train: `hirine/wikipedia-vietnamese-1M296K-dataset` (Wikipedia, CC BY-SA 4.0), https://huggingface.co/datasets/hirine/wikipedia-vietnamese-1M296K-dataset; `tmnam20/Vietnamese-News-dedup` (CC BY 4.0), https://huggingface.co/datasets/tmnam20/Vietnamese-News-dedup. Eval: câu business do nom-vn biên soạn (CC0), UDHR tiếng Việt trên Wikisource (public domain), Tatoeba và cộng tác viên (CC BY 2.0 FR, https://tatoeba.org/), UD Vietnamese VTB (CC BY-SA 4.0, https://github.com/UniversalDependencies/UD_Vietnamese-VTB). Theo dataset card, tập hợp được phát hành CC BY-SA 4.0; giữ nguyên attribution các nguồn thành phần.

Các biến thể có cùng target được giữ trong cùng một phần test. Bản chuyển đổi chuẩn hóa NFC/whitespace, loại input trùng, lọc control character; không sửa dấu câu hoặc nội dung nhãn. Nhiễu nguồn chủ yếu được sinh tổng hợp, không đại diện đầy đủ lỗi ngoài đời.

Thay đổi: lọc trùng/lỗi, chuẩn hóa an toàn, lấy mẫu seed 42, tách split và đổi định dạng.

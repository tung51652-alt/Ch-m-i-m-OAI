# ĐỀ LUYỆN OLYMPIC TRÍ TUỆ NHÂN TẠO — Vietnamese Noisy Text Restoration

Phiên bản 1.0.0 · Seed 42 · Thời gian luyện đề đề xuất: 6 giờ · Một GPU Kaggle/Colab.
Đây là đề luyện độc lập, không phải đề được một ban tổ chức OAI chính thức chứng nhận.

## 1. Bài toán và bối cảnh

Khôi phục chính xác văn bản tiếng Việt từ chuỗi bị nhiễu: sai dấu, thiếu/thừa ký tự, lỗi gõ, lỗi OCR và khoảng trắng. Đây là bài toán Text-to-Text Sequence Generation; đầu ra cần khớp cách viết của nhãn gốc.

Ứng dụng: làm sạch tài liệu số hóa, văn bản nhập bằng bàn phím và dữ liệu ngôn ngữ bị hỏng. Thí sinh xây dựng mô hình tổng quát hóa trên dữ liệu chưa thấy.

## 2. Input và output

Input: chuỗi UTF-8 trong cột `input`.
Output: chuỗi tiếng Việt chuẩn xác trong cột `target` khi huấn luyện. Submission dùng cột `text` chung cho cả hai bài.

Ví dụ train thực tế (JSON biểu diễn một dòng CSV, không phải định dạng nộp):

```json
{
  "id": "train_000001",
  "input": "- Xu hướng đa dạng về cấu trúc theo xu hướng đa dạng loài; sự đa dạng loài alpha v àbeta giảm từ moi trường thuận lợi đến môi trường khắc nghiệt.",
  "target": "- Xu hướng đa dạng về cấu trúc theo xu hướng đa dạng loài; sự đa dạng loài alpha và beta giảm từ môi trường thuận lợi đến môi trường khắc nghiệt."
}
```

## 3. Dữ liệu và cách chia

| Tập | Số mẫu | Có nhãn | Tệp |
|---|---:|---|---|
| train | 40,000 | Có | `train.csv` |
| validation | 2,000 | Có | `validation.csv` |
| public_test | 838 | Không | `public_test.csv` |
| private_test | 1,257 | Không | `private_test.csv` |

Public chiếm 40.0000% tổng test; private là phần còn lại. ID là chuỗi duy nhất toàn bộ đề; không chuyển sang số. `sample_submission.csv` là alias cho public; private có tệp mẫu riêng. Train và validation lấy từ hai split nguồn tương ứng. Test dùng toàn bộ eval hợp lệ; lọc input trùng và chia theo nhóm target, phân tầng register; giữ cả light/heavy theo nhóm. Loại giao input/target từ train với validation/test.

## 4. Chấm điểm

Chuẩn hóa cả dự đoán và nhãn bằng Unicode NFC, sau đó `" ".join(text.split())`: trim hai đầu và gộp mọi dãy whitespace Unicode thành một dấu cách ASCII. Giữ nguyên chữ hoa/thường, dấu tiếng Việt, dấu câu và từ vựng; không có bước sửa từ tự động.

Gọi pᵢ, yᵢ là chuỗi sau chuẩn hóa; d là khoảng cách Levenshtein với chi phí chèn/xóa/thay thế bằng 1. Đơn vị ký tự là Unicode code point sau NFC.

`CERᵢ = d(pᵢ,yᵢ)/max(|yᵢ|,1)`.

`Score = 100 × [1 − (1/N) Σᵢ min(1,CERᵢ)]`.

Metric phụ: `Exact Match = 100/N × Σᵢ 1[pᵢ = yᵢ]`; `WER = Σᵢ d(words(pᵢ),words(yᵢ)) / Σᵢ |words(yᵢ)|`, tách từ bằng khoảng trắng. WER là tỷ số lỗi trên toàn corpus, có thể lớn hơn 1; CER được clip từng mẫu trước khi lấy trung bình.

Thứ tự CSV không ảnh hưởng điểm; đối sánh bằng ID. File nộp phải có đúng header `id,text`, đầy đủ ID của split, không có ID thừa/trùng, không có prediction rỗng hoặc chỉ chứa whitespace. CSV có lỗi bị từ chối, không tự sửa hoặc bỏ dòng.

## 5. Tạo submission

```python
import pandas as pd
from pathlib import Path
root = Path('/kaggle/working/oai')
test = pd.read_csv(root / 'public_test.csv', dtype=str, keep_default_na=False)
predictions = test["input"].tolist()  # chỉ minh họa định dạng
pd.DataFrame({'id': test['id'], 'text': predictions}).to_csv('submission.csv', index=False)
```

Đây là mẫu kiểm tra định dạng, không phải lời giải. Để chấm private, dùng `private_test.csv` và nộp đủ ID của private. Không gộp hai split trong một lần chấm.

## 6. Quy định mô hình

Được dùng mô hình pretrained công khai và fine-tune; khai báo model, nguồn và giấy phép. Không được truy xuất nhãn test từ dataset gốc, Internet hoặc huấn luyện bằng tập eval gốc. Không dùng mô hình correction đã được fine-tune trên đúng corpus đánh giá này mà không khai báo; ưu tiên pretrained tổng quát để so sánh công bằng. Không gọi dịch vụ bên ngoài để tìm đáp án. Đề luyện không có cơ chế cưỡng chế chống tra cứu: nguồn và nhãn gốc là công khai. Không có leaderboard Kaggle Competition; chấm public/private chạy local ở phía organizer.

Gợi ý hướng tiếp cận: ByT5, ViT5, BARTpho hoặc Seq2Seq khác; kiểm tra tokenizer tiếng Việt, độ dài sau tokenize, truncation và loss mask. Không tự động lowercase, bỏ dấu hoặc chuẩn hóa dấu câu. Padding/truncation không được làm mất đoạn cần phục hồi.

Độ khó được thiết kế theo đa dạng cấu trúc/độ dài hoặc mức CER của nhiễu; chưa có thử nghiệm huấn luyện để xác nhận thời gian hoặc điểm baseline trên GPU cụ thể. Chọn checkpoint, batch size và giới hạn độ dài phù hợp ngân sách 6 giờ.

## 7. Kaggle Notebook

Add Input dataset tương ứng, rồi giải nén ZIP (một lớp):

```python
from pathlib import Path
import zipfile
archive = next(Path('/kaggle/input').rglob('vietnamese-text-restoration-oai.zip'))
with zipfile.ZipFile(archive) as z:
    z.extractall('/kaggle/working/oai')
import pandas as pd
train = pd.read_csv('/kaggle/working/oai/train.csv', dtype=str, keep_default_na=False)
print(train.head())
```

Đọc chuỗi từ `train["input"]` và `train["target"]`; dùng UTF-8, không dùng mã hóa ASCII.

## 8. Công cụ chấm phía organizer

Cài dependencies: `python -m pip install -r requirements.txt`. Công cụ `score.py` không chứa đáp án. Người luyện có thể tự chấm validation bằng cách tạo file đáp án `id,text` từ nhãn validation. Organizer chạy từ workspace:

```bash
python tools/score.py --submission submission.csv --split public
python tools/score.py --submission submission.csv --split private
```

Khi chuyển máy, dùng `--answers-dir /duong/dan/organizer` hoặc biến `OAI_ORGANIZER_ROOT` trỏ tới thư mục cha của `math_ocr` và `vietnamese_restoration`. Không đặt đáp án bên trong gói phát hành. Đáp án public/private không được phân phối cho thí sinh; công cụ sẽ báo lỗi thiếu tệp nếu máy không có đáp án.

## 9. Nguồn, trích dẫn, giấy phép

Nguyen, Viet-Anh và Neural Research Lab (2026): *Vietnamese spell-correction training pairs* và *Vietnamese spell-correction evaluation grid*. Nhiễu tổng hợp bằng `nom.text.noise` của https://github.com/nrl-ai/nom-vn (mã Apache-2.0). Trích dẫn hai dataset Hugging Face ở dưới cùng tác giả và năm trên.

Nguồn clean train: `hirine/wikipedia-vietnamese-1M296K-dataset` (Wikipedia, CC BY-SA 4.0), https://huggingface.co/datasets/hirine/wikipedia-vietnamese-1M296K-dataset; `tmnam20/Vietnamese-News-dedup` (CC BY 4.0), https://huggingface.co/datasets/tmnam20/Vietnamese-News-dedup. Eval: câu business do nom-vn biên soạn (CC0), UDHR tiếng Việt trên Wikisource (public domain), Tatoeba và cộng tác viên (CC BY 2.0 FR, https://tatoeba.org/), UD Vietnamese VTB (CC BY-SA 4.0, https://github.com/UniversalDependencies/UD_Vietnamese-VTB). Theo dataset card, tập hợp được phát hành CC BY-SA 4.0; giữ nguyên attribution các nguồn thành phần.

Các biến thể có cùng target được giữ trong cùng một phần test. Bản chuyển đổi chuẩn hóa NFC/whitespace, loại input trùng, lọc control character; không sửa dấu câu hoặc nội dung nhãn. Nhiễu nguồn chủ yếu được sinh tổng hợp, không đại diện đầy đủ lỗi ngoài đời.

Nguồn:
- https://huggingface.co/datasets/nrl-ai/vn-spell-correction-train
- https://huggingface.co/datasets/nrl-ai/vn-spell-correction-eval

Giấy phép dữ liệu và bản chuyển đổi: **CC-BY-SA-4.0**, https://creativecommons.org/licenses/by-sa/4.0/. Tuân thủ attribution, dẫn giấy phép và chỉ rõ thay đổi; khi chia sẻ bản phái sinh giữ điều kiện ShareAlike.  Không áp đặt hạn chế bổ sung lên quyền được giấy phép cho phép. Bản quyền nguồn được giữ nguyên; không có bảo đảm về độ chính xác mọi nhãn. Các thay đổi bản này: lọc lỗi/trùng, lấy mẫu seed 42, chia tập, đổi định dạng, tạo ID và tài liệu tiếng Việt.

## 10. Kiểm chứng và giới hạn

`manifest.json` chứa số mẫu, phiên bản, nguồn và SHA256 từng tệp (ngoại trừ chính manifest). Chạy `python validate_dataset.py --root .` để kiểm tra dữ liệu đã giải nén. Kiểm tra leakage đầy đủ với nhãn test cần `--answers-dir` phía organizer. Phép kiểm tra leakage là exact-match sau chuẩn hóa và hash pixel ảnh, không chứng minh không có paraphrase, biểu thức tương đương hoặc ảnh gần trùng. Không có người kiểm duyệt thủ công từng nhãn. Không sử dụng bộ đề này để xếp hạng kín có tính bảo mật, do dữ liệu nguồn vốn công khai.

# ĐỀ LUYỆN OLYMPIC TRÍ TUỆ NHÂN TẠO — Mathematical Expression Recognition

Phiên bản 1.0.0 · Seed 42 · Thời gian luyện đề đề xuất: 6 giờ · Một GPU Kaggle/Colab.
Đây là đề luyện độc lập, không phải đề được một ban tổ chức OAI chính thức chứng nhận.

## 1. Bài toán và bối cảnh

Nhận diện toàn bộ biểu thức toán học viết tay từ ảnh và sinh chuỗi LaTeX. Đây là bài toán Image-to-Sequence với cấu trúc không gian hai chiều: chỉ số, phân số và căn cần được đọc đúng quan hệ.

Ứng dụng: số hóa bài làm, tài liệu khoa học và hỗ trợ nhập công thức từ nét viết tay. Thí sinh xây dựng mô hình tổng quát hóa trên dữ liệu chưa thấy.

## 2. Input và output

Input: ảnh RGB PNG của toàn bộ biểu thức, đường dẫn tương đối trong `image_path`.
Output: chuỗi LaTeX trong cột `latex` khi huấn luyện. Submission dùng cột `text` chung cho cả hai bài.

Ví dụ train thực tế (JSON biểu diễn một dòng CSV, không phải định dạng nộp):

```json
{
  "id": "train_000001",
  "image_path": "images/train/000001.png",
  "latex": "h_{o}^{2}=\\frac{2L^{2}k_{o}}{rD_{c}C_{o}}"
}
```

## 3. Dữ liệu và cách chia

| Tập | Số mẫu | Có nhãn | Tệp |
|---|---:|---|---|
| train | 25,000 | Có | `train.csv` |
| validation | 2,000 | Có | `validation.csv` |
| public_test | 800 | Không | `public_test.csv` |
| private_test | 1,200 | Không | `private_test.csv` |

Public chiếm 40.0000% tổng test; private là phần còn lại. ID là chuỗi duy nhất toàn bộ đề; không chuyển sang số. `sample_submission.csv` là alias cho public; private có tệp mẫu riêng. Ảnh giữ nguyên kích thước/tỷ lệ nguồn, xuất PNG lossless từ pixel JPEG đã giải mã. Ưu tiên test → validation → train khi loại trùng nhãn/ảnh; lấy mẫu theo nhóm cấu trúc và độ dài, giữ ranh giới split nguồn.

## 4. Chấm điểm

Với mỗi mẫu, chuẩn hóa NFC và chỉ bỏ whitespace ở hai đầu chuỗi; giữ nguyên whitespace bên trong, dấu ngoặc, lệnh và ký tự. Tokenizer quét từ trái sang phải theo regex `\\[a-zA-Z]+|\\[^a-zA-Z]|[\s\S]`: một lệnh bắt đầu bằng backslash và dãy chữ ASCII là một token; backslash kèm một ký tự khác là một token; mỗi ký tự còn lại (kể cả khoảng trắng) là một token. Ví dụ `\frac{a}{b}` → `\frac`, `{`, `a`, `}`, `{`, `b`, `}`. Không biến đổi `\dfrac` thành `\frac`, không bỏ ngoặc và không suy diễn tương đương đại số.

Gọi Pᵢ, Yᵢ là hai dãy token dự đoán và nhãn; d là khoảng cách Levenshtein (chèn, xóa, thay thế đều có chi phí 1). Điểm chính:

`Score = 100/N × Σᵢ [1 − d(Pᵢ,Yᵢ)/max(|Pᵢ|,|Yᵢ|,1)]`.

Metric phụ: `Exact Match = 100/N × Σᵢ 1[Pᵢ = Yᵢ]`. Đây là độ khớp chuỗi token, không phải tương đương toán học. Khoảng trắng nội bộ được tính để tránh làm mất ý nghĩa của các lệnh văn bản như `\text{a b}`.

Thứ tự CSV không ảnh hưởng điểm; đối sánh bằng ID. File nộp phải có đúng header `id,text`, đầy đủ ID của split, không có ID thừa/trùng, không có prediction rỗng hoặc chỉ chứa whitespace. CSV có lỗi bị từ chối, không tự sửa hoặc bỏ dòng.

## 5. Tạo submission

```python
import pandas as pd
from pathlib import Path
root = Path('/kaggle/working/oai')
test = pd.read_csv(root / 'public_test.csv', dtype=str, keep_default_na=False)
predictions = ["x"] * len(test)  # chỉ minh họa định dạng
pd.DataFrame({'id': test['id'], 'text': predictions}).to_csv('submission.csv', index=False)
```

Đây là mẫu kiểm tra định dạng, không phải lời giải. Để chấm private, dùng `private_test.csv` và nộp đủ ID của private. Không gộp hai split trong một lần chấm.

## 6. Quy định mô hình

Được dùng mô hình pretrained công khai và fine-tune; khai báo model, nguồn và giấy phép. Không được truy xuất nhãn test từ dataset gốc, Internet hoặc huấn luyện bằng tập eval gốc. Không dùng mô hình correction đã được fine-tune trên đúng corpus đánh giá này mà không khai báo; ưu tiên pretrained tổng quát để so sánh công bằng. Không gọi dịch vụ bên ngoài để tìm đáp án. Đề luyện không có cơ chế cưỡng chế chống tra cứu: nguồn và nhãn gốc là công khai. Không có leaderboard Kaggle Competition; chấm public/private chạy local ở phía organizer.

Gợi ý hướng tiếp cận: CNN/ViT encoder kết hợp Transformer decoder hoặc attention; dùng padding giữ tỷ lệ, augmentation không làm mất cấu trúc, chú ý giải mã EOS, ngoặc và backslash. Đây không phải OCR ký tự đơn.

Độ khó được thiết kế theo đa dạng cấu trúc/độ dài hoặc mức CER của nhiễu; chưa có thử nghiệm huấn luyện để xác nhận thời gian hoặc điểm baseline trên GPU cụ thể. Chọn checkpoint, batch size và giới hạn độ dài phù hợp ngân sách 6 giờ.

## 7. Kaggle Notebook

Add Input dataset tương ứng, rồi giải nén ZIP (một lớp):

```python
from pathlib import Path
import zipfile
archive = next(Path('/kaggle/input').rglob('math-ocr-oai.zip'))
with zipfile.ZipFile(archive) as z:
    z.extractall('/kaggle/working/oai')
import pandas as pd
train = pd.read_csv('/kaggle/working/oai/train.csv', dtype=str, keep_default_na=False)
print(train.head())
```

Đọc ảnh: `Image.open(root / train.iloc[0]["image_path"]).convert("RGB")` sau `from PIL import Image`.

## 8. Công cụ chấm phía organizer

Cài dependencies: `python -m pip install -r requirements.txt`. Công cụ `score.py` không chứa đáp án. Người luyện có thể tự chấm validation bằng cách tạo file đáp án `id,text` từ nhãn validation. Organizer chạy từ workspace:

```bash
python tools/score.py --submission submission.csv --split public
python tools/score.py --submission submission.csv --split private
```

Khi chuyển máy, dùng `--answers-dir /duong/dan/organizer` hoặc biến `OAI_ORGANIZER_ROOT` trỏ tới thư mục cha của `math_ocr` và `vietnamese_restoration`. Không đặt đáp án bên trong gói phát hành. Đáp án public/private không được phân phối cho thí sinh; công cụ sẽ báo lỗi thiếu tệp nếu máy không có đáp án.

## 9. Nguồn, trích dẫn, giấy phép

Google LLC là đơn vị cấp phép MathWriting; tác giả công trình: Philippe Gervais, Anastasiia Fadeeva, Andrii Maksai. Bản render Hugging Face do `deepcopy` cung cấp. Trích dẫn: *MathWriting: A Dataset For Handwritten Mathematical Expression Recognition*, arXiv:2404.10690, https://arxiv.org/abs/2404.10690. Nguồn chính thức: https://github.com/google-research/google-research/tree/master/mathwriting. Nhãn lấy từ Wikipedia theo CC BY-SA 4.0 được ghi nhận trong archive_readme của nguồn.

Bản chuyển đổi này lấy mẫu, lọc trùng, xuất PNG từ ảnh JPEG đã có; không tăng chất lượng thông tin, không crop hoặc resize. Ảnh render nguồn có thể có nhiễu nét và màu. Không bảo đảm mọi nhãn đều biên dịch trong một preamble LaTeX bất kỳ; kiểm tra tự động chỉ xác nhận chuỗi không rỗng, ngoặc cân bằng và ảnh giải mã được.

Nguồn:
- https://huggingface.co/datasets/deepcopy/MathWriting-human

Giấy phép dữ liệu và bản chuyển đổi: **CC-BY-NC-SA-4.0**, https://creativecommons.org/licenses/by-nc-sa/4.0/. Tuân thủ attribution, dẫn giấy phép và chỉ rõ thay đổi; khi chia sẻ bản phái sinh giữ điều kiện ShareAlike. Không sử dụng thương mại. Không áp đặt hạn chế bổ sung lên quyền được giấy phép cho phép. Bản quyền nguồn được giữ nguyên; không có bảo đảm về độ chính xác mọi nhãn. Các thay đổi bản này: lọc lỗi/trùng, lấy mẫu seed 42, chia tập, đổi định dạng, tạo ID và tài liệu tiếng Việt.

## 10. Kiểm chứng và giới hạn

`manifest.json` chứa số mẫu, phiên bản, nguồn và SHA256 từng tệp (ngoại trừ chính manifest). Chạy `python validate_dataset.py --root .` để kiểm tra dữ liệu đã giải nén. Kiểm tra leakage đầy đủ với nhãn test cần `--answers-dir` phía organizer. Phép kiểm tra leakage là exact-match sau chuẩn hóa và hash pixel ảnh, không chứng minh không có paraphrase, biểu thức tương đương hoặc ảnh gần trùng. Không có người kiểm duyệt thủ công từng nhãn. Không sử dụng bộ đề này để xếp hạng kín có tính bảo mật, do dữ liệu nguồn vốn công khai.

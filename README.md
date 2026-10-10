# OAI — Local Grading System

Hệ thống chấm local và online cho DeepWeeds, Spam Review, ViLexNorm và Ghost of the Machine. Ba tác vụ ban đầu: DeepWeeds (phân loại ảnh 9 lớp), Vietnamese Spam Review Detection (4 nhãn `0`–`3`) và ViLexNorm (chuẩn hóa từ vựng tiếng Việt). Hai bài phân loại có Public/Private Test và dùng Macro-F1; ViLexNorm có một Test Set và dùng Error Reduction Rate (ERR).

## 1. Cài đặt

```bash
cd OAI_T7/grader_web
python3 -m pip install -r requirements.txt
```

## 2. Chạy

### Web nộp bài + bảng xếp hạng (khuyên dùng)

```bash
GRADER_DATA_ROOT=~/Downloads/OAI_T7 python3 server.py --port 8000
```

Mở <http://localhost:8000>. Web có hai tab: **Nộp bài** (chọn đội trong `teams.json`, tác vụ, tập đánh giá và file CSV/ZIP để nhận điểm cùng thứ hạng) và **Bảng xếp hạng** (rank theo từng tác vụ và lịch sử nộp). Mọi lần nộp được lưu ở `results/submissions/`.

`GRADER_DATA_ROOT` là thư mục chứa `Tac_vu_1_CV/`, `Tac_vu_2_NLP/` và `T5/OAI_ViLexNorm/` (mặc định là thư mục cha của repo). `MAX_DAILY_SUBMISSIONS` giới hạn số bài hợp lệ/ngày/đội/tập (mặc định không giới hạn).

Tab **Nộp bài** hiển thị luôn *Yêu cầu file nộp* (định dạng, cột, số dòng, danh sách nhãn, ví dụ) và *Chỉ số đánh giá* (công thức Macro-F1, cách xếp hạng) theo tác vụ/tập đang chọn.

### Mật khẩu

Cả trang (xem bảng xếp hạng và nộp bài) cần mật khẩu. Không dùng database: mật khẩu nằm trong file `.grader_password` (đã gitignore), tự sinh ở lần chạy đầu và in ra terminal. Đổi mật khẩu: sửa file đó (hoặc đặt biến `GRADER_PASSWORD`) rồi khởi động lại server; người đang đăng nhập sẽ phải nhập lại.

Bản tĩnh trên github.io không có server, nên `leaderboard.json` được mã hóa AES-256-GCM bằng mật khẩu (secret `GRADER_PASSWORD` của repo) và trình duyệt giải mã sau khi đăng nhập. Nhớ cập nhật secret khi đổi mật khẩu:

```bash
gh secret set GRADER_PASSWORD < .grader_password
```

### App Streamlit cho ban tổ chức (có F1 theo lớp, confusion matrix)

```bash
python3 -m streamlit run app.py --server.address 0.0.0.0
```

Truy cập trên chính máy đang chạy: <http://localhost:8501>. Thiết bị khác trong cùng mạng LAN dùng `Network URL` mà Streamlit in ra khi khởi động.

## 3. Cách dùng

1. Nhập **Tên đội** và chọn tác vụ.
2. Chọn Public/Private Test cho bài phân loại; ViLexNorm dùng Test Set duy nhất.
3. Upload file CSV, hoặc ZIP chứa đúng một file có tên `submission.csv` hay `output.csv`.
4. Bấm **Chấm điểm**.

Nhãn hợp lệ: DeepWeeds `Chinee apple, Lantana, Negative, Parkinsonia, Parthenium, Prickly acacia, Rubber vine, Siam weed, Snake weed`; Spam Review `0, 1, 2, 3`. ViLexNorm nhận câu chuẩn hóa tự do trong cột `normalized`. Số dòng: DeepWeeds public 2,715 / private 2,748; Spam Review public 1,590 / private 3,974; ViLexNorm test 1,044.

Hệ thống kiểm tra schema, số dòng, ID thiếu/lạ/trùng, prediction rỗng và label không hợp lệ trước khi chấm. Dự đoán được căn theo ID nên submission có thể sắp xếp dòng theo thứ tự bất kỳ. Hai bài phân loại dùng Macro-F1 (`sklearn.metrics.f1_score(average="macro")`). ViLexNorm dùng evaluator chính thức trong `T5/OAI_ViLexNorm/organizer/evaluate.py`: ERR là mức cải thiện token accuracy so với baseline Leave-As-Is; Token Accuracy, Normalization Precision và Normalization Recall là metric phụ.

Mọi lần chấm (kể cả không hợp lệ) đều được lưu vào `results/submissions/`; tab **Bảng xếp hạng** hiển thị rank và lịch sử nộp.

## Schema thực tế

- CV: `image_id,label`
- NLP: `id,label`
- ViLexNorm: `id,normalized`

Không đặt ground truth hoặc grader lên máy công khai nếu private labels cần được bảo mật.

## 4. Chia sẻ tạm cho team trong một buổi tối

Cách nhanh nhất là chạy app trên máy tổ chức và mở một Cloudflare Quick Tunnel có URL tạm. Ground truth vẫn nằm trên máy; team chỉ nhận URL và mật khẩu dùng chung.

Yêu cầu: Python 3 và Node.js/npm (`npx`). Chạy:

```bash
cd OAI_T7/grader_web
chmod +x run_team_grader.sh
./run_team_grader.sh
```

Lần đầu script sẽ tạo `.venv-team`, cài dependencies, sinh mật khẩu ngẫu nhiên, chạy Streamlit và in URL `https://...trycloudflare.com`. Gửi URL cùng mật khẩu cho team. Phải giữ máy và terminal hoạt động trong suốt buổi luyện tập.

Dừng bằng `Ctrl+C`; URL tạm sẽ ngừng hoạt động. Có thể tự chọn mật khẩu hoặc port:

```bash
GRADER_PASSWORD='mat-khau-cua-team' GRADER_PORT=8501 ./run_team_grader.sh
```

Quick Tunnel chỉ phù hợp cho buổi luyện tập ngắn, không có cam kết uptime. Không công khai URL rộng rãi và nên đổi mật khẩu mỗi buổi.

## 5. Bảng xếp hạng online trên github.io (CI/CD)

GitHub Pages chỉ host trang tĩnh, nên hệ thống online hoạt động như sau:

```
Đội mở Issue "Nộp bài chấm điểm", chọn Đội/Tác vụ/Tập, đính kèm CSV/ZIP (hoặc dán link raw của Gist)
  → GitHub Actions (grade.yml) giải mã dữ liệu chấm bằng secret, chấm điểm
  → lưu kết quả vào results/submissions/gh-<số issue>.json (commit vào main)
  → comment điểm + thứ hạng vào issue, gắn nhãn, đóng issue
  → pages.yml build lại trang và deploy lên https://<owner>.github.io/<repo>/
```

- Đáp án được mã hóa AES-256 (`secure/ground_truth.tar.gz.enc`) nên commit vào repo public vẫn an toàn; khóa chỉ nằm trong secret `GRADER_DATA_KEY` và file `.grader_data_key` (đã gitignore) trên máy tổ chức.
- `ci.yml` chạy unit test mỗi lần push/PR.

### Xếp hạng

- DeepWeeds và Spam Review: lưu điểm tốt nhất trên **Public** và **Private** của mỗi đội; xếp hạng theo Private, hòa thì so Public, vẫn hòa thì đội đạt điểm sớm hơn đứng trên (cùng hạng nếu bằng cả hai điểm). Đội chưa có điểm Private hiển thị cuối bảng, chưa có hạng.
- ViLexNorm: xếp hạng theo ERR tốt nhất trên Test Set; hòa điểm thì đội đạt điểm sớm hơn đứng trước.
- Giới hạn mặc định **5 bài hợp lệ/ngày cho mỗi đội, mỗi tác vụ, mỗi tập** (reset 00:00 giờ Việt Nam) để hạn chế dò đáp án Private. Đổi bằng biến `MAX_DAILY_SUBMISSIONS` (đặt `0` = không giới hạn) tại *Settings → Secrets and variables → Actions → Variables*.
- Danh sách đội nằm trong `teams.json` (hiện có: Kiên, Tùng, Thanh). Web local hiển thị các đội này trong ô chọn và chỉ chấp nhận các tên này. Khi nộp qua GitHub Issue, điền GitHub username của thành viên vào danh sách của từng đội để gom về đúng đội; để trống `[]` thì tên đội = GitHub username.

Trang github.io: <https://tung51652-alt.github.io/Ch-m-i-m-OAI/> (cần mật khẩu, giống bản local).

Trên trang, bấm **Chấm điểm** là chấm ngay trong trình duyệt (`site/grader.js`, cùng logic với `scoring.py`; dữ liệu chấm nằm trong payload đã mã hóa bằng mật khẩu). Với hai bài phân loại, nút **Lưu lên bảng xếp hạng** mở một issue đã điền mã dự đoán nén (`oai-pred:v1:…`). Với ViLexNorm, dự đoán là văn bản tự do và quá dài cho URL nên trang mở form Issue; người nộp chọn ViLexNorm / Test Set và đính kèm chính file CSV/ZIP vừa chấm. Actions luôn chấm lại bằng `scoring.py` trước khi lưu kết quả chính thức.

Nộp từ dòng lệnh thay vì kéo thả file:

```bash
gh gist create output.csv          # in ra https://gist.github.com/<user>/<id>
gh api gists/<id> --jq '.files[].raw_url'   # dán link raw này vào ô "File submission"
```

### Thiết lập lần đầu (chủ repo)

1. **Bật GitHub Pages** (cần quyền admin): *Settings → Pages → Build and deployment → Source* chọn **GitHub Actions**.
2. **Secret `GRADER_DATA_KEY`**: *Settings → Secrets and variables → Actions → New repository secret*, dán nội dung file `.grader_data_key`. Tạo khóa mới nếu chưa có:
   ```bash
   python3 -c "import secrets;print(secrets.token_urlsafe(32))" > .grader_data_key && chmod 600 .grader_data_key
   ```
   Cất khóa này ở nơi an toàn: mất khóa thì phải tạo khóa mới, mã hóa lại và cập nhật secret.
3. **Mã hóa và đẩy đáp án** từ máy có dữ liệu (cấu trúc thư mục như mục *Schema*, mặc định là thư mục cha của repo):
   ```bash
   ./scripts/pack_ground_truth.sh            # hoặc: ./scripts/pack_ground_truth.sh /đường/dẫn/thư-mục-dữ-liệu
   git add secure/ground_truth.tar.gz.enc
   git commit -m "Update ground truth" && git push
   ```
4. Đặt secret `GRADER_PASSWORD` (mật khẩu trang, dùng để mã hóa dữ liệu trên github.io): `gh secret set GRADER_PASSWORD < .grader_password`.
5. Vào tab **Actions → Deploy leaderboard to GitHub Pages → Run workflow** để deploy lần đầu (sau đó mỗi lần push lên `main` tự deploy).
6. Thử nộp một bài: *Issues → New issue → Nộp bài chấm điểm*.

### Vận hành

- **Chấm lại một issue** (ví dụ lúc đáp án chưa sẵn sàng, issue có nhãn `needs-organizer`): *Actions → Grade submission → Run workflow*, nhập số issue.
- **Xóa một lần nộp**: xóa file `results/submissions/gh-<số issue>.json`, commit và push; trang tự build lại.
- **Xem trước trang github.io trên máy**: chạy `GRADER_PASSWORD='mật-khẩu' python3 scripts/build_site.py --out _site`, sau đó `python3 -m http.server 8000 -d _site` và mở <http://localhost:8000>.
- **Xem toàn bộ lịch sử**: trên trang github.io (mục *Lịch sử nộp bài*) hoặc thư mục `results/submissions/`.
- Lưu ý: issue là công khai, nên các đội có thể tải file dự đoán của nhau. Điểm Private hiện công khai ngay khi nộp.

### Chạy test

```bash
python3 -m unittest discover -p "test_*.py"
```

Test dùng dữ liệu tổng hợp, không cần đáp án thật; các test với đáp án thật tự bỏ qua khi máy không có dữ liệu.

## 6. Trợ lý AI

Sau khi đăng nhập trang chấm điểm, bấm **Trợ lý AI** để chuyển sang chatbot tại
<https://chatbot-gamma-plum-29.vercel.app/> trong cùng tab.

Chatbot được triển khai riêng; dự án chấm điểm chỉ chứa liên kết đến trang này.

## 7. Ghost of the Machine (IOAI 2026)

Bài NLP tìm chỉ số ký tự nơi đoạn văn tiếng Anh chuyển từ người viết sang máy sinh.
Đã đối chiếu [README và đề IOAI](https://github.com/IOAI-official/IOAI-2026/tree/main/Individual-Contest/5_Ghost_of_Machine),
[checker gốc](https://github.com/IOAI-official/IOAI-2026/blob/main/Individual-Contest/5_Ghost_of_Machine/code/grading-original/checker.py),
[baseline gốc](https://github.com/IOAI-official/IOAI-2026/blob/main/Individual-Contest/5_Ghost_of_Machine/code/baseline-original/solution.ipynb)
và [dataset card](https://huggingface.co/datasets/IOAI-official/ioai-2026-ghost-of-the-machine).

- Train: 1.221 mẫu; dry-run: pretrain 200, pretest 60.
- **Public Test = Leaderboard A**, 380 mẫu, bảng điểm trực tiếp.
- **Private Test = Leaderboard B**, 380 mẫu, xếp hạng cuối.
- Nộp **answers.jsonl** UTF-8, mỗi dòng là `{"id":"example_000123","boundary_char_index":1790}`.
  Có thể dùng CSV `id,boundary_char_index` hoặc ZIP chứa đúng một `answers.jsonl`, `output.csv` hay `submission.csv`.
- Mỗi ID test đúng một lần; thứ tự tùy ý. Boundary là số nguyên trong `[0, len(text)]`,
  tính theo Unicode code point như Python; không tính theo byte, UTF-16 hay token.
- **Boundary Score = 100 × mean(exp(-abs(prediction - truth) / 100))**. Điểm cao hơn tốt hơn.
  MAE (ký tự) và Exact Match (%) là thông tin phụ. Lưu điểm đầy đủ, hiển thị 6 chữ số thập phân.
- Xếp hạng như các bài Public/Private trước: điểm B tốt nhất, rồi A, rồi thời điểm đạt điểm.

Trong cuộc thi gốc, người dự thi nộp `solution.ipynb` và grader chạy notebook để tạo `answers.jsonl`.
Website này chấm **file dự đoán đã xuất**, không thực thi notebook/GPU hay kiểm tra giới hạn model/thời gian.
Đề cho phép encoder `bge-base-en-v1.5`; baseline dùng trung bình vị trí tương đối trong train.

**Khác biệt validation:** đề nói mẫu thiếu/sai nhận 0, nhưng checker gốc từ chối toàn bài nếu
thiếu, trùng, lạ ID hoặc không chuyển được prediction thành số nguyên. Website theo checker ở việc
kiểm tra ID, và kiểm tra số nguyên/phạm vi chặt theo đề: không tự cắt phần thập phân hay chấp nhận bool.
Công thức và thang điểm của bài hợp lệ khớp checker gốc.

Dữ liệu local mặc định: `../nlp/GhostofMachine/ioai_ghost/`; có thể đổi thư mục gốc bằng `GRADER_DATA_ROOT`.
Gói chấm mã hóa chứa `private/test_leaderboard_{a,b}/data.jsonl` và hai file đáp án tương ứng.
Trang có gói tải `ghost/dataset.zip` chứa train/dry-run và đầu vào A/B, **không có đáp án A/B**.
Dữ liệu IOAI được phát hành theo **CC BY 4.0**; giữ ghi công trong gói tải.

Kiểm tra UI Ghost bằng Chromium (cài Playwright ở môi trường kiểm thử):

```bash
SITE_URL=http://localhost:8000/ GRADER_PASSWORD='mật-khẩu' node scripts/test_ghost_pages.cjs
```

Smoke test này dùng **bản build tĩnh mã hóa**, xác nhận điểm 100 trên A/B cho JSONL/CSV/ZIP,
đảo dòng, từ chối ID thiếu, hiển thị bảng xếp hạng và điền sẵn form GitHub.

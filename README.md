# OAI T7 — Local Grading System

Web Streamlit chạy hoàn toàn trên máy local để chấm ba tác vụ OAI T7. DeepWeeds và Vietnamese Spam Review Detection có Public/Private Test; ViLexNorm có một Test Set. Ground truth chỉ được đọc nội bộ và không có chức năng tải xuống.

## 1. Cài đặt

```bash
cd OAI_T7/grader_web
pip install -r requirements.txt
```

## 2. Chạy

```bash
streamlit run app.py --server.address 0.0.0.0
```

Truy cập trên chính máy đang chạy:

<http://localhost:8501>

Truy cập từ thiết bị khác trong cùng mạng LAN:

<http://192.168.1.13:8501>

Địa chỉ IP LAN có thể thay đổi khi máy kết nối lại mạng. Có thể xem URL LAN mới trong phần `Network URL` mà Streamlit in ra khi khởi động.

## 3. Cách dùng

1. Nhập **Tên đội**, chọn một trong ba tác vụ.
2. Chọn Public/Private Test; với ViLexNorm selector được cố định ở Test Set.
3. Upload file CSV, hoặc ZIP chứa đúng một file có tên `submission.csv` hay `output.csv`.
4. Bấm **CHẤM ĐIỂM**.

Hệ thống kiểm tra schema, số dòng, ID thiếu/lạ/trùng, prediction rỗng và label không hợp lệ trước khi chấm. Dự đoán được căn theo ID nên submission có thể sắp xếp dòng theo thứ tự bất kỳ. Hai tác vụ phân loại dùng Macro F1; ViLexNorm dùng ERR và hiển thị thêm Token Accuracy, Normalization Precision, Normalization Recall.

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
Đội mở Issue "Nộp bài chấm điểm" + đính kèm CSV/ZIP
  → GitHub Actions (grade.yml) giải mã đáp án bằng secret, chấm điểm
  → lưu kết quả vào results/submissions/gh-<số issue>.json (commit vào main)
  → comment điểm + thứ hạng vào issue, gắn nhãn, đóng issue
  → pages.yml build lại trang và deploy lên https://<owner>.github.io/<repo>/
```

- Đáp án được mã hóa AES-256 (`secure/ground_truth.tar.gz.enc`) nên commit vào repo public vẫn an toàn; khóa chỉ nằm trong secret `GRADER_DATA_KEY` và file `.grader_data_key` (đã gitignore) trên máy tổ chức.
- `ci.yml` chạy unit test mỗi lần push/PR.

### Xếp hạng

- DeepWeeds và Spam Review: lưu điểm tốt nhất trên **Public** và **Private** của mỗi đội; xếp hạng theo Private, hòa thì so Public, vẫn hòa thì đội đạt điểm sớm hơn đứng trên (cùng hạng nếu bằng cả hai điểm). Đội chưa có điểm Private hiển thị cuối bảng, chưa có hạng.
- ViLexNorm: xếp hạng theo điểm ERR tốt nhất trên Test Set.
- Giới hạn mặc định **5 bài hợp lệ/ngày cho mỗi đội, mỗi tác vụ, mỗi tập** (reset 00:00 giờ Việt Nam) để hạn chế dò đáp án Private. Đổi bằng biến `MAX_DAILY_SUBMISSIONS` (đặt `0` = không giới hạn) tại *Settings → Secrets and variables → Actions → Variables*.
- Mặc định tên đội = GitHub username. Muốn gom nhiều thành viên vào một đội hoặc chỉ cho phép đội đã đăng ký: copy `teams.example.json` thành `teams.json`, sửa rồi commit.

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
4. Vào tab **Actions → Deploy leaderboard to GitHub Pages → Run workflow** để deploy lần đầu.
5. Thử nộp một bài: *Issues → New issue → Nộp bài chấm điểm*.

### Vận hành

- **Chấm lại một issue** (ví dụ lúc đáp án chưa sẵn sàng, issue có nhãn `needs-organizer`): *Actions → Grade submission → Run workflow*, nhập số issue.
- **Xóa một lần nộp**: xóa file `results/submissions/gh-<số issue>.json`, commit và push; trang tự build lại.
- **Xem toàn bộ lịch sử**: trên trang github.io (mục *Lịch sử nộp bài*) hoặc thư mục `results/submissions/`.
- Lưu ý: issue là công khai, nên các đội có thể tải file dự đoán của nhau. Điểm Private hiện công khai ngay khi nộp.

### Chạy test

```bash
python -m unittest discover -p "test_*.py"
```

Test dùng dữ liệu tổng hợp, không cần đáp án thật; các test với đáp án thật tự bỏ qua khi máy không có dữ liệu.

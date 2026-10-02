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

1. Chọn một trong ba tác vụ.
2. Chọn Public/Private Test; với ViLexNorm selector được cố định ở Test Set.
3. Upload file CSV, hoặc ZIP chứa đúng một file có tên `submission.csv` hay `output.csv`.
4. Bấm **CHẤM ĐIỂM**.

Hệ thống kiểm tra schema, số dòng, ID thiếu/lạ/trùng, prediction rỗng và label không hợp lệ trước khi chấm. Dự đoán được căn theo ID nên submission có thể sắp xếp dòng theo thứ tự bất kỳ. Hai tác vụ phân loại dùng Macro F1; ViLexNorm dùng ERR và hiển thị thêm Token Accuracy, Normalization Precision, Normalization Recall.

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

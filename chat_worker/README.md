# OAI T7 Chat Worker

Backend serverless cho trang `site/chat.html`. Worker gọi đúng model DeepSeek-R1-Distill-Qwen-32B qua Cloudflare Workers AI binding, stream phản hồi và dùng D1 để áp giới hạn token theo phiên. Không cần Hugging Face/OpenRouter API key, không có model chạy local. Nội dung câu hỏi và câu trả lời không được ghi vào D1.

## Thiết lập Cloudflare

Yêu cầu Node.js và một tài khoản Cloudflare:

```bash
cd chat_worker
cp wrangler.toml.example wrangler.toml
npx wrangler login
npx wrangler d1 create oai-t7-chat
```

Chép `database_id` từ lệnh trên vào `wrangler.toml`, sau đó chạy migration:

```bash
npx wrangler d1 migrations apply oai-t7-chat --remote
```

Tạo hai secret khác nhau (không dùng lại khóa quản trị làm khóa ký session):

```bash
npx wrangler secret put SESSION_SIGNING_KEY
npx wrangler secret put ADMIN_KEY
```

Kiểm tra lại `ALLOWED_ORIGINS` trong `wrangler.toml`. Origin của GitHub Pages chỉ gồm scheme và hostname, không có path repository. Deploy:

```bash
npx wrangler deploy
```

Không commit `wrangler.toml` hoặc `.dev.vars`; hai file này đã được gitignore.

Khi chuyển một Worker cũ sang Workers AI: thêm `[ai]` binding như file mẫu, giữ nguyên `database_id`, `SESSION_SIGNING_KEY` và `ADMIN_KEY`, rồi chạy migration **0002_daily_usage.sql** trước khi deploy. Ticket/session hiện có được giữ nguyên. Các secret HF/OpenRouter cũ không được code mới sử dụng; không cần nhập API key mới.

`GET /health` trả tên provider/model và trạng thái binding; đây chỉ là kiểm tra cấu hình, không chứng minh model đang trả lời được. Hãy thử một ticket kiểm thử riêng sau deploy, không tiêu hao quota ticket thi thật.

## Nối với GitHub Pages

Lấy URL Worker sau khi deploy, ví dụ `https://oai-t7-chat.<account>.workers.dev`. Trong repository GitHub, tạo Actions variable:

```text
CHAT_API_URL=https://oai-t7-chat.<account>.workers.dev
```

Chạy lại workflow `Deploy leaderboard to GitHub Pages`. `scripts/build_site.py` sẽ ghi URL này vào file cấu hình công khai. File đó chỉ chứa URL Worker, không chứa secret.

## Cấp ticket thi

Endpoint quản trị sinh ticket và chỉ lưu SHA-256 của ticket vào D1:

```bash
curl -X POST "https://oai-t7-chat.<account>.workers.dev/api/admin/tickets" \
  -H "Authorization: Bearer <ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"label":"Đội Tùng","count":1,"expiresAt":"2026-10-03T12:00:00+07:00"}'
```

Ticket rõ chỉ được trả về trong response này. Gửi riêng ticket cho đội tương ứng. Một ticket đã mở sẽ quay về session đang hoạt động và không làm mới quota khi tải lại trang. Khi session dùng hết quota, người dùng có thể bấm **Tạo phiên mới**; nếu session đã hết hạn, nhập lại cùng ticket để mở session mới.

## Chạy local

```bash
cd chat_worker
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars
```

Đổi `PRACTICE_MODE = "true"` trong `wrangler.toml`, tạo D1 local rồi chạy:

```bash
npx wrangler d1 migrations apply oai-t7-chat --local
npx wrangler dev
```

Build site trỏ tới Worker local:

```bash
CHAT_API_URL=http://localhost:8787 python3 scripts/build_site.py --out _site
python3 -m http.server 8000 -d _site
```

Practice mode không yêu cầu ticket và không phù hợp cho thi thật.

Binding `AI` có `remote = true`: **dù Worker và D1 chạy local, inference vẫn chạy trên Cloudflare và dùng quota thật**. Unit test bên dưới dùng mock, không gọi model:

```bash
node --test test_chat.js chat_worker/test/*.test.mjs
```

Chạy lệnh test từ thư mục gốc repository.

## Biến cấu hình

- `SESSION_TOKEN_LIMIT`: tổng completion token mỗi session, mặc định `2000`.
- `TURN_TOKEN_LIMIT`: số completion token tối đa một lượt, mặc định `768`.
- `SESSION_TTL_SECONDS`: thời lượng session, mặc định 3 giờ.
- `PROVIDER_TIMEOUT_MS`: timeout toàn bộ lượt stream, mặc định 90 giây.
- Model cố định trong `src/core.mjs`: `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`.
- `DAILY_NEURON_LIMIT`: trần neuron/ngày của chatbox, mặc định `9000`, chỉ chấp nhận `1..10000`.
- `PRACTICE_MODE`: phải là `false` ở production.

Khi provider không trả usage cuối stream, Worker tính toàn bộ reservation của lượt đó để tránh vượt quota. Mỗi session chỉ được có một request đang chạy.

Mỗi session có quota độc lập. Endpoint `POST /api/session/new` chỉ cấp session kế tiếp khi session đã xác thực dùng hết token; ticket bị khóa hoặc hết hạn không thể tạo thêm session. Các session cũ vẫn được giữ trong D1 để kiểm toán.

## Quota miễn phí và ngân sách ngày

Cloudflare cấp **10.000 neuron/ngày cho toàn tài khoản**, reset lúc **00:00 UTC (07:00 Việt Nam)**. Đây không phải 10.000 token hay một số request cố định. Với model này, mức hiện tại là 45.170 neuron/M input token và 443.756 neuron/M output token; output gồm cả suy luận. Xem [giá Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/) và [model](https://developers.cloudflare.com/workers-ai/models/deepseek-r1-distill-qwen-32b/).

Ứng dụng giới hạn mặc định **9.000 neuron/ngày**, chừa 1.000 neuron đệm. D1 chỉ ghi tổng chi phí ngày, không lưu nội dung chat. Trước khi gọi model, Worker giữ trước chi phí bảo thủ dựa trên số byte UTF-8 đầu vào, phần đệm chat template và output tối đa; cuối stream quyết toán bằng `usage.neurons` tổng kết của Cloudflare. Không cộng các usage từng-token vào usage tổng kết. Nếu mất kết nối/thiếu usage, giữ nguyên dự toán ngày để không đánh giá thấp chi phí. Vì cần giữ trước một lượt đầy đủ, chatbox có thể dừng sớm hơn trần ngày. Tạo session mới không làm mới ngân sách này.

Giới hạn này chỉ bao phủ **chatbox này**, không kiểm soát Workers AI dùng ở ứng dụng khác trên cùng tài khoản. Theo dõi tổng neuron tại **Cloudflare Dashboard → Workers AI**. Trên **Workers Free**, Cloudflare chặn khi hết quota; trên **Workers Paid**, phần vượt quota miễn phí toàn tài khoản có thể bị tính tiền. Quá trình triển khai không nâng gói, không bật AI Gateway billing, không tự chuyển provider trả phí.

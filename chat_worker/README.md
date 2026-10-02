# OAI T7 Chat Worker

Backend serverless cho trang `site/chat.html`. Worker giữ Hugging Face token, stream phản hồi và dùng D1 để áp giới hạn token theo phiên. Nội dung câu hỏi và câu trả lời không được ghi vào D1.

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

Tạo ba secret khác nhau. `HF_TOKEN` cần quyền gọi Hugging Face Inference Providers:

```bash
npx wrangler secret put HF_TOKEN
npx wrangler secret put SESSION_SIGNING_KEY
npx wrangler secret put ADMIN_KEY
```

Kiểm tra lại `ALLOWED_ORIGINS` trong `wrangler.toml`. Origin của GitHub Pages chỉ gồm scheme và hostname, không có path repository. Deploy:

```bash
npx wrangler deploy
```

Không commit `wrangler.toml` hoặc `.dev.vars`; hai file này đã được gitignore.

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

Ticket rõ chỉ được trả về trong response này. Gửi riêng ticket cho đội tương ứng. Một ticket đã mở sẽ luôn quay về cùng session và không làm mới quota khi tải lại trang.

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

## Biến cấu hình

- `SESSION_TOKEN_LIMIT`: tổng completion token mỗi session, mặc định `2000`.
- `TURN_TOKEN_LIMIT`: số completion token tối đa một lượt, mặc định `768`.
- `SESSION_TTL_SECONDS`: thời lượng session, mặc định 3 giờ.
- `PROVIDER_TIMEOUT_MS`: timeout toàn bộ lượt stream, mặc định 90 giây.
- `HF_MODEL`: model Hugging Face đầy đủ kèm provider.
- `PRACTICE_MODE`: phải là `false` ở production.

Khi provider không trả usage cuối stream, Worker tính toàn bộ reservation của lượt đó để tránh vượt quota. Mỗi session chỉ được có một request đang chạy.

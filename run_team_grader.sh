#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${GRADER_VENV_DIR:-${APP_DIR}/.venv-team}"
PORT="${GRADER_PORT:-8501}"
LOG_FILE="${GRADER_LOG_FILE:-/tmp/oai-t7-team-grader.log}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Không tìm thấy python3." >&2
  exit 1
fi
if ! command -v npx >/dev/null 2>&1; then
  echo "Không tìm thấy npx. Hãy cài Node.js 18+ rồi chạy lại." >&2
  exit 1
fi

if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  echo "[setup] Tạo virtual environment tại ${VENV_DIR}"
  python3 -m venv "${VENV_DIR}"
fi

if ! "${VENV_DIR}/bin/python" -c "import streamlit, pandas, sklearn" >/dev/null 2>&1; then
  echo "[setup] Cài dependencies..."
  "${VENV_DIR}/bin/python" -m pip install -r "${APP_DIR}/requirements.txt"
fi

if [[ -z "${GRADER_PASSWORD:-}" ]]; then
  GRADER_PASSWORD="$("${VENV_DIR}/bin/python" -c "import secrets; print(secrets.token_urlsafe(8))")"
  export GRADER_PASSWORD
fi

echo
echo "============================================================"
echo "OAI T7 TEAM GRADER"
echo "Mật khẩu dùng chung: ${GRADER_PASSWORD}"
echo "Log Streamlit: ${LOG_FILE}"
echo "Giữ terminal này mở trong suốt buổi luyện tập."
echo "Nhấn Ctrl+C để đóng URL ngay lập tức."
echo "============================================================"
echo

"${VENV_DIR}/bin/python" -m streamlit run "${APP_DIR}/app.py" \
  --global.developmentMode false \
  --server.headless true \
  --server.address 127.0.0.1 \
  --server.port "${PORT}" \
  --browser.gatherUsageStats false \
  >"${LOG_FILE}" 2>&1 &
STREAMLIT_PID=$!

cleanup() {
  kill "${STREAMLIT_PID}" >/dev/null 2>&1 || true
  wait "${STREAMLIT_PID}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/_stcore/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${STREAMLIT_PID}" >/dev/null 2>&1; then
    echo "Streamlit không khởi động được. Xem log: ${LOG_FILE}" >&2
    exit 1
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:${PORT}/_stcore/health" >/dev/null 2>&1; then
  echo "Streamlit chưa sẵn sàng sau 60 giây. Xem log: ${LOG_FILE}" >&2
  exit 1
fi

echo "[ready] Streamlit local đang chạy tại http://127.0.0.1:${PORT}"
echo "[tunnel] Đang tạo URL tạm; hãy gửi URL trycloudflare.com và mật khẩu ở trên cho team."
echo

npx --yes wrangler tunnel quick-start "http://127.0.0.1:${PORT}"

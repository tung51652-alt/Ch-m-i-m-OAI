#!/usr/bin/env bash
# Encrypt the organizer files into secure/ground_truth.tar.gz.enc so they can be
# committed to a public repo. GitHub Actions decrypts them with the
# GRADER_DATA_KEY secret. The key is read from $GRADER_DATA_KEY or .grader_data_key.
#
# Usage: ./scripts/pack_ground_truth.sh [DATA_ROOT]   (default: parent of the repo)
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_ROOT="$(cd "${1:-${APP_DIR}/..}" && pwd)"
OUT="${APP_DIR}/secure/ground_truth.tar.gz.enc"
KEY_FILE="${APP_DIR}/.grader_data_key"

if [[ -z "${GRADER_DATA_KEY:-}" ]]; then
  if [[ ! -s "${KEY_FILE}" ]]; then
    echo "Thiếu khóa: đặt biến GRADER_DATA_KEY hoặc tạo file ${KEY_FILE}." >&2
    exit 1
  fi
  GRADER_DATA_KEY="$(tr -d '\r\n' < "${KEY_FILE}")"
fi
export GRADER_DATA_KEY

FILES=(
  Tac_vu_1_CV/organizer/public_ground_truth.csv
  Tac_vu_1_CV/organizer/private_ground_truth.csv
  Tac_vu_2_NLP/organizer/public_ground_truth.csv
  Tac_vu_2_NLP/organizer/private_ground_truth.csv
  T5/OAI_ViLexNorm/organizer/test_ground_truth.csv
  T5/OAI_ViLexNorm/organizer/evaluate.py
  T5/OAI_ViLexNorm/competition/test/test.csv
)

present=()
for f in "${FILES[@]}"; do
  if [[ -f "${DATA_ROOT}/${f}" ]]; then
    present+=("${f}")
    echo "  + ${f}"
  else
    echo "  - THIẾU ${f} (tác vụ tương ứng sẽ báo 'Hệ thống chưa sẵn sàng')" >&2
  fi
done
if [[ ${#present[@]} -eq 0 ]]; then
  echo "Không tìm thấy file đáp án nào trong ${DATA_ROOT}." >&2
  exit 1
fi

mkdir -p "$(dirname "${OUT}")"
tar czf - -C "${DATA_ROOT}" "${present[@]}" \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:GRADER_DATA_KEY -out "${OUT}"

# Round-trip check so a wrong key is caught here rather than in CI.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:GRADER_DATA_KEY -in "${OUT}" | tar tzf - >/dev/null
echo "Đã mã hóa ${#present[@]} file vào ${OUT#"${APP_DIR}/"}"
echo "Tiếp theo: git add secure/ && git commit -m 'Update ground truth' && git push"

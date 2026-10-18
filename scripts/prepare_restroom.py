"""Fetch the two official Restroom answer arrays to the local organizer directory.

No image/model downloads. Files are pinned and hash-checked; plaintext stays outside
this repository. Use pack_ground_truth.sh to publish the encrypted grading bundle.
"""
import argparse
import hashlib
import os
from pathlib import Path
import urllib.request

REVISION = "39558e9a639d170bd92de91958fcdc915f670463"
SOURCE = f"https://raw.githubusercontent.com/IOAI-official/IOAI-2025/{REVISION}/Individual-Contest/Restroom/Solution/Scoring/"
HASHES = {
    "answer_a.npy": "fc68e7d0b656a6ba105ecf5fcfc7350a9dd0fa8bfcbf957cd256ea70fda19ece",
    "answer_b.npy": "5431c0f46c8aa85ca66b2f545cd069e7ae0d09bdee6b90da2010e8c9d2592c2e",
}


def main():
    default = os.environ.get("GRADER_DATA_ROOT") or Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=default)
    args = parser.parse_args()
    dest = args.data_root / "Restroom" / "Solution" / "Scoring"
    fetched = {}
    for name, expected in HASHES.items():
        with urllib.request.urlopen(SOURCE + name, timeout=30) as response:
            data = response.read(65537)
        if hashlib.sha256(data).hexdigest() != expected:
            raise RuntimeError(f"Checksum không khớp nguồn IOAI đã ghim: {name}")
        target = dest / name
        if target.exists() and target.read_bytes() != data:
            raise RuntimeError(f"Đã có dữ liệu khác tại {target}; không tự ghi đè.")
        fetched[name] = data
    dest.mkdir(parents=True, exist_ok=True)
    for name, data in fetched.items():
        (dest / name).write_bytes(data)
    print(f"Đã chuẩn bị 2 file đáp án Restroom từ IOAI {REVISION[:7]} tại {dest}.")


if __name__ == "__main__":
    main()

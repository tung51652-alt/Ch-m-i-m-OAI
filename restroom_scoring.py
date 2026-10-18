"""IOAI 2025 Restroom prediction transport and Precision@1 (no model execution)."""
from __future__ import annotations

from io import BytesIO
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

import numpy as np
import pandas as pd

COLUMNS = ["query_id", "gallery_id"]
SPLITS = {
    "public": {"letter": "a", "queries": 10, "gallery": 20},
    "private": {"letter": "b", "queries": 30, "gallery": 60},
}
MAX_NPY_BYTES = 64 * 1024


def split_config(split: str) -> dict:
    if split not in SPLITS:
        raise ValueError("Restroom chỉ hỗ trợ Public Test (A) hoặc Private Test (B).")
    return SPLITS[split]


def read_array(data: bytes, split: str) -> np.ndarray:
    config = split_config(split)
    if len(data) > MAX_NPY_BYTES or not data.startswith(b'\x93NUMPY'):
        raise ValueError("File NPY không hợp lệ hoặc vượt 64 KB.")
    # Inspect the header before np.load can allocate an attacker-declared shape.
    try:
        stream = BytesIO(data)
        version = np.lib.format.read_magic(stream)
        if version == (1, 0):
            shape, _, dtype = np.lib.format.read_array_header_1_0(stream)
        elif version in {(2, 0), (3, 0)}:
            shape, _, dtype = np.lib.format.read_array_header_2_0(stream)
        else:
            raise ValueError("Phiên bản NPY không được hỗ trợ.")
        if shape != (config['queries'],):
            raise ValueError(f"NPY phải có shape ({config['queries']},), nhận {shape}.")
        if dtype.kind not in 'iuf' or dtype.itemsize not in {1, 2, 4, 8} or (dtype.kind == 'f' and dtype.itemsize not in {4, 8}):
            raise ValueError("NPY cần mảng số, không dùng bool, object/pickle hay dtype phức tạp.")
        if stream.tell() + config['queries'] * dtype.itemsize != len(data):
            raise ValueError("Độ dài dữ liệu NPY không hợp lệ.")
        values = np.load(BytesIO(data), allow_pickle=False)
    except (ValueError, TypeError, EOFError, OSError) as exc:
        raise ValueError(f"Không đọc được NPY: {exc}") from exc
    if (not np.isfinite(values).all() or not np.equal(values, np.floor(values)).all()
            or (values < 1).any() or (values > config['gallery']).any()):
        raise ValueError(f"Gallery ID phải là số nguyên từ 1 đến {config['gallery']}, không phải chỉ số bắt đầu từ 0.")
    return values.astype(np.int64)


def array_frame(data: bytes, split: str) -> pd.DataFrame:
    values = read_array(data, split)
    return pd.DataFrame({"query_id": [str(i) for i in range(1, len(values) + 1)],
                         "gallery_id": [str(int(v)) for v in values]})


def load_truth(organizer_dir: Path, split: str) -> pd.DataFrame:
    config = split_config(split)
    path = organizer_dir / f"answer_{config['letter']}.npy"
    return array_frame(path.read_bytes(), split)


def read_prediction(data: bytes, name: str, split: str, csv_reader) -> tuple[pd.DataFrame, str]:
    """A ZIP may contain both official output files; grade only the selected split."""
    config = split_config(split)
    expected = f"submission_{config['letter']}.npy"
    suffix = Path(name).suffix.lower()
    if suffix == '.csv':
        return csv_reader(data, name), name
    if suffix == '.npy':
        if PurePosixPath(name).name.lower() != expected:
            raise ValueError(f"Tập đã chọn cần {expected}; hãy chọn đúng tập A/B.")
        return array_frame(data, split), name
    if suffix != '.zip':
        raise ValueError("Restroom nhận submission_a.npy/submission_b.npy, CSV hoặc ZIP.")
    with ZipFile(BytesIO(data)) as archive:
        expected_files = [i for i in archive.infolist() if not i.is_dir() and PurePosixPath(i.filename).name.lower() == expected]
        csv_files = [i for i in archive.infolist() if not i.is_dir() and PurePosixPath(i.filename).name.lower() in {'output.csv', 'submission.csv'}]
        if len(expected_files) + len(csv_files) != 1:
            raise ValueError(f"ZIP cần đúng một {expected} (có thể kèm file NPY của tập còn lại), hoặc một output.csv/submission.csv.")
        member = (expected_files + csv_files)[0]
        if member.file_size > MAX_NPY_BYTES:
            raise ValueError("File dự đoán Restroom trong ZIP vượt 64 KB.")
        content = archive.read(member)
        if expected_files:
            return array_frame(content, split), member.filename
        return csv_reader(content, member.filename), member.filename

"""Ghost of the Machine: prediction-file grading, without executing notebooks.

Metric reference: IOAI-official/IOAI-2026, task 5, grading-original/checker.py.
The UI enforces the statement's integer/range contract before applying the metric.
"""
from __future__ import annotations

import json
import math
from numbers import Integral, Real
from pathlib import Path
import re

import pandas as pd

METRIC_NAME = "Boundary Score"
SPLITS = {"public": "test_leaderboard_a", "private": "test_leaderboard_b"}
COLUMNS = ["id", "boundary_char_index"]


def parse_jsonl(text: str) -> pd.DataFrame:
    records = []
    for number, line in enumerate(text.lstrip("\ufeff").splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except (ValueError, TypeError) as exc:
            raise ValueError(f"JSONL sai cấu trúc ở dòng {number}.") from exc
        if not isinstance(record, dict) or set(record) != set(COLUMNS):
            raise ValueError(f"JSONL dòng {number} cần đúng hai trường id và boundary_char_index.")
        if not isinstance(record["id"], str) or not record["id"].strip():
            raise ValueError(f"JSONL dòng {number}: id phải là chuỗi không rỗng.")
        records.append(record)
    if not records:
        raise ValueError("JSONL đang rỗng.")
    # Keep JSON types: booleans, null and fractional numbers must not become integers.
    return pd.DataFrame(records, columns=COLUMNS, dtype=object)


def load_truth(root: Path, split: str) -> pd.DataFrame:
    if split not in SPLITS:
        raise ValueError("Ghost chỉ hỗ trợ Public (Leaderboard A) hoặc Private (Leaderboard B).")
    subset = SPLITS[split]
    answers = parse_jsonl((root / "private" / f"{subset}_answers.jsonl").read_text(encoding="utf-8-sig"))
    passages = [json.loads(line) for line in (root / "private" / subset / "data.jsonl").read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    if (answers.id.duplicated().any() or len({r['id'] for r in passages}) != len(passages)
            or set(answers.id) != {r['id'] for r in passages}):
        raise RuntimeError("Dữ liệu Ghost có ID thiếu, trùng hoặc không khớp.")
    lengths = {r['id']: len(r['text']) for r in passages}
    answers['text_length'] = answers.id.map(lengths)
    for row in answers.itertuples(index=False):
        if type(row.boundary_char_index) is not int or not 0 <= row.boundary_char_index <= row.text_length:
            raise RuntimeError("Đáp án Ghost có boundary không hợp lệ.")
    return answers


def boundary_integer(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, Integral):
        return int(value)
    if isinstance(value, Real) and math.isfinite(value) and float(value).is_integer():
        return int(value)
    if isinstance(value, str) and re.fullmatch(r"[+-]?[0-9]+", value.strip()):
        try:
            return int(value)
        except ValueError:
            pass
    return None


def score(submission: pd.DataFrame, truth: pd.DataFrame) -> dict:
    errors = []
    stats = dict(expected_samples=len(truth), submitted_samples=len(submission), valid_samples=0,
                 missing_id_values=0, duplicate_ids=0, missing_ids=0, unknown_ids=0,
                 missing_predictions=0, invalid_labels=0, invalid_boundaries=0)
    result = dict(valid=False, errors=errors, warnings=[], stats=stats, score=None,
                  metric_name=METRIC_NAME, secondary_metrics=None, classwise=None, confusion_matrix=None)
    if len(submission.columns) != 2 or set(submission.columns) != set(COLUMNS):
        errors.append("Cần đúng hai cột: id,boundary_char_index.")
        return result
    if len(submission) != len(truth):
        errors.append(f"Sai số dòng: cần {len(truth):,}, nhận {len(submission):,}.")
    truth_by_id = {r.id: r for r in truth.itertuples(index=False)}
    seen = set()
    duplicates = set()
    predictions = {}
    for row in submission.itertuples(index=False):
        sample_id = row.id
        if not isinstance(sample_id, str) or not sample_id.strip():
            stats['missing_id_values'] += 1
            continue
        if sample_id in seen:
            duplicates.add(sample_id)
        seen.add(sample_id)
        boundary = boundary_integer(row.boundary_char_index)
        if boundary is None:
            stats['invalid_boundaries'] += 1
        elif sample_id in truth_by_id:
            if not 0 <= boundary <= truth_by_id[sample_id].text_length:
                stats['invalid_boundaries'] += 1
            else:
                predictions[sample_id] = boundary
    stats.update(duplicate_ids=len(duplicates), missing_ids=len(set(truth_by_id) - seen),
                 unknown_ids=len(seen - set(truth_by_id)))
    for key, label in [('missing_id_values', 'ID thiếu hoặc sai kiểu'), ('duplicate_ids', 'ID trùng'),
                       ('missing_ids', 'ID thiếu trong test'), ('unknown_ids', 'ID không thuộc test'),
                       ('invalid_boundaries', 'Boundary phải là số nguyên trong [0, len(text)]')]:
        if stats[key]:
            errors.append(f"{label}: {stats[key]:,}.")
    if errors:
        return result
    distances = [abs(predictions[r.id] - int(r.boundary_char_index)) for r in truth.itertuples(index=False)]
    stats['valid_samples'] = len(truth)
    result.update(valid=True, score=100 * sum(math.exp(-d / 100.0) for d in distances) / len(distances),
                  secondary_metrics={"Mean Absolute Error (chars)": sum(distances) / len(distances),
                                     "Exact Match (%)": 100 * sum(d == 0 for d in distances) / len(distances)})
    return result

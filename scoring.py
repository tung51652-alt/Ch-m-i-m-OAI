"""Core scoring logic for the local OAI T7 grader.

This module has no Streamlit dependency so it can be tested independently.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import importlib.util
from io import BytesIO
import os
from pathlib import Path, PurePosixPath
import sys
from typing import Any, BinaryIO
from zipfile import BadZipFile, ZipFile

import pandas as pd
from pandas.errors import EmptyDataError, ParserError
from sklearn.metrics import classification_report, confusion_matrix, f1_score


APP_DIR = Path(__file__).resolve().parent
# Organizer data lives outside the repo; CI points this at a decrypted temp dir.
ROOT = Path(os.environ.get("GRADER_DATA_ROOT") or APP_DIR.parent).resolve()


@dataclass(frozen=True)
class TaskConfig:
    key: str
    display_name: str
    short_name: str
    id_col: str
    label_col: str
    organizer_dir: Path
    metric_kind: str = "classification"
    test_input_path: Path | None = None


TASKS: dict[str, TaskConfig] = {
    "cv": TaskConfig(
        key="cv",
        display_name="Computer Vision — DeepWeeds",
        short_name="DeepWeeds Image Classification",
        id_col="image_id",
        label_col="label",
        organizer_dir=ROOT / "Tac_vu_1_CV" / "organizer",
    ),
    "nlp": TaskConfig(
        key="nlp",
        display_name="NLP — Vietnamese Spam Review Detection",
        short_name="Vietnamese Spam Review Classification",
        id_col="id",
        label_col="label",
        organizer_dir=ROOT / "Tac_vu_2_NLP" / "organizer",
    ),
    "vilexnorm": TaskConfig(
        key="vilexnorm",
        display_name="NLP — ViLexNorm",
        short_name="Vietnamese Social Media Lexical Normalization",
        id_col="id",
        label_col="normalized",
        organizer_dir=ROOT / "T5" / "OAI_ViLexNorm" / "organizer",
        metric_kind="lexical_normalization",
        test_input_path=ROOT / "T5" / "OAI_ViLexNorm" / "competition" / "test" / "test.csv",
    ),
}

SPLIT_FILES = {
    "public": "public_ground_truth.csv",
    "private": "private_ground_truth.csv",
}
METRIC_NAME = "Macro F1"


class SubmissionReadError(ValueError):
    """A user-facing error raised while reading an uploaded submission."""


def get_task_config(task: str) -> TaskConfig:
    try:
        return TASKS[task]
    except KeyError as exc:
        raise ValueError(f"Tác vụ không hợp lệ: {task!r}.") from exc


def load_ground_truth(task: str, split: str) -> pd.DataFrame:
    """Load an organizer ground truth file without exposing it to the UI."""
    config = get_task_config(task)
    if config.metric_kind == "lexical_normalization":
        if split != "test":
            raise ValueError(f"Tác vụ ViLexNorm chỉ có Test Set; nhận {split!r}.")
        filename = "test_ground_truth.csv"
    else:
        try:
            filename = SPLIT_FILES[split]
        except KeyError as exc:
            raise ValueError(f"Tập đánh giá không hợp lệ: {split!r}.") from exc

    path = config.organizer_dir / filename
    if not path.is_file():
        raise FileNotFoundError(f"Không tìm thấy ground truth nội bộ: {path.name}.")

    ground_truth = pd.read_csv(path, encoding="utf-8-sig", dtype=str)
    required = [config.id_col, config.label_col]
    if list(ground_truth.columns) != required:
        raise RuntimeError(
            f"Ground truth {path.name} phải có đúng cột {required}; "
            f"hiện có {ground_truth.columns.tolist()}."
        )
    if ground_truth.empty:
        raise RuntimeError(f"Ground truth {path.name} đang rỗng.")
    if ground_truth[config.id_col].isna().any() or ground_truth[config.id_col].duplicated().any():
        raise RuntimeError(f"Ground truth {path.name} có ID thiếu hoặc trùng.")
    if ground_truth[config.label_col].isna().any():
        raise RuntimeError(f"Ground truth {path.name} có label thiếu.")
    return ground_truth


def _uploaded_bytes(uploaded_file: Any) -> tuple[str, bytes]:
    name = str(getattr(uploaded_file, "name", ""))
    if hasattr(uploaded_file, "getvalue"):
        data = uploaded_file.getvalue()
    elif hasattr(uploaded_file, "read"):
        data = uploaded_file.read()
    else:
        raise SubmissionReadError("Không đọc được file đã tải lên.")
    if isinstance(data, str):
        data = data.encode("utf-8")
    if not isinstance(data, (bytes, bytearray)):
        raise SubmissionReadError("Nội dung file upload không hợp lệ.")
    if not data:
        raise SubmissionReadError("File upload đang rỗng.")
    return name, bytes(data)


def _read_csv_bytes(data: bytes, source_name: str) -> pd.DataFrame:
    try:
        return pd.read_csv(BytesIO(data), encoding="utf-8-sig", dtype=str)
    except UnicodeDecodeError as exc:
        raise SubmissionReadError(
            f"Không đọc được {source_name}: CSV phải dùng encoding UTF-8."
        ) from exc
    except EmptyDataError as exc:
        raise SubmissionReadError(f"CSV {source_name} đang rỗng.") from exc
    except ParserError as exc:
        raise SubmissionReadError(f"CSV {source_name} sai cấu trúc: {exc}.") from exc
    except Exception as exc:
        raise SubmissionReadError(f"Không thể đọc CSV {source_name}: {exc}.") from exc


def read_submission(uploaded_file: BinaryIO) -> tuple[pd.DataFrame, str]:
    """Read CSV or exactly one submission.csv/output.csv inside an in-memory ZIP."""
    upload_name, data = _uploaded_bytes(uploaded_file)
    suffix = Path(upload_name).suffix.lower()

    if suffix == ".csv":
        return _read_csv_bytes(data, upload_name or "submission.csv"), upload_name

    if suffix != ".zip":
        raise SubmissionReadError("Chỉ hỗ trợ file .csv hoặc .zip.")

    try:
        with ZipFile(BytesIO(data)) as archive:
            accepted_names = {"output.csv", "submission.csv"}
            matches = [
                member
                for member in archive.infolist()
                if not member.is_dir()
                and PurePosixPath(member.filename).name.lower() in accepted_names
            ]
            if not matches:
                raise SubmissionReadError("Không tìm thấy submission.csv hoặc output.csv trong ZIP.")
            if len(matches) > 1:
                raise SubmissionReadError("ZIP chứa nhiều file submission.csv/output.csv; không thể chọn an toàn.")
            member = matches[0]
            try:
                csv_data = archive.read(member)
            except RuntimeError as exc:
                raise SubmissionReadError("Không đọc được output.csv trong ZIP; file có thể đã được mã hóa.") from exc
            return _read_csv_bytes(csv_data, member.filename), member.filename
    except SubmissionReadError:
        raise
    except BadZipFile as exc:
        raise SubmissionReadError("File ZIP bị lỗi hoặc không đúng định dạng ZIP.") from exc
    except Exception as exc:
        raise SubmissionReadError(f"Không thể đọc file ZIP: {exc}.") from exc


def _missing_mask(series: pd.Series) -> pd.Series:
    return series.isna() | series.fillna("").astype(str).str.strip().eq("")


def validate_submission(
    submission_df: pd.DataFrame,
    ground_truth_df: pd.DataFrame,
    id_col: str,
    label_col: str,
    validate_label_domain: bool = True,
    reject_extra_columns: bool = False,
) -> dict[str, Any]:
    """Validate a submission and return validity, messages, and counts."""
    errors: list[str] = []
    warnings: list[str] = []
    expected_count = len(ground_truth_df)
    submitted_count = len(submission_df)
    stats: dict[str, Any] = {
        "expected_samples": expected_count,
        "submitted_samples": submitted_count,
        "valid_samples": 0,
        "missing_id_values": 0,
        "duplicate_ids": 0,
        "missing_ids": 0,
        "unknown_ids": 0,
        "missing_predictions": 0,
        "invalid_labels": 0,
    }

    required = [id_col, label_col]
    missing_columns = [column for column in required if column not in submission_df.columns]
    for column in missing_columns:
        errors.append(f"Submission không có cột `{column}`.")

    extra_columns = [column for column in submission_df.columns if column not in required]
    if extra_columns:
        message = "Submission có cột thừa: " + ", ".join(f"`{c}`" for c in extra_columns) + "."
        if reject_extra_columns:
            errors.append(message)
        else:
            warnings.append(message + " Các cột này sẽ bị bỏ qua.")

    if submitted_count != expected_count:
        errors.append(f"Sai số dòng: cần {expected_count:,}, nhận {submitted_count:,}.")

    if missing_columns:
        return {"valid": False, "errors": errors, "warnings": warnings, "stats": stats}

    id_missing = _missing_mask(submission_df[id_col])
    label_missing = _missing_mask(submission_df[label_col])
    stats["missing_id_values"] = int(id_missing.sum())
    stats["missing_predictions"] = int(label_missing.sum())
    if stats["missing_id_values"]:
        errors.append(f"Có {stats['missing_id_values']:,} dòng thiếu `{id_col}`.")
    if stats["missing_predictions"]:
        errors.append(f"Có {stats['missing_predictions']:,} prediction bị thiếu, rỗng hoặc NaN.")

    present_ids = submission_df.loc[~id_missing, id_col].astype(str)
    duplicate_mask = present_ids.duplicated(keep=False)
    duplicate_count = int(present_ids[duplicate_mask].nunique())
    stats["duplicate_ids"] = duplicate_count
    if duplicate_count:
        errors.append(f"Phát hiện {duplicate_count:,} `{id_col}` bị trùng.")

    ground_truth_ids = set(ground_truth_df[id_col].astype(str))
    submission_ids = set(present_ids)
    missing_ids = ground_truth_ids - submission_ids
    unknown_ids = submission_ids - ground_truth_ids
    stats["missing_ids"] = len(missing_ids)
    stats["unknown_ids"] = len(unknown_ids)
    if missing_ids:
        errors.append(f"Submission thiếu {len(missing_ids):,} mẫu so với ground truth.")
    if unknown_ids:
        errors.append(f"Submission chứa {len(unknown_ids):,} `{id_col}` không thuộc test set.")

    valid_labels: set[str] = set()
    if validate_label_domain:
        valid_labels = set(ground_truth_df[label_col].astype(str))
        present_labels = submission_df.loc[~label_missing, label_col].astype(str)
        invalid_values = sorted(set(present_labels) - valid_labels)
        invalid_count = int(present_labels.isin(invalid_values).sum()) if invalid_values else 0
        stats["invalid_labels"] = invalid_count
        if invalid_values:
            shown = ", ".join(repr(value) for value in invalid_values[:8])
            suffix = " ..." if len(invalid_values) > 8 else ""
            errors.append(
                f"Có {invalid_count:,} prediction dùng label không hợp lệ: {shown}{suffix}. "
                f"Miền hợp lệ: {sorted(valid_labels)}."
            )

    valid_row_mask = ~id_missing & ~label_missing
    valid_row_mask &= submission_df[id_col].astype(str).isin(ground_truth_ids)
    if validate_label_domain:
        valid_row_mask &= submission_df[label_col].astype(str).isin(valid_labels)
    stats["valid_samples"] = int(valid_row_mask.sum())
    return {"valid": not errors, "errors": errors, "warnings": warnings, "stats": stats}


def get_classwise_metrics(y_true: pd.Series, y_pred: pd.Series, labels: list[str]) -> pd.DataFrame:
    report = classification_report(
        y_true,
        y_pred,
        labels=labels,
        target_names=labels,
        output_dict=True,
        zero_division=0,
    )
    rows = []
    for label in labels:
        values = report[label]
        rows.append(
            {
                "Class": label,
                "Precision": values["precision"],
                "Recall": values["recall"],
                "F1": values["f1-score"],
                "Support": int(values["support"]),
            }
        )
    return pd.DataFrame(rows)


def score_submission(
    submission_df: pd.DataFrame,
    ground_truth_df: pd.DataFrame,
    id_col: str,
    label_col: str,
) -> dict[str, Any]:
    """Validate, align by ID, and calculate the organizer-compatible Macro F1."""
    validation = validate_submission(submission_df, ground_truth_df, id_col, label_col)
    if not validation["valid"]:
        return {**validation, "score": None, "classwise": None, "confusion_matrix": None}

    # A one-to-one merge makes row order irrelevant and prevents accidental positional scoring.
    aligned = ground_truth_df[[id_col, label_col]].merge(
        submission_df[[id_col, label_col]],
        on=id_col,
        how="left",
        validate="one_to_one",
        suffixes=("_true", "_pred"),
        sort=False,
    )
    true_col = f"{label_col}_true"
    pred_col = f"{label_col}_pred"
    labels = sorted(ground_truth_df[label_col].astype(str).unique().tolist())
    score = f1_score(
        aligned[true_col],
        aligned[pred_col],
        average="macro",
        labels=labels,
        zero_division=0,
    )
    classwise = get_classwise_metrics(aligned[true_col], aligned[pred_col], labels)
    matrix = confusion_matrix(aligned[true_col], aligned[pred_col], labels=labels)
    matrix_df = pd.DataFrame(
        matrix,
        index=pd.Index(labels, name="Nhãn thật"),
        columns=pd.Index(labels, name="Nhãn dự đoán"),
    )
    return {
        **validation,
        "score": float(score),
        "classwise": classwise,
        "confusion_matrix": matrix_df,
        "labels": labels,
    }


def load_test_input(config: TaskConfig) -> pd.DataFrame:
    """Load the hidden task's public input text without exposing ground truth."""
    if config.test_input_path is None or not config.test_input_path.is_file():
        raise FileNotFoundError("Không tìm thấy test input nội bộ cho ViLexNorm.")
    frame = pd.read_csv(config.test_input_path, encoding="utf-8-sig", dtype=str)
    required = [config.id_col, "original"]
    if list(frame.columns) != required:
        raise RuntimeError(f"Test input ViLexNorm phải có đúng cột {required}.")
    if frame.empty or frame[config.id_col].isna().any() or frame[config.id_col].duplicated().any():
        raise RuntimeError("Test input ViLexNorm rỗng hoặc có ID thiếu/trùng.")
    if _missing_mask(frame["original"]).any():
        raise RuntimeError("Test input ViLexNorm có original thiếu/rỗng.")
    return frame


@lru_cache(maxsize=1)
def load_vilexnorm_evaluator():
    """Load the package evaluator so CLI, notebook, and web use one implementation."""
    path = TASKS["vilexnorm"].organizer_dir / "evaluate.py"
    if not path.is_file():
        raise FileNotFoundError(f"Không tìm thấy evaluator ViLexNorm: {path.name}.")
    spec = importlib.util.spec_from_file_location("oai_vilexnorm_evaluator", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Không thể khởi tạo evaluator ViLexNorm.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def score_vilexnorm_submission(
    submission_df: pd.DataFrame,
    ground_truth_df: pd.DataFrame,
    test_input_df: pd.DataFrame,
) -> dict[str, Any]:
    """Validate, align by ID, and calculate canonical ViLexNorm ERR."""
    validation = validate_submission(
        submission_df,
        ground_truth_df,
        id_col="id",
        label_col="normalized",
        validate_label_domain=False,
        reject_extra_columns=True,
    )
    if not validation["valid"]:
        return {
            **validation,
            "score": None,
            "metric_name": "Error Reduction Rate (ERR)",
            "secondary_metrics": None,
            "classwise": None,
            "confusion_matrix": None,
        }

    aligned = (
        test_input_df[["id", "original"]]
        .merge(ground_truth_df[["id", "normalized"]], on="id", validate="one_to_one", sort=False)
        .merge(
            submission_df[["id", "normalized"]],
            on="id",
            validate="one_to_one",
            suffixes=("_true", "_pred"),
            sort=False,
        )
    )
    evaluator = load_vilexnorm_evaluator()
    metrics = evaluator.evaluate_records(
        aligned["original"].tolist(),
        aligned["normalized_true"].tolist(),
        aligned["normalized_pred"].tolist(),
    )
    return {
        **validation,
        "score": float(metrics["err"]),
        "metric_name": "Error Reduction Rate (ERR)",
        "secondary_metrics": {
            "Token Accuracy": float(metrics["token_accuracy"]),
            "Normalization Precision": float(metrics["precision"]),
            "Normalization Recall": float(metrics["recall"]),
        },
        "classwise": None,
        "confusion_matrix": None,
    }


def grade_submission(task: str, split: str, submission_df: pd.DataFrame) -> dict[str, Any]:
    config = get_task_config(task)
    ground_truth = load_ground_truth(task, split)
    if config.metric_kind == "lexical_normalization":
        return score_vilexnorm_submission(submission_df, ground_truth, load_test_input(config))
    return score_submission(submission_df, ground_truth, config.id_col, config.label_col)

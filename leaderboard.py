"""Submission history and leaderboard ranking for the OAI T7 grader.

Every graded submission is stored as one JSON file under ``results/submissions``.
One file per submission keeps concurrent CI runs from conflicting on git push,
and the leaderboard is always recomputed from the full history.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import secrets
from typing import Any, Iterable

from scoring import TASKS, get_task_config


APP_DIR = Path(__file__).resolve().parent
RESULTS_DIR = Path(os.environ.get("GRADER_RESULTS_DIR") or APP_DIR / "results").resolve()
SUBMISSIONS_DIR_NAME = "submissions"
# Daily submission limits reset at midnight Vietnam time.
LOCAL_TZ = timezone(timedelta(hours=7))

SPLIT_DISPLAY = {"public": "Public Test", "private": "Private Test", "test": "Test Set"}


def task_splits(task: str) -> list[str]:
    config = get_task_config(task)
    return ["test"] if config.metric_kind == "lexical_normalization" else ["public", "private"]


def ranking_split(task: str) -> str:
    """The split whose best score decides the rank."""
    return "test" if "test" in task_splits(task) else "private"


def submissions_dir(results_dir: Path | None = None) -> Path:
    return (results_dir or RESULTS_DIR) / SUBMISSIONS_DIR_NAME


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _safe_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-") or "submission"


def new_submission_id(source: str, submitted_at: datetime) -> str:
    return _safe_id(f"{source}-{submitted_at:%Y%m%dT%H%M%SZ}-{secrets.token_hex(3)}")


def build_record(
    *,
    submission_id: str,
    source: str,
    team: str,
    task: str,
    split: str,
    submitted_at: datetime,
    file_name: str,
    file_sha256: str,
    result: dict[str, Any] | None,
    error: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Turn a grading result into a JSON-serialisable history record.

    Only aggregate numbers are stored; per-class tables and confusion matrices
    are left out so the public history cannot leak label distributions.
    """
    valid = bool(result and result.get("valid") and result.get("score") is not None)
    errors = list(result.get("errors", [])) if result else []
    if error:
        errors.append(error)
    record: dict[str, Any] = {
        "id": submission_id,
        "source": source,
        "team": team,
        "task": task,
        "split": split,
        "submitted_at": submitted_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "file_name": file_name,
        "file_sha256": file_sha256,
        "valid": valid,
        "score": float(result["score"]) if valid else None,
        "metric_name": (result or {}).get("metric_name") or ("Macro F1" if task != "vilexnorm" else "Error Reduction Rate (ERR)"),
        "secondary_metrics": (result or {}).get("secondary_metrics") if valid else None,
        "stats": (result or {}).get("stats"),
        "errors": errors,
        "warnings": list((result or {}).get("warnings", [])),
    }
    if extra:
        record.update(extra)
    return record


def save_record(record: dict[str, Any], results_dir: Path | None = None) -> Path:
    directory = submissions_dir(results_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{_safe_id(record['id'])}.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return path


def load_records(results_dir: Path | None = None) -> list[dict[str, Any]]:
    directory = submissions_dir(results_dir)
    if not directory.is_dir():
        return []
    records = []
    for path in sorted(directory.glob("*.json")):
        try:
            records.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    records.sort(key=lambda r: (r.get("submitted_at", ""), r.get("id", "")))
    return records


def count_today(
    records: Iterable[dict[str, Any]],
    team: str,
    task: str,
    split: str,
    now: datetime | None = None,
) -> int:
    """Valid submissions a team made today (Vietnam time) for one task/split."""
    today = (now or utc_now()).astimezone(LOCAL_TZ).date()
    return sum(
        1
        for r in records
        if r.get("valid")
        and r.get("team") == team
        and r.get("task") == task
        and r.get("split") == split
        and _parse_time(r["submitted_at"]).astimezone(LOCAL_TZ).date() == today
    )


def build_leaderboard(records: Iterable[dict[str, Any]], task: str) -> list[dict[str, Any]]:
    """Rank teams by their best ranking-split score, then best public score.

    Higher is better for both Macro F1 and ERR. Teams with equal scores share a
    rank (1, 2, 2, 4); within a tie the team that reached the score first is
    listed first. Teams without a ranking-split score are listed last, unranked.
    """
    splits = task_splits(task)
    rank_split = ranking_split(task)
    teams: dict[str, dict[str, Any]] = {}
    for r in records:
        if r.get("task") != task:
            continue
        entry = teams.setdefault(
            r["team"],
            {
                "team": r["team"],
                "best": {s: None for s in splits},
                "best_at": {s: None for s in splits},
                "submissions": 0,
                "valid_submissions": 0,
                "last_submitted_at": None,
            },
        )
        entry["submissions"] += 1
        entry["last_submitted_at"] = max(filter(None, [entry["last_submitted_at"], r["submitted_at"]]))
        if not r.get("valid") or r.get("split") not in entry["best"]:
            continue
        entry["valid_submissions"] += 1
        split, score = r["split"], float(r["score"])
        best = entry["best"][split]
        # Records are processed in time order, so strict ">" keeps the earliest time for a tie.
        if best is None or score > best:
            entry["best"][split] = score
            entry["best_at"][split] = r["submitted_at"]

    def sort_key(entry: dict[str, Any]) -> tuple:
        rank_score = entry["best"][rank_split]
        public = entry["best"].get("public")
        # ERR can be negative, so "missing" is ordered by a flag rather than a sentinel score.
        return (
            rank_score is None,
            -(rank_score or 0.0),
            public is None,
            -(public or 0.0),
            entry["best_at"][rank_split] or entry["best_at"].get("public") or "~",
            entry["team"].lower(),
        )

    rows = sorted(teams.values(), key=sort_key)
    previous_key = None
    previous_rank = None
    for position, row in enumerate(rows, start=1):
        rank_score = row["best"][rank_split]
        if rank_score is None:
            row["rank"] = None
            continue
        key = (rank_score, row["best"].get("public"))
        row["rank"] = previous_rank if key == previous_key else position
        previous_key, previous_rank = key, row["rank"]
    return rows


def export_site_data(records: list[dict[str, Any]], repository: str | None = None) -> dict[str, Any]:
    """Data consumed by the static github.io leaderboard page."""
    tasks = []
    for key, config in TASKS.items():
        tasks.append(
            {
                "key": key,
                "name": config.display_name,
                "metric": "Error Reduction Rate (ERR)" if config.metric_kind == "lexical_normalization" else "Macro F1",
                "splits": task_splits(key),
                "ranking_split": ranking_split(key),
                "leaderboard": build_leaderboard(records, key),
            }
        )
    history = [
        {
            field: r.get(field)
            for field in [
                "id", "team", "task", "split", "submitted_at", "valid", "score",
                "metric_name", "secondary_metrics", "errors", "issue_url", "source",
            ]
        }
        for r in reversed(records)
    ]
    return {
        "generated_at": utc_now().isoformat().replace("+00:00", "Z"),
        "repository": repository,
        "split_names": SPLIT_DISPLAY,
        "tasks": tasks,
        "history": history,
    }

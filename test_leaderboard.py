"""Tests for submission history, ranking and the GitHub Issue grader (synthetic data only)."""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))

import scoring  # noqa: E402
from leaderboard import (  # noqa: E402
    build_leaderboard,
    build_record,
    count_today,
    export_site_data,
    load_records,
    save_record,
)
import grade_issue  # noqa: E402


def record(team, task, split, score, at, valid=True):
    return {
        "id": f"{team}-{split}-{at}",
        "team": team,
        "task": task,
        "split": split,
        "score": score if valid else None,
        "valid": valid,
        "submitted_at": at,
    }


class LeaderboardRankingTests(unittest.TestCase):
    def test_ranks_by_best_private_then_public(self) -> None:
        records = [
            record("A", "cv", "public", 0.90, "2026-10-01T01:00:00Z"),
            record("A", "cv", "private", 0.80, "2026-10-01T01:05:00Z"),
            record("A", "cv", "private", 0.70, "2026-10-01T02:00:00Z"),  # worse, best stays 0.80
            record("B", "cv", "public", 0.95, "2026-10-01T01:00:00Z"),
            record("B", "cv", "private", 0.85, "2026-10-01T01:10:00Z"),
            record("C", "cv", "public", 0.99, "2026-10-01T01:00:00Z"),  # no private -> unranked
            record("D", "cv", "private", 0.10, "2026-10-01T01:00:00Z", valid=False),
        ]
        rows = build_leaderboard(records, "cv")
        self.assertEqual([r["team"] for r in rows], ["B", "A", "C", "D"])
        self.assertEqual([r["rank"] for r in rows], [1, 2, None, None])
        self.assertAlmostEqual(rows[1]["best"]["private"], 0.80)
        self.assertEqual(rows[1]["submissions"], 3)
        self.assertEqual(rows[3]["valid_submissions"], 0)

    def test_equal_scores_share_rank_and_earlier_listed_first(self) -> None:
        records = [
            record("Late", "nlp", "private", 0.8, "2026-10-01T05:00:00Z"),
            record("Early", "nlp", "private", 0.8, "2026-10-01T04:00:00Z"),
            record("Low", "nlp", "private", 0.5, "2026-10-01T03:00:00Z"),
        ]
        rows = build_leaderboard(records, "nlp")
        self.assertEqual([(r["team"], r["rank"]) for r in rows], [("Early", 1), ("Late", 1), ("Low", 3)])

    def test_public_breaks_private_tie(self) -> None:
        records = [
            record("X", "cv", "private", 0.8, "2026-10-01T01:00:00Z"),
            record("X", "cv", "public", 0.6, "2026-10-01T01:00:00Z"),
            record("Y", "cv", "private", 0.8, "2026-10-01T02:00:00Z"),
            record("Y", "cv", "public", 0.7, "2026-10-01T02:00:00Z"),
        ]
        self.assertEqual([(r["team"], r["rank"]) for r in build_leaderboard(records, "cv")], [("Y", 1), ("X", 2)])

    def test_vilexnorm_ranks_by_test_and_handles_negative_err(self) -> None:
        records = [
            record("Neg", "vilexnorm", "test", -0.2, "2026-10-01T01:00:00Z"),
            record("Pos", "vilexnorm", "test", 0.3, "2026-10-01T02:00:00Z"),
        ]
        rows = build_leaderboard(records, "vilexnorm")
        self.assertEqual([(r["team"], r["rank"]) for r in rows], [("Pos", 1), ("Neg", 2)])
        self.assertEqual(set(rows[0]["best"]), {"test"})

    def test_daily_count_uses_vietnam_midnight(self) -> None:
        records = [
            record("A", "cv", "public", 0.5, "2026-10-01T16:59:00Z"),  # 23:59 on Oct 1 VN
            record("A", "cv", "public", 0.5, "2026-10-01T17:01:00Z"),  # 00:01 on Oct 2 VN
            record("A", "cv", "public", 0.5, "2026-10-01T18:00:00Z", valid=False),
        ]
        now = datetime(2026, 10, 2, 3, 0, tzinfo=timezone.utc)
        self.assertEqual(count_today(records, "A", "cv", "public", now), 1)

    def test_records_round_trip_and_site_export(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = {"valid": True, "score": 0.5, "errors": [], "warnings": [], "stats": {"valid_samples": 3},
                      "classwise": pd.DataFrame(), "confusion_matrix": pd.DataFrame()}
            saved = build_record(
                submission_id="local-1", source="local", team="Đội A", task="cv", split="public",
                submitted_at=datetime(2026, 10, 1, tzinfo=timezone.utc), file_name="s.csv",
                file_sha256="ab", result=result,
            )
            save_record(saved, Path(tmp))
            loaded = load_records(Path(tmp))
            self.assertEqual(loaded, [saved])
            self.assertNotIn("classwise", loaded[0])
            data = export_site_data(loaded, "owner/repo")
            json.dumps(data)
            cv = next(t for t in data["tasks"] if t["key"] == "cv")
            self.assertEqual(cv["leaderboard"][0]["team"], "Đội A")


ISSUE_BODY = """### Tác vụ

{task}

### Tập đánh giá

{split}

### File submission

{file}

### Ghi chú

_No response_
"""
ATTACHMENT = "[submission.csv](https://github.com/user-attachments/files/123/submission.csv)"


class GradeIssueTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        organizer = root / "data" / "cv"
        organizer.mkdir(parents=True)
        self.truth = pd.DataFrame({"image_id": [f"img{i}" for i in range(6)], "label": list("abcabc")})
        self.truth.to_csv(organizer / "public_ground_truth.csv", index=False)
        self.truth.to_csv(organizer / "private_ground_truth.csv", index=False)
        self.results = root / "results"
        self.teams = root / "teams.json"
        patcher = mock.patch.dict(scoring.TASKS, {"cv": replace(scoring.TASKS["cv"], organizer_dir=organizer)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def run_issue(self, body, data=None, login="alice", number=7, daily_limit=0):
        event = {"issue": {"number": number, "user": {"login": login}, "body": body,
                           "html_url": f"https://github.com/o/r/issues/{number}"}}
        csv_bytes = data if data is not None else self.truth.to_csv(index=False).encode()
        return grade_issue.grade_issue(
            event, repository="o/r", token=None, site_url="https://o.github.io/r/",
            daily_limit=daily_limit, teams_path=self.teams, results_dir=self.results,
            fetch=lambda url, token: csv_bytes,
        )

    def body(self, task="Tác vụ 1 — Computer Vision: DeepWeeds", split="Public Test", file=ATTACHMENT):
        return ISSUE_BODY.format(task=task, split=split, file=file)

    def test_valid_submission_is_scored_saved_and_ranked(self) -> None:
        status, comment = self.run_issue(self.body())
        self.assertEqual(status, "graded")
        self.assertIn("1.000000", comment)
        self.assertIn("chưa xếp hạng", comment)  # no private score yet
        status, comment = self.run_issue(self.body(split="Private Test"), number=8)
        self.assertIn("#1 / 1", comment)
        records = load_records(self.results)
        self.assertEqual([r["id"] for r in records], ["gh-7", "gh-8"])
        self.assertEqual(records[0]["github_login"], "alice")

    def test_invalid_submission_is_recorded_with_errors(self) -> None:
        bad = self.truth.iloc[:-1].to_csv(index=False).encode()
        status, comment = self.run_issue(self.body(), data=bad)
        self.assertEqual(status, "invalid")
        self.assertIn("Sai số dòng", comment)
        [saved] = load_records(self.results)
        self.assertFalse(saved["valid"])

    def test_missing_attachment_and_wrong_split(self) -> None:
        status, comment = self.run_issue(self.body(file="quên đính kèm"))
        self.assertEqual(status, "invalid")
        self.assertIn("Không tìm thấy file", comment)
        status, comment = self.run_issue(self.body(split="Test Set (ViLexNorm)"))
        self.assertEqual(status, "invalid")
        self.assertIn("chỉ chấm trên", comment)

    def test_attachment_must_be_github_upload(self) -> None:
        with self.assertRaises(grade_issue.SubmissionProblem):
            grade_issue.find_attachment("[x.csv](https://evil.example.com/x.csv)", "o/r")
        url, name = grade_issue.find_attachment("[a b.zip](https://github.com/o/r/files/9/a%20b.zip)", "o/r")
        self.assertEqual(name, "a b.zip")

    def test_daily_limit_rejects_without_grading(self) -> None:
        self.assertEqual(self.run_issue(self.body(), daily_limit=1)[0], "graded")
        status, comment = self.run_issue(self.body(), number=9, daily_limit=1)
        self.assertEqual(status, "rejected")
        self.assertIn("Hết lượt", comment)
        self.assertEqual(len(load_records(self.results)), 1)

    def test_teams_json_maps_members_and_blocks_strangers(self) -> None:
        self.teams.write_text(json.dumps({"Đội Rồng": ["Alice", "bob"]}), encoding="utf-8")
        self.assertEqual(self.run_issue(self.body(), login="alice")[0], "graded")
        self.assertEqual(self.run_issue(self.body(), login="mallory", number=10)[0], "rejected")
        self.assertEqual(load_records(self.results)[0]["team"], "Đội Rồng")

    def test_missing_ground_truth_is_system_error_not_recorded(self) -> None:
        missing = replace(scoring.TASKS["nlp"], organizer_dir=Path(self.tmp.name) / "missing")
        with mock.patch.dict(scoring.TASKS, {"nlp": missing}):
            status, comment = self.run_issue(self.body(task="Tác vụ 2 — NLP: Vietnamese Spam Review Detection"))
        self.assertEqual(status, "error")
        self.assertEqual(load_records(self.results), [])


if __name__ == "__main__":
    unittest.main()

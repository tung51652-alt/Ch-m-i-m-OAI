"""Tests for submission history, ranking and the GitHub Issue grader (synthetic data only)."""
from __future__ import annotations

import base64
from dataclasses import replace
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import sys
import tempfile
import unicodedata
import unittest
from unittest import mock

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))

import scoring  # noqa: E402
from leaderboard import (  # noqa: E402
    ACTIVE_TASKS,
    build_leaderboard,
    build_record,
    count_today,
    export_site_data,
    load_records,
    normalize_team,
    save_record,
    task_requirements,
    team_names,
)
import grade_issue  # noqa: E402
import sitelock  # noqa: E402


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


ISSUE_BODY = """### Đội

{team}

### Tác vụ

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

    def body(self, task="Tác vụ 1 — Computer Vision: DeepWeeds", split="Public Test", file=ATTACHMENT, team=""):
        body = ISSUE_BODY.format(team=team, task=task, split=split, file=file)
        # Without a team the "Đội" section is dropped, like an issue from the older form.
        return body if team else body.replace("### Đội\n\n\n\n", "", 1)

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

    def test_team_chosen_in_form_is_validated_against_teams_json(self) -> None:
        self.teams.write_text(json.dumps({"Kiên": [], "Thanh": ["thanh-gh"]}), encoding="utf-8")
        self.assertEqual(self.run_issue(self.body(team="Kiên"), login="anyone")[0], "graded")
        self.assertEqual(load_records(self.results)[0]["team"], "Kiên")
        status, comment = self.run_issue(self.body(team="Đội lạ"), number=11)
        self.assertEqual(status, "invalid")
        self.assertIn("không có trong danh sách", comment)
        self.assertEqual(self.run_issue(self.body(team="Thanh"), login="someone-else", number=12)[0], "rejected")
        self.assertEqual(self.run_issue(self.body(team="Thanh"), login="Thanh-GH", number=13)[0], "graded")

    def test_gist_raw_link_is_accepted(self) -> None:
        gist = "https://gist.githubusercontent.com/u/abc123/raw/def456/output.csv"
        self.assertEqual(grade_issue.find_attachment(f"link: {gist}", "o/r"), (gist, "output.csv"))
        with self.assertRaises(grade_issue.SubmissionProblem):
            grade_issue.find_attachment("https://gist.github.com/u/abc123", "o/r")
        self.assertEqual(self.run_issue(self.body(file=gist))[0], "graded")

    def test_issue_form_team_options_match_teams_json(self) -> None:
        template = (Path(__file__).resolve().parent / ".github/ISSUE_TEMPLATE/submission.yml").read_text(encoding="utf-8")
        block = template.split("id: team", 1)[1].split("validations:", 1)[0]
        options = [line.strip().strip("- ").strip('"') for line in block.splitlines() if line.strip().startswith("- ")]
        self.assertEqual(options, team_names())

    def pred_code(self, pred, task="cv", split="public", labels=None):
        payload = {"v": 1, "task": task, "split": split, "file_name": "output.csv",
                   "labels": labels or ["a", "b", "c"], "pred": pred}
        return "oai-pred:v1:" + base64.b64encode(gzip.compress(json.dumps(payload).encode())).decode()

    def test_inline_prediction_code_is_regraded(self) -> None:
        # truth labels are a,b,c,a,b,c -> indices 0,1,2,0,1,2
        perfect = self.pred_code("012012")
        body = self.body(file="").replace("### File submission", f"### Dự đoán\n\n```\n{perfect}\n```\n\n### File submission")
        status, comment = self.run_issue(body, data=b"never downloaded")
        self.assertEqual(status, "graded")
        self.assertIn("1.000000", comment)
        half = self.pred_code("000000")
        status, _ = self.run_issue(body.replace(perfect, half), number=21)
        self.assertEqual(status, "graded")
        by_id = {r["id"]: r for r in load_records(self.results)}
        self.assertEqual(by_id["gh-7"]["score"], 1.0)
        self.assertEqual(by_id["gh-7"]["file_name"], "output.csv")
        self.assertLess(by_id["gh-21"]["score"], 1.0)

    def test_tampered_prediction_code_is_rejected(self) -> None:
        for code, needle in [(self.pred_code("012"), "cần 6"), (self.pred_code("012012", split="private"), "không khớp"),
                             (self.pred_code("0120z2"), "nhãn không hợp lệ"), ("oai-pred:v1:AAAA", "bị lỗi")]:
            body = self.body(file="").replace("### File submission", f"### Dự đoán\n\n{code}\n\n### File submission")
            status, comment = self.run_issue(body)
            self.assertEqual(status, "invalid", code)
            self.assertIn(needle, comment)

    def test_missing_ground_truth_is_system_error_not_recorded(self) -> None:
        missing = replace(scoring.TASKS["nlp"], organizer_dir=Path(self.tmp.name) / "missing")
        with mock.patch.dict(scoring.TASKS, {"nlp": missing}):
            status, comment = self.run_issue(self.body(task="Tác vụ 2 — NLP: Vietnamese Spam Review Detection"))
        self.assertEqual(status, "error")
        self.assertEqual(load_records(self.results), [])


class SiteLockTests(unittest.TestCase):
    def test_encrypt_round_trip_and_wrong_password(self) -> None:
        payload = {"tasks": [{"team": "Đội Rồng", "score": 0.5}]}
        envelope = sitelock.encrypt_json(payload, "mật-khẩu")
        self.assertTrue(envelope["encrypted"])
        self.assertNotIn("Rồng", json.dumps(envelope, ensure_ascii=False))
        self.assertEqual(sitelock.decrypt_json(envelope, "mật-khẩu"), payload)
        with self.assertRaises(Exception):
            sitelock.decrypt_json(envelope, "sai")

    def test_password_created_once_and_env_wins(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(sitelock, "PASSWORD_FILE", Path(tmp) / "pw"), \
                mock.patch.dict("os.environ", {"GRADER_PASSWORD": ""}):
            self.assertIsNone(sitelock.load_password())
            created = sitelock.load_password(create=True)
            self.assertRegex(created, r"^oai-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$")
            self.assertEqual(sitelock.load_password(create=True), created)
            with mock.patch.dict("os.environ", {"GRADER_PASSWORD": "from-env"}):
                self.assertEqual(sitelock.load_password(), "from-env")
        self.assertTrue(sitelock.check_password("abc", "abc"))
        self.assertFalse(sitelock.check_password(None, "abc"))


class RequirementsTests(unittest.TestCase):
    def test_requirements_from_ground_truth_without_true_labels(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            organizer = Path(tmp)
            truth = pd.DataFrame({"image_id": ["a.jpg", "b.jpg", "c.jpg"], "label": ["Lantana", "Lantana", "Negative"]})
            truth.to_csv(organizer / "public_ground_truth.csv", index=False)
            truth.head(2).to_csv(organizer / "private_ground_truth.csv", index=False)
            with mock.patch.dict(scoring.TASKS, {"cv": replace(scoring.TASKS["cv"], organizer_dir=organizer)}):
                req = task_requirements("cv")
        self.assertEqual(req["columns"], ["image_id", "label"])
        self.assertEqual(req["rows"], {"public": 3, "private": 2})
        self.assertEqual(req["labels"], ["Lantana", "Negative"])
        self.assertEqual([r[1] for r in req["example"]], ["Lantana", "Negative", "Lantana"])  # cycled, not truth

    def test_missing_data_gives_partial_requirements(self) -> None:
        missing = replace(scoring.TASKS["nlp"], organizer_dir=Path("/nonexistent"))
        with mock.patch.dict(scoring.TASKS, {"nlp": missing}):
            req = task_requirements("nlp")
        self.assertEqual(req["columns"], ["id", "label"])
        self.assertIsNone(req["rows"])
        self.assertIsNone(req["labels"])

    def test_team_list_from_teams_json(self) -> None:
        self.assertEqual(team_names(), ["Kiên", "Tùng", "Thanh"])
        decomposed = unicodedata.normalize("NFD", " Kiên  ")
        self.assertEqual(normalize_team(decomposed), "Kiên")
        self.assertEqual(team_names(Path("/nonexistent.json")), [])

    def test_only_oai_t7_tasks_are_active(self) -> None:
        self.assertEqual(ACTIVE_TASKS, ["cv", "nlp"])


if __name__ == "__main__":
    unittest.main()

"""Grade one GitHub Issue submission inside GitHub Actions.

Reads the ``issues`` event payload, downloads the attached CSV/ZIP, grades it
with ``scoring.grade_submission``, stores the result under ``results/`` and
writes the bot comment. The workflow commits the record and posts the comment.

Outputs (``$GITHUB_OUTPUT``): ``status`` = graded | invalid | rejected | error.
"""
from __future__ import annotations

import argparse
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import re
import sys
from typing import Any
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from leaderboard import (  # noqa: E402
    SPLIT_DISPLAY,
    build_leaderboard,
    build_record,
    count_today,
    load_records,
    ranking_split,
    save_record,
    task_splits,
    utc_now,
)
from scoring import SubmissionReadError, get_task_config, grade_submission, read_submission  # noqa: E402


MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
TASK_OPTIONS = {
    "Tác vụ 1 — Computer Vision: DeepWeeds": "cv",
    "Tác vụ 2 — NLP: Vietnamese Spam Review Detection": "nlp",
    "Tác vụ 3 — NLP: ViLexNorm": "vilexnorm",
}
SPLIT_OPTIONS = {
    "Public Test": "public",
    "Private Test": "private",
    "Test Set (ViLexNorm)": "test",
}
ATTACHMENT_RE = re.compile(r"https://github\.com/[^\s)\]>\"']+")


class SubmissionProblem(Exception):
    """A problem with the submission itself, reported back to the participant."""


class NamedBytesIO(BytesIO):
    def __init__(self, data: bytes, name: str):
        super().__init__(data)
        self.name = name


def parse_issue_form(body: str) -> dict[str, str]:
    """Split a rendered issue form into {heading: value}."""
    sections: dict[str, str] = {}
    current = None
    lines: list[str] = []
    for line in (body or "").splitlines():
        if line.startswith("### "):
            if current is not None:
                sections[current] = "\n".join(lines).strip()
            current, lines = line[4:].strip(), []
        elif current is not None:
            lines.append(line)
    if current is not None:
        sections[current] = "\n".join(lines).strip()
    return {k: ("" if v == "_No response_" else v) for k, v in sections.items()}


def resolve_task_split(fields: dict[str, str]) -> tuple[str, str]:
    task = TASK_OPTIONS.get(fields.get("Tác vụ", "").strip())
    if task is None:
        raise SubmissionProblem("Không nhận diện được **Tác vụ**. Hãy dùng form *Nộp bài chấm điểm*.")
    split = SPLIT_OPTIONS.get(fields.get("Tập đánh giá", "").strip())
    if split is None:
        raise SubmissionProblem("Không nhận diện được **Tập đánh giá**.")
    allowed = task_splits(task)
    if split not in allowed:
        names = ", ".join(SPLIT_DISPLAY[s] for s in allowed)
        raise SubmissionProblem(f"Tác vụ này chỉ chấm trên: {names}. Bạn đã chọn {SPLIT_DISPLAY[split]}.")
    return task, split


def find_attachment(text: str, repository: str) -> tuple[str, str]:
    """Return (url, file name) of the single .csv/.zip attached via GitHub's uploader."""
    candidates = []
    for url in ATTACHMENT_RE.findall(text or ""):
        path = urllib.parse.urlparse(url).path
        is_upload = path.startswith("/user-attachments/files/") or path.lower().startswith(
            f"/{repository.lower()}/files/"
        )
        name = urllib.parse.unquote(path.rsplit("/", 1)[-1])
        if is_upload and name.lower().endswith((".csv", ".zip")) and url not in [c[0] for c in candidates]:
            candidates.append((url, name))
    if not candidates:
        raise SubmissionProblem(
            "Không tìm thấy file .csv/.zip đính kèm. Hãy **kéo thả file** vào ô *File submission* "
            "và chờ GitHub upload xong trước khi bấm Submit."
        )
    if len(candidates) > 1:
        raise SubmissionProblem("Issue có nhiều hơn một file đính kèm; mỗi issue chỉ được nộp một file.")
    return candidates[0]


def download(url: str, token: str | None) -> bytes:
    """Download an issue attachment, retrying with the Actions token if anonymous access fails."""
    last_error: Exception | None = None
    for use_token in ([False, True] if token else [False]):
        request = urllib.request.Request(url, headers={"User-Agent": "oai-t7-grader"})
        if use_token:
            # Unredirected so the token never reaches the signed storage URL GitHub redirects to.
            request.add_unredirected_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read(MAX_DOWNLOAD_BYTES + 1)
        except (urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            continue
        if len(data) > MAX_DOWNLOAD_BYTES:
            raise SubmissionProblem("File vượt quá giới hạn 25 MB.")
        return data
    raise SubmissionProblem(f"Không tải được file đính kèm: {last_error}.")


def load_teams(path: Path) -> dict[str, str]:
    """Map lowercase GitHub login -> team name from teams.json; empty means open registration."""
    if not path.is_file():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {
        str(login).lower(): str(team)
        for team, logins in raw.items()
        if not str(team).startswith("_")
        for login in logins
    }


def fmt(value: float | None) -> str:
    return "—" if value is None else f"{value:.6f}"


def leaderboard_snippet(records: list[dict[str, Any]], task: str, team: str) -> str:
    rows = build_leaderboard(records, task)
    row = next((r for r in rows if r["team"] == team), None)
    if row is None:
        return ""
    rank_split = ranking_split(task)
    ranked = sum(1 for r in rows if r["rank"] is not None)
    rank_text = f"#{row['rank']} / {ranked}" if row["rank"] else f"chưa xếp hạng (cần điểm {SPLIT_DISPLAY[rank_split]})"
    bests = " · ".join(f"{SPLIT_DISPLAY[s]}: **{fmt(row['best'][s])}**" for s in task_splits(task))
    return f"**Thứ hạng hiện tại của {team}:** {rank_text}  \nĐiểm tốt nhất — {bests}"


def comment_for_result(record: dict[str, Any], snippet: str, site_url: str | None, limit_info: str) -> str:
    config = get_task_config(record["task"])
    lines = []
    if record["valid"]:
        lines += [
            "## ✅ Submission hợp lệ",
            "",
            "| | |",
            "|---|---|",
            f"| Đội | **{record['team']}** |",
            f"| Tác vụ | {config.display_name} |",
            f"| Tập đánh giá | {SPLIT_DISPLAY[record['split']]} |",
            f"| **{record['metric_name']}** | **{record['score']:.6f}** |",
        ]
        for name, value in (record.get("secondary_metrics") or {}).items():
            lines.append(f"| {name} | {value:.6f} |")
        lines.append(f"| Số mẫu hợp lệ | {record['stats']['valid_samples']:,} |")
    else:
        lines += [
            "## ❌ Submission không hợp lệ",
            "",
            f"Đội **{record['team']}** · {config.display_name} · {SPLIT_DISPLAY[record['split']]}",
            "",
            "**Lỗi:**",
            *[f"- {e}" for e in record["errors"]],
            "",
            "Lần nộp không hợp lệ được lưu vào lịch sử nhưng không tính vào giới hạn nộp/ngày.",
        ]
    if record.get("warnings"):
        lines += ["", "**Cảnh báo:**", *[f"- {w}" for w in record["warnings"]]]
    if snippet:
        lines += ["", snippet]
    if limit_info:
        lines += ["", limit_info]
    if site_url:
        lines += ["", f"📊 Bảng xếp hạng: {site_url} (cập nhật sau ~1 phút)"]
    lines += ["", f"<sub>Submission ID `{record['id']}` · SHA-256 `{record['file_sha256'][:12]}`</sub>"]
    return "\n".join(lines)


def write_output(name: str, value: str) -> None:
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def grade_issue(event: dict[str, Any], *, repository: str, token: str | None, site_url: str | None,
                daily_limit: int, teams_path: Path, results_dir: Path | None = None,
                fetch=download) -> tuple[str, str]:
    """Return (status, comment markdown)."""
    issue = event["issue"]
    login = issue["user"]["login"]
    submitted_at = utc_now()

    teams = load_teams(teams_path)
    if teams and login.lower() not in teams:
        return "rejected", (
            f"## ⛔ Chưa đăng ký đội\n\nTài khoản `@{login}` chưa có trong danh sách đội (`teams.json`). "
            "Hãy liên hệ ban tổ chức để được thêm vào."
        )
    team = teams.get(login.lower(), login)

    try:
        fields = parse_issue_form(issue.get("body") or "")
        task, split = resolve_task_split(fields)
    except SubmissionProblem as exc:
        return "invalid", f"## ❌ Không đọc được form nộp bài\n\n{exc}"

    records = load_records(results_dir)
    used = count_today(records, team, task, split, submitted_at)
    if daily_limit > 0 and used >= daily_limit:
        return "rejected", (
            f"## ⛔ Hết lượt nộp hôm nay\n\nĐội **{team}** đã nộp {used}/{daily_limit} bài hợp lệ cho "
            f"{get_task_config(task).display_name} — {SPLIT_DISPLAY[split]} hôm nay. "
            "Lượt nộp được làm mới lúc 00:00 (giờ Việt Nam)."
        )

    file_name, digest, result, error = "", "", None, None
    try:
        url, file_name = find_attachment(fields.get("File submission", ""), repository)
        data = fetch(url, token)
        digest = sha256(data).hexdigest()
        submission_df, _ = read_submission(NamedBytesIO(data, file_name))
        result = grade_submission(task, split, submission_df)
    except (SubmissionProblem, SubmissionReadError) as exc:
        error = str(exc)
    except FileNotFoundError as exc:
        # The organizer's data is missing: not the participant's fault, so nothing is recorded.
        return "error", (
            "## ⚠️ Hệ thống chưa sẵn sàng\n\nMáy chấm chưa có đáp án cho tác vụ này "
            f"({exc}). Ban tổ chức sẽ kiểm tra; bạn có thể nộp lại sau."
        )

    record = build_record(
        submission_id=f"gh-{issue['number']}",
        source="github-issue",
        team=team,
        task=task,
        split=split,
        submitted_at=submitted_at,
        file_name=file_name,
        file_sha256=digest,
        result=result,
        error=error,
        extra={
            "github_login": login,
            "issue_number": issue["number"],
            "issue_url": issue.get("html_url"),
            "note": fields.get("Ghi chú", "")[:500],
        },
    )
    save_record(record, results_dir)

    records = load_records(results_dir)
    limit_info = ""
    if daily_limit > 0 and record["valid"]:
        limit_info = f"Lượt nộp hôm nay ({SPLIT_DISPLAY[split]}): {used + 1}/{daily_limit}."
    snippet = leaderboard_snippet(records, task, team) if record["valid"] else ""
    return ("graded" if record["valid"] else "invalid"), comment_for_result(record, snippet, site_url, limit_info)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event", default=os.environ.get("GITHUB_EVENT_PATH"))
    parser.add_argument("--comment-file", required=True)
    args = parser.parse_args()

    event = json.loads(Path(args.event).read_text(encoding="utf-8"))
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    status, comment = grade_issue(
        event,
        repository=repository,
        token=os.environ.get("GITHUB_TOKEN"),
        site_url=os.environ.get("SITE_URL") or None,
        daily_limit=int(os.environ.get("MAX_DAILY_SUBMISSIONS") or 0),
        teams_path=ROOT / "teams.json",
    )
    Path(args.comment_file).write_text(comment + "\n", encoding="utf-8")
    write_output("status", status)
    print(f"status={status}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

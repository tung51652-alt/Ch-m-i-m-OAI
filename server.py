"""Web server for the OAI T7 grader: submit page + leaderboard, both served from site/.

Run:  python server.py [--port 8000]
Ground truth is read from GRADER_DATA_ROOT (default: parent of this repo).
The site is protected by a shared password ($GRADER_PASSWORD or .grader_password,
generated on first start). Storage is plain JSON files in results/; no database.
"""
from __future__ import annotations

import argparse
import asyncio
from hashlib import sha256
from io import BytesIO
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from leaderboard import (
    ACTIVE_TASKS,
    SPLIT_DISPLAY,
    build_leaderboard,
    build_record,
    count_today,
    export_site_data,
    load_records,
    new_submission_id,
    normalize_team,
    ranking_split,
    save_record,
    task_splits,
    team_names,
    utc_now,
)
from scoring import SubmissionReadError, grade_submission, read_submission
from sitelock import check_password, load_password


APP_DIR = Path(__file__).resolve().parent
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_TEAM_NAME = 40


class NamedBytesIO(BytesIO):
    def __init__(self, data: bytes, name: str):
        super().__init__(data)
        self.name = name


def repository_from_git() -> str | None:
    """owner/repo of the origin remote, used for links back to GitHub."""
    try:
        url = subprocess.run(["git", "-C", str(APP_DIR), "remote", "get-url", "origin"],
                             capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    match = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$", url)
    return match.group(1) if match else None


REPOSITORY = repository_from_git()
PASSWORD = load_password(create=True)
PASSWORD_HEADER = "X-Grader-Password"


def error(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"ok": False, "message": message}, status_code=status)


async def authorized(supplied: str | None) -> bool:
    # The page URI-encodes the header so non-ASCII passwords survive HTTP headers.
    if check_password(unquote(supplied or ""), PASSWORD):
        return True
    await asyncio.sleep(0.5)  # slow down password guessing
    return False


async def leaderboard_json(request: Request) -> JSONResponse:
    if not await authorized(request.headers.get(PASSWORD_HEADER)):
        return error("Sai mật khẩu.", 401)
    data = export_site_data(load_records(), REPOSITORY, submit_mode="api")
    data["teams"] = team_names()
    return JSONResponse(data, headers={"Cache-Control": "no-store"})


async def submit(request: Request) -> JSONResponse:
    if not await authorized(request.headers.get(PASSWORD_HEADER)):
        return error("Sai mật khẩu.", 401)
    form = await request.form(max_part_size=MAX_UPLOAD_BYTES)

    team = normalize_team(form.get("team", ""))
    task = str(form.get("task", ""))
    split = str(form.get("split", ""))
    upload = form.get("file")
    allowed_teams = team_names()
    if not team:
        return error("Vui lòng chọn đội.")
    if allowed_teams and team not in allowed_teams:
        return error(f"Đội không hợp lệ. Chỉ chấp nhận: {', '.join(allowed_teams)}.")
    if len(team) > MAX_TEAM_NAME:
        return error(f"Tên đội tối đa {MAX_TEAM_NAME} ký tự.")
    if task not in ACTIVE_TASKS:
        return error("Tác vụ không hợp lệ.")
    if split not in task_splits(task):
        return error("Tập đánh giá không hợp lệ.")
    if upload is None or not getattr(upload, "filename", ""):
        return error("Vui lòng chọn file .csv hoặc .zip.")

    data = await upload.read()
    if len(data) > MAX_UPLOAD_BYTES:
        return error("File vượt quá giới hạn 50 MB.")

    daily_limit = int(os.environ.get("MAX_DAILY_SUBMISSIONS") or 0)
    submitted_at = utc_now()
    if daily_limit > 0:
        used = count_today(load_records(), team, task, split, submitted_at)
        if used >= daily_limit:
            return error(f"Đội {team} đã dùng hết {daily_limit} lượt nộp hợp lệ hôm nay cho "
                         f"{SPLIT_DISPLAY[split]}. Lượt nộp làm mới lúc 00:00.", 429)

    result, read_error = None, None
    try:
        frame, _ = read_submission(NamedBytesIO(data, upload.filename))
        # Grading is CPU-bound; run it off the event loop.
        result = await run_in_threadpool(grade_submission, task, split, frame)
    except SubmissionReadError as exc:
        read_error = str(exc)
    except FileNotFoundError as exc:
        return error(f"Máy chấm chưa có đáp án cho tác vụ này ({exc}). Liên hệ ban tổ chức.", 503)

    record = build_record(
        submission_id=new_submission_id("web", submitted_at),
        source="web",
        team=team,
        task=task,
        split=split,
        submitted_at=submitted_at,
        file_name=upload.filename,
        file_sha256=sha256(data).hexdigest(),
        result=result,
        error=read_error,
    )
    save_record(record)

    response = {
        "ok": True,
        "submission": {k: record[k] for k in [
            "id", "team", "task", "split", "submitted_at", "valid", "score",
            "metric_name", "errors", "warnings", "stats",
        ]},
    }
    if record["valid"]:
        rows = build_leaderboard(load_records(), task)
        row = next(r for r in rows if r["team"] == team)
        response["standing"] = {
            "rank": row["rank"],
            "ranked_teams": sum(1 for r in rows if r["rank"]),
            "best": row["best"],
            "ranking_split": ranking_split(task),
        }
    return JSONResponse(response)


app = Starlette(routes=[
    Route("/leaderboard.json", leaderboard_json),
    Route("/api/submit", submit, methods=["POST"]),
    Mount("/", StaticFiles(directory=APP_DIR / "site", html=True)),
])


def main() -> int:
    import uvicorn

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    source = "biến GRADER_PASSWORD" if os.environ.get("GRADER_PASSWORD") else ".grader_password"
    print(f"OAI T7 grader: http://localhost:{args.port}/", flush=True)
    print(f"Mật khẩu ({source}): {PASSWORD}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

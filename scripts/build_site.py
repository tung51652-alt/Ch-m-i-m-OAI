"""Build the static GitHub Pages site: site/* plus a leaderboard.json snapshot.

With a password (GRADER_PASSWORD) the payload is encrypted and also carries the
ground truth, so the page can grade submissions in the browser (site/grader.js).
The ground truth is never published without encryption.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from leaderboard import ACTIVE_TASKS, export_site_data, load_records, task_splits  # noqa: E402
from scoring import get_task_config, load_ground_truth  # noqa: E402
from sitelock import encrypt_json, load_password  # noqa: E402


def ground_truth_payload() -> dict:
    """{task: {split: {"ids": [...], "labels": [...]}}} for every split whose file is available."""
    truth: dict = {}
    for task in ACTIVE_TASKS:
        config = get_task_config(task)
        for split in task_splits(task):
            try:
                frame = load_ground_truth(task, split)
            except (OSError, RuntimeError, ValueError):
                continue
            truth.setdefault(task, {})[split] = {
                "ids": frame[config.id_col].astype(str).tolist(),
                "labels": frame[config.label_col].astype(str).tolist(),
            }
    return truth


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(ROOT / "_site"))
    args = parser.parse_args()

    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "site", out)

    repository = os.environ.get("GITHUB_REPOSITORY")
    data = export_site_data(load_records(), repository=repository)
    password = load_password()
    if password:
        truth = ground_truth_payload()
        if truth:
            data["ground_truth"] = truth
            data["submit_mode"] = "static"
        # Pages is public static hosting: only the encrypted payload is published.
        payload = encrypt_json(data, password)
    else:
        print("::warning::Chưa có GRADER_PASSWORD; leaderboard.json được publish không mã hóa.")
        payload = data
    (out / "leaderboard.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    (out / ".nojekyll").touch()
    print(f"Built {out} with {len(data['history'])} submissions "
          f"(encrypted={bool(password)}, mode={data['submit_mode']}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

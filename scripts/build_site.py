"""Build the static GitHub Pages site: site/* plus a leaderboard.json snapshot."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from leaderboard import export_site_data, load_records  # noqa: E402
from sitelock import encrypt_json, load_password  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(ROOT / "_site"))
    args = parser.parse_args()

    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "site", out)

    data = export_site_data(load_records(), repository=os.environ.get("GITHUB_REPOSITORY"))
    password = load_password()
    if password:
        # Pages is public static hosting: only the encrypted payload is published.
        payload = encrypt_json(data, password)
    else:
        print("::warning::Chưa có GRADER_PASSWORD; leaderboard.json được publish không mã hóa.")
        payload = data
    (out / "leaderboard.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    (out / ".nojekyll").touch()
    print(f"Built {out} with {len(data['history'])} submissions (encrypted={bool(password)}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

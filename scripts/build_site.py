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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(ROOT / "_site"))
    args = parser.parse_args()

    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "site", out)

    data = export_site_data(load_records(), repository=os.environ.get("GITHUB_REPOSITORY"))
    (out / "leaderboard.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / ".nojekyll").touch()
    print(f"Built {out} with {len(data['history'])} submissions.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

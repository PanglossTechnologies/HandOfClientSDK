"""Puts embed.global.js and hoc-head.min.js into static/ (your app serves them itself; the platform does not).

    python fetch_assets.py            # copy from this checkout's build (run `npm install && npm run build` at the repo root first)
    python fetch_assets.py --release  # download from the latest GitHub release instead
"""
import shutil
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIST = HERE.parents[2] / "sdk" / "embed-js" / "dist"
RELEASE = "https://github.com/PanglossTechnologies/HandOfClientSDK/releases/latest/download/"
FILES = ["embed.global.js", "hoc-head.min.js"]


def main() -> int:
    (HERE / "static").mkdir(exist_ok=True)
    for name in FILES:
        target = HERE / "static" / name
        if "--release" in sys.argv:
            try:
                with urllib.request.urlopen(RELEASE + name, timeout=30) as res:  # noqa: S310 - fixed https URL
                    target.write_bytes(res.read())
            except Exception as e:  # noqa: BLE001 - tell the user what to do instead of a traceback
                print(f"Could not download {name} from the latest release ({e}). Build it instead: npm install && npm run build, then re-run without --release.")
                return 1
        else:
            source = DIST / name
            if not source.exists():
                print(f"{source} not found. Run `npm install && npm run build` at the repo root, or use --release.")
                return 1
            shutil.copyfile(source, target)
        print(f"static/{name} ({target.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

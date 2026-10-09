"""Run the language-neutral conformance suite (host-modules/conformance) against this package under each framework.

    python conformance/run_conformance.py [flask|django|fastapi ...] [--only <suite file part>] [--reporter dot]

Each app is started on a free port with a brand-new SQLite database, the suite runs against it (Node 20+), and the
app is stopped again. Exit code is non-zero if any framework fails.
"""
from __future__ import annotations

import argparse
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUN_MJS = HERE.parent.parent / "conformance" / "run.mjs"
APPS = {"flask": "flask_app.py", "django": "django_app.py", "fastapi": "fastapi_app.py"}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_ready(port: int, proc: subprocess.Popen, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"app exited early with code {proc.returncode}")
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/hoc/api/features", timeout=2)
        except urllib.error.HTTPError:
            return  # 401 = the module is answering
        except Exception:  # noqa: BLE001 - not up yet
            time.sleep(0.3)
    raise RuntimeError("app did not start in time")


def run_one(framework: str, extra: list, db: str) -> int:
    tmp = tempfile.mkdtemp(prefix=f"hoc-{framework}-")
    port, platform_port = free_port(), free_port()
    env = {**os.environ, "HOC_CONFORMANCE_DB": os.path.join(tmp, "hoc.db"), "HOC_CONFORMANCE_PLATFORM_PORT": str(platform_port),
           "PYTHONPATH": os.pathsep.join([str(HERE.parent / "src"), str(HERE)])}
    pg = None
    if db == "postgres":  # an embedded, throwaway PostgreSQL (pip install pgserver psycopg[binary])
        import pgserver

        pg = pgserver.get_server(os.path.join(tmp, "pgdata"), cleanup_mode="stop")
        env["HOC_CONFORMANCE_DATABASE_URL"] = pg.get_uri()
    elif db == "env":  # use HOC_CONFORMANCE_DATABASE_URL as given (an empty database!)
        if not env.get("HOC_CONFORMANCE_DATABASE_URL"):
            raise SystemExit("--db env needs HOC_CONFORMANCE_DATABASE_URL")
    app = subprocess.Popen([sys.executable, str(HERE / APPS[framework]), "--port", str(port)], env=env, cwd=tmp)
    try:
        wait_ready(port, app)
        print(f"== {framework} on :{port} ==", flush=True)
        return subprocess.call(
            ["node", str(RUN_MJS), "--base-url", f"http://127.0.0.1:{port}/hoc", "--platform-port", str(platform_port), "--fresh-db", *extra],
            env=env,
        )
    finally:
        app.terminate()
        try:
            app.wait(timeout=10)
        except subprocess.TimeoutExpired:
            app.kill()
        if pg is not None:
            pg.cleanup()
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("frameworks", nargs="*", help="any of: " + ", ".join(APPS) + " (default: all)")
    ap.add_argument("--db", choices=["sqlite", "postgres", "env"], default="sqlite", help="storage under test (default sqlite)")
    ap.add_argument("--only")
    ap.add_argument("--reporter")
    a = ap.parse_args()
    unknown = [f for f in a.frameworks if f not in APPS]
    if unknown:
        ap.error(f"unknown framework {unknown}; choose from {list(APPS)}")
    extra = (["--only", a.only] if a.only else []) + (["--reporter", a.reporter] if a.reporter else [])
    codes = {f: run_one(f, extra, a.db) for f in (a.frameworks or list(APPS))}
    print("\n".join(f"{f}: {'PASS' if c == 0 else 'FAIL'}" for f, c in codes.items()))
    return 0 if all(c == 0 for c in codes.values()) else 1


if __name__ == "__main__":
    sys.exit(main())

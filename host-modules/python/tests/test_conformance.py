"""Runs the language-neutral CL-16 suite (host-modules/conformance, Node 20+) against this package under each framework."""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

RUNNER = Path(__file__).resolve().parent.parent / "conformance" / "run_conformance.py"


@pytest.mark.skipif(shutil.which("node") is None, reason="Node 20+ is needed for the conformance suite")
@pytest.mark.parametrize("framework", ["flask", "django", "fastapi"])
def test_conformance_suite_passes(framework):
    pytest.importorskip(framework)
    out = subprocess.run([sys.executable, str(RUNNER), framework, "--reporter", "dot"], capture_output=True, text=True, timeout=600)
    assert out.returncode == 0, out.stdout[-6000:] + out.stderr[-3000:]

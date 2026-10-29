"""Compatibility wrapper for Practical-RIFE on modern NumPy."""

from __future__ import annotations

import os
import runpy
import sys
from pathlib import Path

import numpy as np


def main() -> int:
    """Patch removed NumPy aliases, then execute Practical-RIFE's CLI unchanged."""
    if not hasattr(np, "float"):
        np.float = float  # type: ignore[attr-defined]
    if not hasattr(np, "int"):
        np.int = int  # type: ignore[attr-defined]
    root = Path(os.environ.get("RIFE_ROOT", r"D:\AI-Models\Practical-RIFE"))
    script = root / "inference_video.py"
    sys.path.insert(0, str(root))
    sys.argv[0] = str(script)
    runpy.run_path(str(script), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

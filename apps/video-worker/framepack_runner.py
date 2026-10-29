"""Isolated FramePack shot generation.

FramePack can reserve tens of gigabytes of committed host memory while its models
are loaded. Running it out-of-process guarantees that memory is returned before
RIFE, Real-ESRGAN, or the next story shot starts.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import shutil
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--negative-prompt", required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--steps", type=int, required=True)
    parser.add_argument("--preserved-memory-gb", type=float, required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    framepack_root = Path(os.environ.get("FRAMEPACK_ROOT", r"D:\AI-Models\FramePack"))
    if not framepack_root.is_dir():
        raise RuntimeError("FramePack source is unavailable.")

    sys.path.insert(0, str(framepack_root))
    os.chdir(framepack_root)
    sys.argv = ["demo_gradio.py"]

    import numpy as np
    from PIL import Image

    framepack = importlib.import_module("demo_gradio")
    image = np.asarray(Image.open(args.source).convert("RGB"))
    generated: Path | None = None
    for update in framepack.process(
        image,
        args.prompt,
        args.negative_prompt,
        args.seed,
        args.duration,
        9,
        args.steps,
        1.0,
        10.0,
        0.0,
        args.preserved_memory_gb,
        True,
        18,
    ):
        candidate = update[0] if isinstance(update, (tuple, list)) and update else None
        if isinstance(candidate, str) and Path(candidate).is_file():
            generated = Path(candidate)

    if not generated:
        raise RuntimeError("FramePack did not produce a video.")

    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(generated, output)
    print(json.dumps({"outputPath": str(output), "durationSeconds": args.duration}), flush=True)

    # Avoid slow interpreter/model teardown while Windows pages tens of GB back in.
    os._exit(0)


if __name__ == "__main__":
    main()

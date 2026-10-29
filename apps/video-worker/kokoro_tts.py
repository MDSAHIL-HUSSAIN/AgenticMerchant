"""Render optional narration with the local Kokoro-82M model and voice pack."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro import KModel, KPipeline


def main() -> int:
    """Synthesize text with local-only Kokoro model files."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model-root", default=r"D:\AI-Models\Kokoro-82M")
    parser.add_argument("--voice", default="af_heart.pt")
    args = parser.parse_args()

    root = Path(args.model_root)
    model = KModel(config=str(root / "config.json"), model=str(root / "kokoro-v1_0.pth"))
    pipeline = KPipeline(lang_code="a", repo_id=None, model=model)
    voice = str(root / "voices" / args.voice)
    chunks = [np.asarray(result.audio, dtype=np.float32) for result in pipeline(args.text, voice=voice, speed=0.96)]
    if not chunks:
        raise RuntimeError("Kokoro produced no narration audio.")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(output, np.concatenate(chunks), 24000)
    print(str(output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

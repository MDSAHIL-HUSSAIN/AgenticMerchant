"""Generate an original instrumental soundtrack with the local ACE-Step 1.5 model."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path


def main() -> int:
    """Load ACE-Step in low-VRAM mode and write one soundtrack file."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--bpm", type=int, default=96)
    parser.add_argument("--seed", type=int, default=20261029)
    args = parser.parse_args()

    root = Path(os.environ.get("ACESTEP_ROOT", r"D:\AI-Models\ACE-Step"))
    sys.path.insert(0, str(root))
    os.environ.setdefault("ACESTEP_CHECKPOINTS_DIR", str(root / "checkpoints"))

    from acestep.handler import AceStepHandler
    from acestep.inference import GenerationConfig, GenerationParams, generate_music

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    generation_dir = output.parent / "ace-step-generation"
    generation_dir.mkdir(parents=True, exist_ok=True)

    handler = AceStepHandler()
    status, ready = handler.initialize_service(
        project_root=str(root),
        config_path="acestep-v15-turbo",
        device="cuda",
        offload_to_cpu=True,
        offload_dit_to_cpu=True,
        compile_model=False,
        quantization=None,
    )
    if not ready:
        raise RuntimeError(f"ACE-Step initialization failed: {status}")

    params = GenerationParams(
        task_type="text2music",
        caption=args.prompt,
        lyrics="",
        instrumental=True,
        bpm=args.bpm,
        keyscale="D minor",
        timesignature="4",
        duration=max(10.0, min(600.0, args.duration)),
        inference_steps=8,
        guidance_scale=1.0,
        seed=args.seed,
        thinking=False,
        use_cot_metas=False,
        use_cot_caption=False,
        use_cot_lyrics=False,
        use_cot_language=False,
    )
    config = GenerationConfig(
        batch_size=1,
        audio_format="wav",
        use_random_seed=False,
        seeds=[args.seed],
    )
    result = generate_music(handler, None, params, config, save_dir=str(generation_dir))
    if not result.success or not result.audios:
        raise RuntimeError(result.error or result.status_message or "ACE-Step produced no audio.")
    generated = Path(result.audios[0]["path"])
    shutil.copy2(generated, output)
    print(json.dumps({"ok": True, "outputPath": str(output), "bpm": args.bpm, "seed": args.seed}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

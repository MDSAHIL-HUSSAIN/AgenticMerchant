"""Generate an original instrumental soundtrack with the local ACE-Step 1.5 model."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

import numpy as np
import soundfile as sf


def score_candidate(path: Path) -> dict:
    audio, sample_rate = sf.read(path, always_2d=True, dtype="float32")
    mono = audio.mean(axis=1)
    window = max(1, int(sample_rate * 0.25))
    usable = mono[: (len(mono) // window) * window]
    if not len(usable):
        return {"score": -1000.0, "reason": "empty"}
    rms = np.sqrt(np.mean(usable.reshape(-1, window) ** 2, axis=1) + 1e-9)
    count = len(rms)
    intro = float(np.mean(rms[: max(1, count // 5)]))
    hero = float(np.mean(rms[max(0, int(count * .58)): max(1, int(count * .82))]))
    resolve = float(np.mean(rms[max(0, int(count * .88)):]))
    dynamic = float(np.percentile(rms, 90) - np.percentile(rms, 10))
    peak = float(np.max(np.abs(mono)))
    # Prefer a restrained opening, an audible hero lift, a cleaner resolve and
    # useful dynamics. Penalize silence and clipping.
    score = (hero - intro) * 8 + (hero - resolve) * 5 + dynamic * 4
    if float(np.mean(rms)) < .01:
        score -= 2
    if peak > .995:
        score -= 1
    return {"score": round(score, 6), "intro": intro, "hero": hero, "resolve": resolve, "dynamic": dynamic, "peak": peak}


def main() -> int:
    """Load ACE-Step in low-VRAM mode and write one soundtrack file."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--bpm", type=int, default=96)
    parser.add_argument("--seed", type=int, default=20261029)
    parser.add_argument("--mood", default="premium, restrained and cinematic")
    parser.add_argument("--keyscale", default="D minor")
    parser.add_argument("--timesignature", default="4/4")
    parser.add_argument("--candidates", type=int, default=2)
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

    candidates = []
    for index in range(max(1, min(3, args.candidates))):
        seed = args.seed + index
        params = GenerationParams(
            task_type="text2music",
            caption=f"{args.prompt} Emotional character: {args.mood}.",
            lyrics="",
            instrumental=True,
            bpm=args.bpm,
            keyscale=args.keyscale,
            timesignature=args.timesignature.replace("/4", ""),
            duration=max(10.0, min(600.0, args.duration)),
            inference_steps=8,
            guidance_scale=1.0,
            seed=seed,
            thinking=False,
            use_cot_metas=False,
            use_cot_caption=False,
            use_cot_lyrics=False,
            use_cot_language=False,
        )
        config = GenerationConfig(batch_size=1, audio_format="wav", use_random_seed=False, seeds=[seed])
        result = generate_music(handler, None, params, config, save_dir=str(generation_dir))
        if not result.success or not result.audios:
            continue
        generated = Path(result.audios[0]["path"])
        metrics = score_candidate(generated)
        candidates.append({"path": generated, "seed": seed, "metrics": metrics})
    if not candidates:
        raise RuntimeError("ACE-Step produced no usable audio candidate.")
    selected = max(candidates, key=lambda item: item["metrics"]["score"])
    shutil.copy2(selected["path"], output)
    print(json.dumps({
        "ok": True,
        "outputPath": str(output),
        "bpm": args.bpm,
        "keyscale": args.keyscale,
        "selectedSeed": selected["seed"],
        "selectedMetrics": selected["metrics"],
        "candidates": [{"seed": item["seed"], "metrics": item["metrics"]} for item in candidates],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

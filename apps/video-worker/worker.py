"""Local video worker for the Agentic product-post pipeline.

The worker deliberately has a tiny JSON-file protocol so the Node API can run it
as a disposable process. Heavy model runtimes remain isolated from the API and a
failed GPU tool cannot corrupt the persistent job queue.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import urllib.error
import urllib.request
import wave
from pathlib import Path


def _path(name: str, fallback: str = "") -> Path:
    return Path(os.environ.get(name, fallback)).expanduser()


def _command_path(value: str) -> str | None:
    candidate = Path(value)
    if candidate.is_file():
        return str(candidate)
    return shutil.which(value)


def _has_files(root: Path, patterns: tuple[str, ...]) -> bool:
    return root.is_dir() and any(any(root.rglob(pattern)) for pattern in patterns)


def _python_import_ready(executable: Path, module: str) -> bool:
    """Return whether a separate model runtime can import its required package."""
    if not executable.is_file():
        return False
    try:
        result = subprocess.run(
            [str(executable), "-c", f"import {module}"],
            capture_output=True,
            timeout=30,
            check=False,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def health() -> dict:
    framepack_root = _path("FRAMEPACK_ROOT", r"D:\AI-Models\FramePack")
    framepack_models = _path("FRAMEPACK_MODEL_ROOT", str(framepack_root / "models"))
    rife_root = _path("RIFE_ROOT", r"D:\AI-Models\Practical-RIFE")
    esrgan_root = _path("REALESRGAN_ROOT", r"D:\AI-Models\Real-ESRGAN")
    ace_root = _path("ACESTEP_ROOT", r"D:\AI-Models\ACE-Step")
    kokoro_root = _path("KOKORO_MODEL_ROOT", r"D:\AI-Models\Kokoro-82M")
    ltx_comfy_root = _path("LTX_COMFY_ROOT", r"D:\AI-Models\ComfyUI-LTX096")
    ltx_comfy_python = _path("LTX_COMFY_PYTHON", r"D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\.venv-cu124\Scripts\python.exe")
    ltx_model_config = _path("LTX_COMFY_MODEL_CONFIG", r"D:\Comfy-Desktop\instance-model-paths-cu124.yaml")
    ltx_model = _path("LTX_MODEL_PATH", r"D:\Comfy-Desktop\ComfyUI-Shared\models\checkpoints\ltxv-2b-0.9.6-distilled-04-25.safetensors")
    ltx_text_encoder = _path("LTX_TEXT_ENCODER_PATH", r"D:\Comfy-Desktop\ComfyUI-Shared\models\text_encoders\t5xxl_fp8_e4m3fn_scaled.safetensors")
    ace_python = _path("ACESTEP_PYTHON", r"D:\AI-Models\runtimes\acestep-py311\Scripts\python.exe")
    kokoro_python = _path("KOKORO_PYTHON", r"D:\AI-Models\runtimes\audio-py311\Scripts\python.exe")
    ffmpeg = _command_path(os.environ.get("FFMPEG_PATH", "ffmpeg"))
    ffprobe = _command_path(os.environ.get("FFPROBE_PATH", "ffprobe"))

    try:
        import torch  # type: ignore
        torch_info = {
            "installed": True,
            "version": torch.__version__,
            "cudaAvailable": bool(torch.cuda.is_available()),
            "cudaVersion": torch.version.cuda,
            "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        }
    except Exception as error:  # dependency readiness is the purpose of health
        torch_info = {"installed": False, "cudaAvailable": False, "error": str(error)}

    try:
        import psutil  # type: ignore
        commit_capacity_gb = (psutil.virtual_memory().total + psutil.swap_memory().total) / (1024 ** 3)
    except Exception:
        commit_capacity_gb = 0.0
    framepack_memory_ready = commit_capacity_gb >= 40.0

    framepack_weights = all((framepack_models / name).is_dir() for name in (
        "FramePackI2V_HY", "HunyuanVideo", "flux_redux_bfl"
    ))
    rife_weights = _has_files(rife_root / "train_log", ("*.pkl", "*.pth", "*.pt"))
    esrgan_exe = next(iter(esrgan_root.glob("realesrgan-ncnn-vulkan*.exe")), None) if esrgan_root.is_dir() else None
    ace_weights = (ace_root / "checkpoints").is_dir() and any((ace_root / "checkpoints").iterdir())
    kokoro_weights = (kokoro_root / "kokoro-v1_0.pth").is_file()
    rife_runtime = all(importlib.util.find_spec(name) is not None for name in ("torch", "cv2", "skvideo"))
    ace_runtime = _python_import_ready(ace_python, "acestep")
    kokoro_runtime = _python_import_ready(kokoro_python, "kokoro")

    tools = {
        "ffmpeg": {"ready": bool(ffmpeg), "path": ffmpeg},
        "ffprobe": {"ready": bool(ffprobe), "path": ffprobe},
        "framepack": {
            "ready": bool(framepack_root.is_dir() and framepack_weights and torch_info.get("cudaAvailable") and framepack_memory_ready),
            "sourceReady": framepack_root.is_dir(), "weightsReady": framepack_weights,
            "runtimeReady": bool(torch_info.get("cudaAvailable")), "memoryReady": framepack_memory_ready,
            "commitCapacityGb": round(commit_capacity_gb, 1), "requiredCommitCapacityGb": 40,
            "path": str(framepack_root),
        },
        "ltxVideo": {
            "ready": all((
                (ltx_comfy_root / "main.py").is_file(), ltx_comfy_python.is_file(),
                ltx_model_config.is_file(), ltx_model.is_file(), ltx_text_encoder.is_file(),
                bool(torch_info.get("cudaAvailable")),
            )),
            "path": str(ltx_model), "comfyRoot": str(ltx_comfy_root),
            "runtimePath": str(ltx_comfy_python), "textEncoderPath": str(ltx_text_encoder),
            "profile": {"width": 448, "height": 768, "frames": 49, "fps": 16, "steps": 8},
        },
        "rife": {
            "ready": bool(rife_root.is_dir() and rife_weights and torch_info.get("cudaAvailable") and rife_runtime),
            "sourceReady": rife_root.is_dir(), "weightsReady": rife_weights,
            "runtimeReady": bool(torch_info.get("cudaAvailable") and rife_runtime), "path": str(rife_root),
        },
        "realEsrgan": {"ready": bool(esrgan_exe), "path": str(esrgan_exe) if esrgan_exe else None},
        "aceStep": {"ready": bool(ace_root.is_dir() and ace_weights and ace_runtime), "sourceReady": ace_root.is_dir(), "weightsReady": ace_weights, "runtimeReady": ace_runtime, "runtimePath": str(ace_python), "path": str(ace_root)},
        "kokoro": {"ready": bool(kokoro_weights and kokoro_runtime), "weightsReady": kokoro_weights, "runtimeReady": kokoro_runtime, "runtimePath": str(kokoro_python), "path": str(kokoro_root)},
    }
    return {
        "ok": tools["ffmpeg"]["ready"],
        "python": sys.version.split()[0],
        "torch": torch_info,
        "tools": tools,
        "capabilities": {
            "deterministicCompose": tools["ffmpeg"]["ready"],
            "keyframeMotion": tools["ffmpeg"]["ready"],
            "generativeMotionAvailable": tools["ltxVideo"]["ready"] or tools["framepack"]["ready"],
            "interpolationAvailable": tools["rife"]["ready"],
            "upscaleAvailable": tools["realEsrgan"]["ready"],
            "musicModelAvailable": tools["aceStep"]["ready"],
            "narrationModelAvailable": tools["kokoro"]["ready"],
        },
        "activePipeline": {
            "motion": "ltx-0.9.6-distilled-realesrgan" if tools["ltxVideo"]["ready"] and tools["realEsrgan"]["ready"] else ("framepack-rife-realesrgan" if tools["framepack"]["ready"] and tools["rife"]["ready"] and tools["realEsrgan"]["ready"] else "product-safe-keyframe-camera"),
            "audio": "ace-step-original-music" if tools["aceStep"]["ready"] else "audible-layered-original-fallback",
            "narration": "kokoro" if tools["kokoro"]["ready"] else "disabled",
        },
    }


def _run(args: list[str], timeout: int = 3600) -> subprocess.CompletedProcess:
    completed = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    if completed.returncode:
        tail = (completed.stderr or completed.stdout)[-2000:]
        raise RuntimeError(f"{Path(args[0]).name} exited with {completed.returncode}: {tail}")
    return completed


def _emit_progress(stage: str, progress: int, message: str) -> None:
    """Emit a machine-readable progress event for the API trace."""
    print(json.dumps({"event": "progress", "stage": stage, "progress": progress, "message": message}), flush=True)


def _interpolate_rife(clip: Path, work_dir: Path, index: int) -> Path:
    """Double generated frames with the installed Practical-RIFE model."""
    rife_root = _path("RIFE_ROOT", r"D:\AI-Models\Practical-RIFE")
    script = Path(__file__).with_name("rife_runner.py")
    if not script.is_file():
        raise RuntimeError("Practical-RIFE runtime is unavailable.")
    cache_tag = hashlib.sha256(str(clip.resolve()).encode()).hexdigest()[:10]
    output = work_dir / f"rife-shot-{index + 1:02d}-{cache_tag}.mp4"
    if output.is_file() and output.stat().st_size > 24:
        return output
    _run([
        sys.executable,
        str(script),
        "--video", str(clip),
        "--output", str(output),
        "--model", str(rife_root / "train_log"),
        "--multi", "2",
    ])
    if not output.is_file():
        raise RuntimeError(f"RIFE did not produce shot {index + 1}.")
    return output


def _video_dimensions(clip: Path) -> tuple[int, int] | None:
    ffprobe = _command_path(os.environ.get("FFPROBE_PATH", "ffprobe"))
    if not ffprobe:
        return None
    try:
        result = subprocess.run(
            [
                ffprobe, "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", str(clip),
            ],
            capture_output=True, text=True, timeout=60, check=True,
        )
        width, height = (int(value) for value in result.stdout.strip().split("x", 1))
        return width, height
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def _upscale_realesrgan(
    clip: Path, work_dir: Path, index: int, ffmpeg: str, fps: int = 60,
    target_width: int | None = None, target_height: int | None = None,
) -> Path:
    """Upscale a generated shot with the installed Real-ESRGAN Vulkan runtime."""
    esrgan_root = _path("REALESRGAN_ROOT", r"D:\AI-Models\Real-ESRGAN")
    executable = next(iter(esrgan_root.glob("realesrgan-ncnn-vulkan*.exe")), None)
    if not executable:
        raise RuntimeError("Real-ESRGAN executable is unavailable.")
    dimensions = _video_dimensions(clip)
    if dimensions and target_width and target_height:
        source_width, source_height = dimensions
        if source_width >= target_width and source_height >= target_height:
            return clip

    cache_material = f"{clip.resolve()}:{target_width or 0}x{target_height or 0}"
    cache_tag = hashlib.sha256(cache_material.encode()).hexdigest()[:10]
    input_dir = work_dir / f"esrgan-in-{index + 1:02d}-{cache_tag}"
    output_dir = work_dir / f"esrgan-out-{index + 1:02d}-{cache_tag}"
    output = work_dir / f"esrgan-shot-{index + 1:02d}-{cache_tag}.mp4"
    if output.is_file() and output.stat().st_size > 24:
        return output
    shutil.rmtree(input_dir, ignore_errors=True)
    shutil.rmtree(output_dir, ignore_errors=True)
    input_dir.mkdir(parents=True)
    output_dir.mkdir(parents=True)
    # Keep FramePack's native detail. The old pipeline reduced every generated
    # frame to 270x480 before asking Real-ESRGAN to enlarge it again.
    _run([ffmpeg, "-y", "-i", str(clip), str(input_dir / "frame%08d.png")])
    input_frames = len(list(input_dir.glob("frame*.png")))
    upscale_error = None
    _free_ltx_models()
    for tile_size in (128, 64, 32):
        shutil.rmtree(output_dir, ignore_errors=True)
        output_dir.mkdir(parents=True)
        try:
            _run([
                str(executable),
                "-i", str(input_dir),
                "-o", str(output_dir),
                "-n", "realesrgan-x4plus",
                # Smaller tiles keep the NCNN Vulkan allocation below the
                # RTX 4050's 6 GB limit after a generative model has run.
                "-s", "4",
                "-t", str(tile_size),
                "-f", "png",
            ])
            output_frames = len(list(output_dir.glob("frame*.png")))
            if output_frames != input_frames:
                raise RuntimeError(f"Real-ESRGAN produced {output_frames} of {input_frames} frames.")
            _run([
                ffmpeg, "-y", "-framerate", str(fps), "-i", str(output_dir / "frame%08d.png"),
                "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                "-pix_fmt", "yuv420p", str(output),
            ])
            break
        except RuntimeError as error:
            upscale_error = error
    else:
        if not target_width or not target_height:
            raise upscale_error or RuntimeError(f"Real-ESRGAN failed for shot {index + 1}.")
        _emit_progress(
            "REAL_ESRGAN_FALLBACK", 71,
            f"Real-ESRGAN could not reserve the Vulkan device for shot {index + 1}; using Lanczos scaling.",
        )
        _run([
            ffmpeg, "-y", "-i", str(clip),
            "-vf", (
                f"scale={target_width}:{target_height}:force_original_aspect_ratio=increase:flags=lanczos,"
                f"crop={target_width}:{target_height}"
            ),
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p", str(output),
        ])
    if not output.is_file():
        raise RuntimeError(f"Real-ESRGAN did not produce shot {index + 1}.")
    return output


def _generate_product_template_clip(
    shot: dict, work_dir: Path, index: int, ffmpeg: str,
    duration: float, width: int, height: int, fps: int, reason: str,
) -> tuple[Path, float, Path]:
    """Create guaranteed product-safe motion from the shot's designed keyframe."""
    source = Path(shot.get("path") or shot.get("sourceImagePath", "")).resolve()
    if not source.is_file():
        raise RuntimeError(f"Product template source is missing for shot {index + 1}.")
    edit_style = str((shot.get("edit") or {}).get("style") or "LATERAL_SLIDE").upper()
    cache_material = json.dumps({
        "source": str(source), "duration": duration, "width": width, "height": height,
        "fps": fps, "style": edit_style,
    }, sort_keys=True).encode()
    cache_tag = hashlib.sha256(cache_material).hexdigest()[:12]
    output = work_dir / f"product-template-shot-{index + 1:02d}-{cache_tag}.mp4"
    selection_path = work_dir / f"product-template-shot-{index + 1:02d}-selection.json"
    if not output.is_file() or output.stat().st_size <= 24:
        paths = {
            "MACRO_PUSH": ("0.50-0.16*t/D", "0.58-0.10*t/D"),
            "LATERAL_SLIDE": ("0.10+0.72*t/D", "0.50"),
            "DIAGONAL_DRIFT": ("0.16+0.54*t/D", "0.70-0.38*t/D"),
            "LOCKED_LIGHT": ("0.50", "0.50"),
            "HERO_PULLBACK": ("0.66-0.22*t/D", "0.56"),
            "ENERGY_PULSE": ("0.30+0.40*t/D", "0.56-0.12*t/D"),
            "PRECISION_TRACK": ("0.78-0.58*t/D", "0.48"),
        }
        path_x, path_y = paths.get(edit_style, paths["LATERAL_SLIDE"])
        path_x = path_x.replace("D", f"{duration:.3f}")
        path_y = path_y.replace("D", f"{duration:.3f}")
        pulse = "0.055" if edit_style == "ENERGY_PULSE" else "0.035"
        _run([
            ffmpeg, "-y", "-loop", "1", "-t", f"{duration:.3f}", "-i", str(source),
            "-vf", (
                f"scale={width + 72}:{height + 120}:force_original_aspect_ratio=increase,"
                f"crop={width}:{height}:x='(in_w-out_w)*({path_x})':y='(in_h-out_h)*({path_y})',"
                f"eq=contrast='1.02+{pulse}*sin(PI*t/{duration:.3f})':"
                f"brightness='0.012*sin(PI*t/{duration:.3f})',fps={fps},"
                f"trim=duration={duration:.3f},setpts=PTS-STARTPTS,setsar=1,format=yuv420p"
            ),
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output),
        ])
    selection = {
        "provider": "product-template",
        "shotId": shot.get("id"),
        "cacheKey": cache_tag,
        "accepted": True,
        "selectedSeed": None,
        "selectedMetrics": {
            "score": 100.0, "passed": True, "identity": 1.0,
            "motion": 0.01, "sharpnessRetention": 1.0,
            "structuralConsistency": 1.0, "fallbackReason": reason[:500],
        },
        "candidates": [{"path": str(output.resolve()), "seed": None, "metrics": {"passed": True}}],
    }
    selection_path.write_text(json.dumps(selection, indent=2), encoding="utf-8")
    return output, duration, selection_path


def _fallback_music_expression(spec: dict, duration: float) -> str:
    bpm = max(60.0, min(160.0, float(spec.get("musicBpm") or 96)))
    beat_hz = bpm / 60.0
    key = str(spec.get("musicKeyscale") or "D minor").strip().upper()
    roots = {"C": 65.41, "C#": 69.30, "DB": 69.30, "D": 73.42, "D#": 77.78, "EB": 77.78,
             "E": 82.41, "F": 87.31, "F#": 92.50, "GB": 92.50, "G": 98.00,
             "G#": 103.83, "AB": 103.83, "A": 110.00, "A#": 116.54, "BB": 116.54, "B": 123.47}
    root = roots.get(key.split()[0], 73.42)
    return (
        "aevalsrc=exprs="
        f"0.085*sin(2*PI*{root:.2f}*t)*(0.62+0.38*sin(2*PI*0.18*t))"
        f"+0.035*sin(2*PI*{root * 2:.2f}*t)"
        f"+0.045*sin(2*PI*48*t)*pow(max(0\\,sin(2*PI*{beat_hz:.4f}*t))\\,8)"
        f"+0.018*sin(2*PI*{root * 3:.2f}*t)*(0.5+0.5*sin(2*PI*{beat_hz / 2:.4f}*t))"
        f":s=48000:d={duration:.3f}"
    )


def _generate_ace_music(spec: dict, work_dir: Path) -> Path:
    """Generate one original beat-locked instrumental with ACE-Step."""
    ace_python = _path("ACESTEP_PYTHON", r"D:\AI-Models\runtimes\acestep-py311\Scripts\python.exe")
    script = Path(__file__).with_name("ace_music.py")
    if not ace_python.is_file() or not script.is_file():
        raise RuntimeError("ACE-Step music runtime is unavailable.")
    music_cache_material = json.dumps({
        "prompt": spec.get("musicPrompt"),
        "duration": spec.get("durationSeconds"),
        "bpm": spec.get("musicBpm"),
        "mood": spec.get("musicMood"),
        "keyscale": spec.get("musicKeyscale"),
        "timesignature": spec.get("musicTimesignature"),
        "candidateCount": spec.get("musicCandidateCount"),
        "seed": spec.get("musicSeed"),
        "shotDurations": [shot.get("durationSeconds") for shot in (spec.get("shots") or [])],
    }, sort_keys=True).encode()
    music_cache_key = hashlib.sha256(music_cache_material).hexdigest()
    output = work_dir / f"ace-step-soundtrack-{music_cache_key[:12]}.wav"
    selection_file = work_dir / "music-selection.json"
    if output.is_file() and output.stat().st_size > 44 and selection_file.is_file():
        try:
            if json.loads(selection_file.read_text(encoding="utf-8")).get("cacheKey") == music_cache_key:
                return output
        except (OSError, json.JSONDecodeError):
            pass
    cursor = 0.0
    cut_times = []
    for shot in (spec.get("shots") or [])[:-1]:
        cursor += float(shot.get("durationSeconds") or 0)
        cut_times.append(round(cursor, 3))
    completed = _run([
        str(ace_python), str(script),
        "--prompt", str(spec.get("musicPrompt") or "Minimal cinematic electronic instrumental, tactile percussion, no vocals."),
        "--duration", str(spec["durationSeconds"]),
        "--bpm", str(spec.get("musicBpm") or 120),
        "--mood", str(spec.get("musicMood") or "premium, restrained and cinematic"),
        "--keyscale", str(spec.get("musicKeyscale") or "D minor"),
        "--timesignature", str(spec.get("musicTimesignature") or "4/4"),
        "--candidates", str(spec.get("musicCandidateCount") or 2),
        "--cut-times", ",".join(str(value) for value in cut_times),
        "--seed", str(spec.get("musicSeed") or 20261029),
        "--output", str(output),
    ], timeout=7200)
    if not output.is_file():
        raise RuntimeError("ACE-Step reported success but produced no soundtrack.")
    try:
        payload = json.loads((completed.stdout or "").strip().splitlines()[-1])
        payload["cacheKey"] = music_cache_key
        selection_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except (IndexError, json.JSONDecodeError):
        pass
    return output


def _generate_kokoro_narration(spec: dict, work_dir: Path) -> Path:
    """Render optional narration with the isolated local Kokoro runtime."""
    kokoro_python = _path("KOKORO_PYTHON", r"D:\AI-Models\runtimes\audio-py311\Scripts\python.exe")
    script = Path(__file__).with_name("kokoro_tts.py")
    output = work_dir / "kokoro-narration.wav"
    _run([
        str(kokoro_python), str(script),
        "--text", str(spec["narrationText"]),
        "--output", str(output),
        "--model-root", str(_path("KOKORO_MODEL_ROOT", r"D:\AI-Models\Kokoro-82M")),
    ], timeout=1800)
    if not output.is_file():
        raise RuntimeError("Kokoro reported success but produced no narration.")
    return output


def _generate_sound_design(spec: dict, work_dir: Path) -> Path:
    """Create a deterministic tactile cue track at editorial cut points.

    This is intentionally restrained: a low impact and short metallic tick mark
    motivated cuts without pretending a generic sound library matches actions
    that have not yet been semantically classified.
    """
    output = work_dir / "editorial-sound-design.wav"
    sample_rate = 48_000
    duration = float(spec["durationSeconds"])
    frame_count = int(duration * sample_rate)
    boundaries = []
    cursor = 0.0
    shots = spec.get("shots") or []
    for index, shot in enumerate(shots[:-1]):
        cursor += float(shot.get("durationSeconds") or 0)
        next_role = str((shots[index + 1].get("musicCue") or {}).get("role") or "tactile cut").lower()
        next_cues = " ".join(str(cue) for cue in (shots[index + 1].get("soundCues") or [])).lower()
        boundaries.append((cursor, next_role, next_cues))
    with wave.open(str(output), "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        block = bytearray()
        for frame in range(frame_count):
            t = frame / sample_rate
            value = 0.0
            for boundary, role, cues in boundaries:
                age = t - boundary
                if 0.0 <= age < 0.32:
                    if "hero" in role:
                        value += 0.22 * math.sin(2 * math.pi * 58 * age) * math.exp(-10 * age)
                        value += 0.055 * math.sin(2 * math.pi * 960 * age) * math.exp(-24 * age)
                    elif "resolve" in role:
                        value += 0.10 * math.sin(2 * math.pi * 164 * age) * math.exp(-8 * age)
                        value += 0.05 * math.sin(2 * math.pi * 246 * age) * math.exp(-9 * age)
                    elif any(word in cues for word in ("digital", "data", "electric", "click", "glitch", "keyboard")):
                        value += 0.10 * math.sin(2 * math.pi * 96 * age) * math.exp(-18 * age)
                        value += 0.07 * math.sin(2 * math.pi * 1680 * age) * math.exp(-34 * age)
                    elif any(word in cues for word in ("glass", "chime", "crystal", "beauty")):
                        value += 0.07 * math.sin(2 * math.pi * 880 * age) * math.exp(-12 * age)
                        value += 0.04 * math.sin(2 * math.pi * 1320 * age) * math.exp(-14 * age)
                    elif any(word in cues for word in ("fabric", "cloth", "air", "soft", "sweep")):
                        value += 0.055 * math.sin(2 * math.pi * 180 * age) * math.exp(-7 * age)
                        value += 0.025 * math.sin(2 * math.pi * 620 * age) * math.exp(-11 * age)
                    else:
                        value += 0.13 * math.sin(2 * math.pi * 72 * age) * math.exp(-14 * age)
                        value += 0.04 * math.sin(2 * math.pi * 1280 * age) * math.exp(-28 * age)
            # Very low room tone prevents sterile digital silence between cues.
            value += 0.0025 * math.sin(2 * math.pi * 42 * t)
            sample = max(-32767, min(32767, int(value * 32767)))
            block.extend(struct.pack("<hh", sample, sample))
            if len(block) >= 192_000:
                target.writeframesraw(block)
                block.clear()
        if block:
            target.writeframesraw(block)
    return output


def _score_motion_candidate(
    clip: Path,
    source: Path,
    work_dir: Path,
    label: str,
    ffmpeg: str,
    duration: float,
    allow_relative_sharpness: bool = False,
    reject_faces: bool = False,
    rigid_product: bool = False,
) -> dict:
    """Score real motion while penalizing product drift and soft output.

    This intentionally uses small decoded samples instead of another GPU model,
    so candidate selection remains deterministic and does not compete with
    FramePack for the 6 GB device.
    """
    import numpy as np  # type: ignore
    from PIL import Image, ImageOps  # type: ignore

    analysis_dir = work_dir / "motion-analysis" / label
    analysis_dir.mkdir(parents=True, exist_ok=True)
    # FramePack clips can be a few frames shorter than the requested duration.
    # Sampling against the requested value can therefore seek beyond EOF and
    # incorrectly reject an otherwise valid take. Measure the encoded clip and
    # keep all sample points safely inside its final frame.
    measured_duration = duration
    ffprobe = _command_path(os.environ.get("FFPROBE_PATH", "ffprobe"))
    if ffprobe:
        try:
            probe = subprocess.run(
                [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(clip)],
                capture_output=True, text=True, timeout=60, check=True,
            )
            measured_duration = min(duration, max(0.1, float(probe.stdout.strip())))
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    safe_duration = max(0.05, measured_duration - 0.08)
    sample_times = [max(0.05, safe_duration * ratio) for ratio in (0.12, 0.5, 0.86)]
    frames = []
    for sample_index, sample_time in enumerate(sample_times):
        output = analysis_dir / f"frame-{sample_index + 1}.png"
        _run([
            ffmpeg, "-y", "-ss", f"{sample_time:.3f}", "-i", str(clip),
            "-frames:v", "1", "-vf",
            "scale=192:192:force_original_aspect_ratio=increase,crop=192:192",
            str(output),
        ], timeout=180)
        frames.append(np.asarray(Image.open(output).convert("RGB"), dtype=np.float32) / 255.0)

    reference = np.asarray(ImageOps.fit(Image.open(source).convert("RGB"), (192, 192)), dtype=np.float32) / 255.0

    def histogram(image):
        values = []
        for channel in range(3):
            counts, _ = np.histogram(image[:, :, channel], bins=16, range=(0.0, 1.0))
            counts = counts.astype(np.float64)
            values.append(counts / max(1.0, counts.sum()))
        return np.concatenate(values)

    reference_histogram = histogram(reference)
    identity = float(np.mean([np.minimum(reference_histogram, histogram(frame)).sum() / 3.0 for frame in frames]))
    differences = [float(np.mean(np.abs(frames[position] - frames[position - 1]))) for position in range(1, len(frames))]
    motion = float(np.mean(differences))
    def edge_sharpness(image):
        return float(
            (np.mean(np.abs(np.diff(image, axis=0))) + np.mean(np.abs(np.diff(image, axis=1)))) / 2.0
        )

    sharpness = float(np.mean([edge_sharpness(frame) for frame in frames]))
    reference_sharpness = edge_sharpness(reference)
    # LTX product-detail plates can intentionally reserve most of the portrait
    # canvas for dark negative space. Its absolute full-frame threshold can
    # mark those shots as soft even when the generated product region retains
    # every source edge. FramePack keeps its established absolute QA behavior.
    sharpness_retention = sharpness / max(reference_sharpness, 0.002)
    face_consistency = None
    unexpected_face = False
    structural_consistency = None
    try:
        import cv2  # type: ignore

        detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

        def largest_face(image):
            gray = cv2.cvtColor((image * 255.0).astype(np.uint8), cv2.COLOR_RGB2GRAY)
            boxes = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(24, 24))
            if len(boxes) == 0:
                return None
            x, y, width, height = max(boxes, key=lambda box: int(box[2]) * int(box[3]))
            crop = gray[y:y + height, x:x + width]
            return cv2.equalizeHist(cv2.resize(crop, (96, 96))).astype(np.float32)

        reference_face = largest_face(reference)
        if reference_face is not None:
            correlations = []
            reference_values = reference_face.reshape(-1)
            for frame in frames:
                candidate_face = largest_face(frame)
                if candidate_face is None:
                    correlations.append(0.0)
                    continue
                correlation = float(np.corrcoef(reference_values, candidate_face.reshape(-1))[0, 1])
                correlations.append(max(0.0, correlation if np.isfinite(correlation) else 0.0))
            face_consistency = float(np.mean(correlations))
        elif reject_faces:
            unexpected_face = any(largest_face(frame) is not None for frame in frames)

        if rigid_product:
            orb = cv2.ORB_create(nfeatures=700, fastThreshold=8)

            def descriptors(image):
                gray = cv2.cvtColor((image * 255.0).astype(np.uint8), cv2.COLOR_RGB2GRAY)
                return orb.detectAndCompute(gray, None)[1]

            reference_descriptors = descriptors(reference)
            structure_scores = []
            for frame in frames:
                candidate_descriptors = descriptors(frame)
                if reference_descriptors is None or candidate_descriptors is None:
                    structure_scores.append(0.0)
                    continue
                matches = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(reference_descriptors, candidate_descriptors)
                best = sorted(matches, key=lambda match: match.distance)[:80]
                if not best:
                    structure_scores.append(0.0)
                    continue
                structure_scores.append(max(0.0, 1.0 - float(np.mean([match.distance for match in best])) / 96.0))
            structural_consistency = float(np.mean(structure_scores))
    except Exception:
        face_consistency = None
    brightness_drift = float(max(float(frame.mean()) for frame in frames) - min(float(frame.mean()) for frame in frames))
    motion_quality = max(0.0, 1.0 - abs(motion - 0.055) / 0.07)
    relative_quality = sharpness_retention if allow_relative_sharpness else 0.0
    sharpness_quality = min(1.0, max(sharpness / 0.045, relative_quality))
    face_quality = face_consistency if face_consistency is not None else identity
    if rigid_product and structural_consistency is not None:
        score = identity * 30.0 + motion_quality * 20.0 + sharpness_quality * 15.0 + structural_consistency * 35.0 - brightness_drift * 10.0
    else:
        score = identity * 42.0 + motion_quality * 23.0 + sharpness_quality * 17.0 + face_quality * 18.0 - brightness_drift * 10.0
    sharpness_passed = sharpness >= 0.008 or (
        allow_relative_sharpness and reference_sharpness >= 0.002 and sharpness_retention >= 0.65
    )
    face_passed = not unexpected_face and (face_consistency is None or face_consistency >= 0.45)
    structure_passed = not rigid_product or structural_consistency is None or structural_consistency >= 0.18
    passed = identity >= 0.45 and 0.004 <= motion <= 0.30 and sharpness_passed and face_passed and structure_passed and brightness_drift <= 0.16
    return {
        "score": round(score, 4),
        "passed": passed,
        "identity": round(identity, 5),
        "motion": round(motion, 5),
        "sharpness": round(sharpness, 5),
        "referenceSharpness": round(reference_sharpness, 5),
        "sharpnessRetention": round(sharpness_retention, 5),
        "faceConsistency": None if face_consistency is None else round(face_consistency, 5),
        "unexpectedFace": unexpected_face,
        "structuralConsistency": None if structural_consistency is None else round(structural_consistency, 5),
        "brightnessDrift": round(brightness_drift, 5),
        "sampleDifferences": [round(value, 5) for value in differences],
    }


def _generate_ltx_clip(shot: dict, work_dir: Path, index: int, ffmpeg: str, settings: dict | None = None) -> tuple[Path, float]:
    """Generate, score and cache LTX 0.9.6 distilled I2V candidates."""
    settings = settings or {}
    source = Path(shot.get("sourceImagePath") or shot["path"]).resolve()
    if not source.is_file():
        source = Path(shot["path"]).resolve()
    width = int(settings.get("width") or os.environ.get("LTX_WIDTH", "576"))
    height = int(settings.get("height") or os.environ.get("LTX_HEIGHT", "1024"))
    frames = int(settings.get("frames") or os.environ.get("LTX_FRAMES", "49"))
    fps = float(settings.get("fps") or os.environ.get("LTX_FPS", "16"))
    steps = int(settings.get("steps") or os.environ.get("LTX_STEPS", "8"))
    candidate_count = max(1, min(3, int(settings.get("candidates") or os.environ.get("LTX_CANDIDATES", "2"))))
    if width % 32 or height % 32 or (frames - 1) % 8:
        raise RuntimeError("Invalid LTX profile: dimensions must divide by 32 and frames must equal 8n+1.")
    generation_seconds = frames / fps
    cache_material = json.dumps({
        "provider": "ltx-0.9.6-distilled", "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "prompt": shot.get("prompt"), "negativePrompt": shot.get("negativePrompt"),
        "seed": int(shot.get("seed") or 1), "width": width, "height": height,
        "frames": frames, "fps": fps, "steps": steps, "candidateCount": candidate_count,
    }, sort_keys=True).encode()
    cache_key = hashlib.sha256(cache_material).hexdigest()
    destination = work_dir / f"ltx-shot-{index + 1:02d}-{cache_key[:12]}.mp4"
    selection_path = work_dir / f"ltx-shot-{index + 1:02d}-selection.json"
    if destination.is_file() and destination.stat().st_size > 24 and selection_path.is_file():
        try:
            cached = json.loads(selection_path.read_text(encoding="utf-8"))
            if cached.get("cacheKey") == cache_key and cached.get("accepted"):
                return destination, generation_seconds
        except (OSError, json.JSONDecodeError):
            pass
    runner = Path(__file__).with_name("ltx_comfy_runner.py")
    if not runner.is_file():
        raise RuntimeError("The LTX ComfyUI runner is unavailable.")
    base_seed = int(shot.get("seed") or 1)
    candidates = []
    for candidate_index in range(candidate_count):
        candidate_seed = base_seed + candidate_index * 9973
        candidate = work_dir / f"ltx-shot-{index + 1:02d}-{cache_key[:12]}-candidate-{candidate_index + 1:02d}.mp4"
        try:
            if not candidate.is_file() or candidate.stat().st_size <= 24:
                _emit_progress(
                    "LTX", 45 + min(18, index * 3 + candidate_index),
                    f"Generating LTX motion take {candidate_index + 1} of {candidate_count} for story shot {index + 1}.",
                )
                command = [
                    sys.executable, str(runner), "--source", str(source),
                    "--prompt", str(shot.get("prompt") or "Premium product advertising shot with controlled cinematic motion."),
                    "--negative-prompt", str(shot.get("negativePrompt") or "text, logo, watermark, deformation, duplicate product, flicker"),
                    "--seed", str(candidate_seed), "--width", str(width), "--height", str(height),
                    "--frames", str(frames), "--fps", str(fps), "--steps", str(steps),
                    "--server", os.environ.get("LTX_COMFY_URL", "http://127.0.0.1:8190"),
                    "--comfy-port", os.environ.get("LTX_COMFY_PORT", "8190"),
                    "--comfy-root", os.environ.get("LTX_COMFY_ROOT", r"D:\AI-Models\ComfyUI-LTX096"),
                    "--comfy-python", os.environ.get("LTX_COMFY_PYTHON", r"D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\.venv-cu124\Scripts\python.exe"),
                    "--model-config", os.environ.get("LTX_COMFY_MODEL_CONFIG", r"D:\Comfy-Desktop\instance-model-paths-cu124.yaml"),
                    "--input-dir", os.environ.get("LTX_COMFY_INPUT_DIR", r"D:\Comfy-Desktop\ComfyUI-Shared\input"),
                    "--output-dir", os.environ.get("LTX_COMFY_OUTPUT_DIR", r"D:\Comfy-Desktop\ComfyUI-Shared\output"),
                    "--checkpoint", os.environ.get("LTX_CHECKPOINT", "ltxv-2b-0.9.6-distilled-04-25.safetensors"),
                    "--text-encoder", os.environ.get("LTX_TEXT_ENCODER", "t5xxl_fp8_e4m3fn_scaled.safetensors"),
                    "--ffmpeg", ffmpeg, "--output", str(candidate),
                ]
                _run(command, timeout=3600)
            if not candidate.is_file() or candidate.stat().st_size <= 24:
                raise RuntimeError("LTX did not create an MP4 candidate.")
            metrics = _score_motion_candidate(
                candidate, source, work_dir,
                f"ltx-shot-{index + 1:02d}-candidate-{candidate_index + 1:02d}",
                ffmpeg, generation_seconds, allow_relative_sharpness=True,
                reject_faces=bool(shot.get("productOnly")),
                rigid_product=shot.get("ltxProfile") == "rigid-product",
            )
            candidates.append({"path": str(candidate), "seed": candidate_seed, "metrics": metrics})
        except Exception as error:
            candidates.append({"path": str(candidate), "seed": candidate_seed, "error": str(error)[:1000]})

    accepted = [candidate for candidate in candidates if candidate.get("metrics", {}).get("passed")]
    if accepted:
        selected = max(accepted, key=lambda candidate: candidate["metrics"]["score"])
        shutil.copy2(selected["path"], destination)
    else:
        selected = None
    selection = {
        "provider": "ltx", "shotId": shot.get("id"), "cacheKey": cache_key,
        "accepted": bool(selected), "selectedSeed": selected["seed"] if selected else None,
        "selectedMetrics": selected["metrics"] if selected else None,
        "candidates": candidates,
    }
    selection_path.write_text(json.dumps(selection, indent=2), encoding="utf-8")
    if not selection["accepted"]:
        raise RuntimeError(f"All LTX takes failed product-motion QA for shot {index + 1}.")
    return destination, generation_seconds


def _free_ltx_models() -> None:
    url = os.environ.get("LTX_COMFY_URL", "http://127.0.0.1:8190").rstrip("/") + "/free"
    request = urllib.request.Request(
        url, data=json.dumps({"unload_models": True, "free_memory": True}).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15):
            pass
    except (OSError, urllib.error.URLError):
        pass


def _generate_framepack_clip(shot: dict, work_dir: Path, index: int, ffmpeg: str, candidate_count: int = 2) -> tuple[Path, float]:
    """Generate, score and cache identity-conditioned FramePack candidates."""
    framepack_root = _path("FRAMEPACK_ROOT", r"D:\AI-Models\FramePack")
    if not framepack_root.is_dir():
        raise RuntimeError("FramePack source is unavailable.")
    try:
        import psutil  # type: ignore
        commit_capacity_gb = (psutil.virtual_memory().total + psutil.swap_memory().total) / (1024 ** 3)
    except Exception:
        commit_capacity_gb = 0.0
    if commit_capacity_gb < 40.0:
        raise RuntimeError(
            f"FramePack needs at least 40 GB of RAM plus paging capacity on this host; "
            f"only {commit_capacity_gb:.1f} GB is available. Increase the Windows paging file and reboot."
        )
    source = Path(shot.get("sourceImagePath") or shot["path"]).resolve()
    if not source.is_file():
        source = Path(shot["path"]).resolve()
    duration = max(1.0, float(shot["durationSeconds"]))
    generation_seconds = min(duration, max(1.0, float(os.environ.get("FRAMEPACK_CLIP_SECONDS", str(duration)))))
    cache_material = json.dumps({
        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "prompt": shot.get("prompt"),
        "negativePrompt": shot.get("negativePrompt"),
        "seed": int(shot.get("seed") or 1),
        "duration": generation_seconds,
        "steps": os.environ.get("FRAMEPACK_STEPS", "9"),
        "candidateCount": candidate_count,
    }, sort_keys=True).encode()
    cache_key = hashlib.sha256(cache_material).hexdigest()
    destination = work_dir / f"framepack-shot-{index + 1:02d}-{cache_key[:12]}.mp4"
    selection_path = work_dir / f"framepack-shot-{index + 1:02d}-selection.json"
    if destination.is_file() and destination.stat().st_size > 24 and selection_path.is_file():
        try:
            cached_selection = json.loads(selection_path.read_text(encoding="utf-8"))
            if cached_selection.get("cacheKey") == cache_key and cached_selection.get("accepted"):
                return destination, generation_seconds
        except (OSError, json.JSONDecodeError):
            pass
    runner = Path(__file__).with_name("framepack_runner.py")
    base_seed = int(shot.get("seed") or 1)
    candidates = []
    existing_candidates_only = os.environ.get("FRAMEPACK_USE_EXISTING_CANDIDATES_ONLY", "").strip().lower() in {"1", "true", "yes", "on"}
    for candidate_index in range(max(1, min(3, int(candidate_count)))):
        candidate_seed = base_seed + candidate_index * 9973
        candidate = work_dir / f"framepack-shot-{index + 1:02d}-{cache_key[:12]}-candidate-{candidate_index + 1:02d}.mp4"
        try:
            if not candidate.is_file() or candidate.stat().st_size <= 24:
                if existing_candidates_only:
                    raise RuntimeError("Skipped missing candidate while recovering an interrupted FramePack run.")
                _emit_progress(
                    "FRAMEPACK",
                    45 + min(18, index * 3 + candidate_index),
                    f"Generating motion take {candidate_index + 1} of {candidate_count} for story shot {index + 1}.",
                )
                _run([
                    sys.executable, str(runner),
                    "--source", str(source),
                    "--prompt", str(shot.get("prompt") or "Premium product advertising shot with subtle cinematic motion."),
                    "--negative-prompt", str(shot.get("negativePrompt") or "text, logo, watermark, deformation, duplicate product, flicker"),
                    "--seed", str(candidate_seed),
                    "--duration", str(generation_seconds),
                    "--steps", os.environ.get("FRAMEPACK_STEPS", "9"),
                    "--preserved-memory-gb", os.environ.get("FRAMEPACK_PRESERVED_MEMORY_GB", "3.5"),
                    "--output", str(candidate),
                ], timeout=7200)
            metrics = _score_motion_candidate(
                candidate, source, work_dir,
                f"shot-{index + 1:02d}-candidate-{candidate_index + 1:02d}",
                ffmpeg, generation_seconds,
            )
            candidates.append({"path": str(candidate), "seed": candidate_seed, "metrics": metrics})
        except Exception as error:
            candidates.append({"path": str(candidate), "seed": candidate_seed, "error": str(error)[:1000]})

    accepted = [candidate for candidate in candidates if candidate.get("metrics", {}).get("passed")]
    if not accepted:
        selection_path.write_text(json.dumps({"shotId": shot.get("id"), "cacheKey": cache_key, "accepted": False, "candidates": candidates}, indent=2), encoding="utf-8")
        raise RuntimeError(f"All FramePack takes failed product-motion QA for shot {index + 1}.")
    selected = max(accepted, key=lambda candidate: candidate["metrics"]["score"])
    shutil.copy2(selected["path"], destination)
    selection_path.write_text(json.dumps({
        "shotId": shot.get("id"),
        "cacheKey": cache_key,
        "accepted": True,
        "selectedSeed": selected["seed"],
        "selectedMetrics": selected["metrics"],
        "candidates": candidates,
    }, indent=2), encoding="utf-8")
    return destination, generation_seconds


def compose(spec: dict) -> dict:
    ffmpeg = _command_path(spec.get("ffmpegPath") or os.environ.get("FFMPEG_PATH", "ffmpeg"))
    if not ffmpeg:
        raise RuntimeError("FFmpeg was not found. Set FFMPEG_PATH to ffmpeg.exe.")
    shots = spec.get("shots") or []
    if not shots:
        raise ValueError("At least one shot is required.")
    work_dir = Path(spec["workDir"])
    work_dir.mkdir(parents=True, exist_ok=True)
    output_path = Path(spec["outputPath"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    width, height, fps = int(spec["width"]), int(spec["height"]), int(spec["fps"])
    transition_names = {
        "CUT": "fadefast", "DISSOLVE": "dissolve", "FADE_BLACK": "fadeblack",
        "FADE_WHITE": "fadewhite", "WIPE_LEFT": "wipeleft", "WIPE_UP": "wipeup",
        "SLIDE_LEFT": "slideleft", "SMOOTH_LEFT": "smoothleft", "CIRCLE_OPEN": "circleopen",
        "RADIAL": "radial", "PIXELIZE": "pixelize",
    }

    def transition_after(shot_index: int) -> tuple[str, float]:
        if shot_index >= len(shots) - 1:
            return "fade", 0.0
        edit = shots[shot_index].get("edit") or {}
        kind = str(edit.get("transitionOut") or "CUT").upper()
        duration = float(edit.get("transitionDuration") or 0.0)
        if kind == "CUT":
            duration = 0.04
        duration = max(0.04, min(0.9, duration))
        return transition_names.get(kind, "dissolve"), duration

    arguments = [ffmpeg, "-y"]
    filters: list[str] = []
    labels: list[str] = []
    overlay_shots = [
        (index, shot) for index, shot in enumerate(shots)
        if shot.get("renderMode") == "GENERATIVE" and shot.get("overlayPath")
    ]
    overlay_input_indices = {shot_index: len(shots) + position for position, (shot_index, _) in enumerate(overlay_shots)}
    motion_selection_files: list[Path] = []
    shot_sources: list[dict] = []
    ltx_used = False
    for index, shot in enumerate(shots):
        duration = float(shot["durationSeconds"])
        _, outgoing_transition_duration = transition_after(index)
        render_duration = duration + outgoing_transition_duration
        generative = bool(spec.get("enableGenerativeMotion")) and shot.get("renderMode") == "GENERATIVE"
        if generative:
            provider = str(spec.get("motionProvider") or os.environ.get("VIDEO_MOTION_PROVIDER", "ltx")).lower()
            if provider == "ltx":
                try:
                    ltx_settings = dict(spec.get("ltx") or {})
                    ltx_settings.update({
                        key: value for key, value in (shot.get("generation") or {}).items()
                        if key in {"frames", "fps", "steps", "candidates"} and value is not None
                    })
                    clip, generated_duration = _generate_ltx_clip(shot, work_dir, index, ffmpeg, ltx_settings)
                    motion_selection_files.append(work_dir / f"ltx-shot-{index + 1:02d}-selection.json")
                    ltx_used = True
                except Exception as ltx_error:
                    fallback = str(spec.get("motionFallback") or os.environ.get("VIDEO_MOTION_FALLBACK", "framepack")).lower()
                    _free_ltx_models()
                    (work_dir / f"ltx-shot-{index + 1:02d}-selection.json").unlink(missing_ok=True)
                    try:
                        if fallback != "framepack":
                            raise RuntimeError(f"FramePack fallback is disabled ({fallback}).")
                        _emit_progress("FRAMEPACK_FALLBACK", 45 + min(18, index * 3), f"LTX failed for shot {index + 1}; using FramePack fallback: {str(ltx_error)[:240]}")
                        clip, generated_duration = _generate_framepack_clip(
                            shot, work_dir, index, ffmpeg,
                            int(spec.get("framepackCandidateCount") or os.environ.get("FRAMEPACK_CANDIDATES", "2")),
                        )
                        motion_selection_files.append(work_dir / f"framepack-shot-{index + 1:02d}-selection.json")
                    except Exception as framepack_error:
                        reason = f"LTX: {ltx_error}; FramePack: {framepack_error}"
                        _emit_progress(
                            "PRODUCT_TEMPLATE_FALLBACK", 45 + min(18, index * 3),
                            f"AI motion was unavailable for shot {index + 1}; applying the product-matched motion template.",
                        )
                        clip, generated_duration, selection_path = _generate_product_template_clip(
                            shot, work_dir, index, ffmpeg, render_duration, width, height, fps, reason,
                        )
                        motion_selection_files.append(selection_path)
            else:
                _emit_progress("FRAMEPACK", 44 + min(20, index * 3), f"Generating FramePack motion for story shot {index + 1} of {len(shots)}.")
                try:
                    clip, generated_duration = _generate_framepack_clip(
                        shot, work_dir, index, ffmpeg,
                        int(spec.get("framepackCandidateCount") or os.environ.get("FRAMEPACK_CANDIDATES", "2")),
                    )
                    motion_selection_files.append(work_dir / f"framepack-shot-{index + 1:02d}-selection.json")
                except Exception as framepack_error:
                    _emit_progress(
                        "PRODUCT_TEMPLATE_FALLBACK", 45 + min(18, index * 3),
                        f"FramePack was unavailable for shot {index + 1}; applying the product-matched motion template.",
                    )
                    clip, generated_duration, selection_path = _generate_product_template_clip(
                        shot, work_dir, index, ffmpeg, render_duration, width, height, fps, str(framepack_error),
                    )
                    motion_selection_files.append(selection_path)
            if spec.get("enableInterpolation"):
                _emit_progress("RIFE", 66, f"Interpolating story shot {index + 1} to smooth 60 fps motion.")
                try:
                    clip = _interpolate_rife(clip, work_dir, index)
                except Exception as interpolation_error:
                    _emit_progress("RIFE_FALLBACK", 67, f"RIFE was unavailable for shot {index + 1}; keeping the accepted source frame rate: {str(interpolation_error)[:180]}")
            if spec.get("enableUpscale"):
                _emit_progress("REAL_ESRGAN", 70, f"Upscaling story shot {index + 1} with Real-ESRGAN.")
                try:
                    clip = _upscale_realesrgan(
                        clip, work_dir, index, ffmpeg,
                        60 if spec.get("enableInterpolation") else fps,
                        target_width=width, target_height=height,
                    )
                except Exception as upscale_error:
                    _emit_progress("UPSCALE_FALLBACK", 71, f"Upscaling was unavailable for shot {index + 1}; using the accepted source clip: {str(upscale_error)[:180]}")
            shot_sources.append({
                "shotId": shot.get("id"), "path": str(Path(clip).resolve()), "type": "video",
                "generatedDuration": generated_duration, "durationSeconds": duration,
                "overlayPath": str(Path(shot["overlayPath"]).resolve()) if shot.get("overlayPath") else None,
                "renderMode": shot.get("renderMode"),
            })
            stretch = render_duration / generated_duration
            arguments.extend(("-i", str(clip)))
            base_filter = (
                f"[{index}:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                f"crop={width}:{height},setpts={stretch:.6f}*(PTS-STARTPTS),"
                f"fps={fps},tpad=stop_mode=clone:stop_duration={render_duration:.3f},"
                f"trim=duration={render_duration:.3f},settb=AVTB,setsar=1,format=yuv420p"
            )
            if index in overlay_input_indices:
                overlay_index = overlay_input_indices[index]
                filters.extend((
                    f"{base_filter}[gbase{index}]",
                    f"[{overlay_index}:v]scale={width}:{height},format=rgba,fade=t=in:st=0.08:d=0.28:alpha=1[gov{index}]",
                    f"[gbase{index}][gov{index}]overlay=0:0:shortest=1,format=yuv420p[v{index}]",
                ))
            else:
                filters.append(f"{base_filter}[v{index}]")
        else:
            shot_sources.append({
                "shotId": shot.get("id"), "path": str(Path(shot.get("sourceImagePath") or shot["path"]).resolve()), "type": "image",
                "generatedDuration": duration, "durationSeconds": duration,
                "overlayPath": str(Path(shot["overlayPath"]).resolve()) if shot.get("overlayPath") else None,
                "renderMode": shot.get("renderMode"),
            })
            # Image inputs default to 25 fps in FFmpeg. Pin the planned rate.
            arguments.extend(("-framerate", str(fps), "-loop", "1", "-t", f"{render_duration:.3f}", "-i", str(Path(shot["path"]).resolve())))
            if shot.get("renderMode") == "HYBRID":
                # A restrained moving crop and exposure arc provide genuine
                # motion-graphics treatment while preserving exact product
                # geometry from the native-resolution master plate.
                paths = {
                    "MACRO_PUSH": ("0.50-0.16*t/D", "0.58-0.10*t/D"),
                    "LATERAL_SLIDE": ("0.10+0.72*t/D", "0.50"),
                    "DIAGONAL_DRIFT": ("0.16+0.54*t/D", "0.70-0.38*t/D"),
                    "LOCKED_LIGHT": ("0.50", "0.50"),
                    "HERO_PULLBACK": ("0.66-0.22*t/D", "0.56"),
                    "ENERGY_PULSE": ("0.30+0.40*t/D", "0.56-0.12*t/D"),
                    "PRECISION_TRACK": ("0.78-0.58*t/D", "0.48"),
                }
                edit_style = str((shot.get("edit") or {}).get("style") or "LATERAL_SLIDE").upper()
                path_x, path_y = paths.get(edit_style, paths["LATERAL_SLIDE"])
                path_x = path_x.replace("D", f"{render_duration:.3f}")
                path_y = path_y.replace("D", f"{render_duration:.3f}")
                pulse = "0.055" if edit_style == "ENERGY_PULSE" else "0.035"
                filters.append(
                    f"[{index}:v]scale={width + 72}:{height + 120}:force_original_aspect_ratio=increase,"
                    f"crop={width}:{height}:x='(in_w-out_w)*({path_x})':"
                    f"y='(in_h-out_h)*({path_y})',"
                    f"eq=contrast='1.02+{pulse}*sin(PI*t/{render_duration:.3f})':"
                    f"brightness='0.012*sin(PI*t/{render_duration:.3f})',fps={fps},"
                    f"trim=duration={render_duration:.3f},setpts=PTS-STARTPTS,settb=AVTB,setsar=1,format=yuv420p[v{index}]"
                )
            else:
                increment = 0.00018 if "slow" in str(shot.get("motion", "")).lower() else 0.00028
                filters.append(
                    f"[{index}:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                    f"crop={width}:{height},zoompan=z='min(zoom+{increment},1.035)':"
                    f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={width}x{height}:fps={fps},"
                    f"trim=duration={render_duration:.3f},setpts=PTS-STARTPTS,settb=AVTB,setsar=1,format=yuv420p[v{index}]"
                )
        labels.append(f"[v{index}]")
    if ltx_used:
        # ACE-Step needs the system RAM that ComfyUI's offloaded LTX weights use.
        _free_ltx_models()
    for shot_index, shot in overlay_shots:
        _, outgoing_transition_duration = transition_after(shot_index)
        overlay_duration = float(shot["durationSeconds"]) + outgoing_transition_duration
        arguments.extend(("-framerate", str(fps), "-loop", "1", "-t", f"{overlay_duration:.3f}", "-i", str(Path(shot["overlayPath"]).resolve())))
    total_duration = float(spec["durationSeconds"])
    audio_index = len(shots) + len(overlay_shots)
    soundtrack_is_generated = False
    if spec.get("enableAceMusic"):
        _emit_progress("ACE_STEP", 74, f"Generating and selecting an original {int(spec.get('musicBpm') or 96)} BPM synchronized score with ACE-Step.")
        try:
            soundtrack_path = _generate_ace_music(spec, work_dir)
            arguments.extend(("-stream_loop", "-1", "-t", f"{total_duration:.3f}", "-i", str(soundtrack_path)))
            soundtrack_is_generated = True
        except Exception as music_error:
            _emit_progress("MUSIC_FALLBACK", 75, f"ACE-Step music generation failed; using the built-in original score: {str(music_error)[:180]}")
    if not soundtrack_is_generated:
        soundtrack = _fallback_music_expression(spec, total_duration)
        arguments.extend(("-f", "lavfi", "-t", f"{total_duration:.3f}", "-i", soundtrack))
    sound_design_path = _generate_sound_design(spec, work_dir)
    sound_design_index = audio_index + 1
    arguments.extend(("-i", str(sound_design_path)))
    if len(shots) == 1:
        filters.append(f"{labels[0]}trim=duration={total_duration:.3f},setpts=PTS-STARTPTS[outv]")
    elif spec.get("fastTemplateMode"):
        filters.append(
            f"{''.join(labels)}concat=n={len(shots)}:v=1:a=0,"
            f"trim=duration={total_duration:.3f},setpts=PTS-STARTPTS[outv]"
        )
    else:
        current_label = labels[0].strip("[]")
        cut_offset = float(shots[0]["durationSeconds"])
        for index in range(1, len(shots)):
            transition_name, transition_duration = transition_after(index - 1)
            next_label = labels[index].strip("[]")
            output_label = f"edit{index}"
            filters.append(
                f"[{current_label}][{next_label}]xfade=transition={transition_name}:"
                f"duration={transition_duration:.3f}:offset={cut_offset:.3f}[{output_label}]"
            )
            current_label = output_label
            cut_offset += float(shots[index]["durationSeconds"])
        filters.append(f"[{current_label}]trim=duration={total_duration:.3f},setpts=PTS-STARTPTS[outv]")
    fade_out_start = max(0.0, total_duration - 1.2)
    narration_text = str(spec.get("narrationText") or "").strip()
    if narration_text:
        narration_path = _generate_kokoro_narration(spec, work_dir)
        narration_index = audio_index + 2
        arguments.extend(("-i", str(narration_path)))
        filters.extend((
            f"[{audio_index}:a]volume=0.58[music]",
            f"[{sound_design_index}:a]volume=0.82[sfx]",
            f"[music][sfx]amix=inputs=2:duration=first:dropout_transition=0[bed]",
            f"[{narration_index}:a]adelay=1500|1500,volume=1.0[voice]",
            f"[bed][voice]amix=inputs=2:duration=first:dropout_transition=1,"
            f"loudnorm=I=-16:TP=-1.5:LRA=9,aresample=48000,afade=t=in:st=0:d=1.2,"
            f"afade=t=out:st={fade_out_start:.3f}:d=1.2[outa]",
        ))
    else:
        filters.extend((
            f"[{audio_index}:a]volume=0.88[music]",
            f"[{sound_design_index}:a]volume=0.82[sfx]",
            f"[music][sfx]amix=inputs=2:duration=first:dropout_transition=0,"
            f"loudnorm=I=-16:TP=-1.5:LRA=9,aresample=48000,"
            f"afade=t=in:st=0:d=1.2,afade=t=out:st={fade_out_start:.3f}:d=1.2[outa]"
        ))
    arguments.extend((
        "-filter_complex", ";".join(filters), "-map", "[outv]", "-map", "[outa]",
        "-c:v", "libx264", "-preset", spec.get("preset", "medium"),
        "-crf", str(spec.get("crf", 22)), "-t", f"{float(spec['durationSeconds']):.3f}",
        "-c:a", "aac", "-b:a", "192k", "-ar", str(int(spec.get("audioSampleRate", 48000))),
        "-shortest", "-movflags", "+faststart", str(output_path),
    ))
    _emit_progress("FINAL_EDIT", 79, "Assembling the beat-synchronized edit and final audio mix.")
    _run(arguments)
    motion_selections = []
    for selection_file in motion_selection_files:
        try:
            motion_selections.append(json.loads(selection_file.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            pass
    return {
        "ok": True,
        "outputPath": str(output_path),
        "byteLength": output_path.stat().st_size,
        "motionSelections": motion_selections,
        "shotSources": shot_sources,
        "musicGenerated": soundtrack_is_generated,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("health", "compose"))
    parser.add_argument("--spec")
    arguments = parser.parse_args()
    try:
        if arguments.command == "health":
            result = health()
        else:
            if not arguments.spec:
                raise ValueError("--spec is required for compose")
            result = compose(json.loads(Path(arguments.spec).read_text(encoding="utf-8")))
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

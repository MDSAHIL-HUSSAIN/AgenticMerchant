"""Local video worker for the Agentic product-post pipeline.

The worker deliberately has a tiny JSON-file protocol so the Node API can run it
as a disposable process. Heavy model runtimes remain isolated from the API and a
failed GPU tool cannot corrupt the persistent job queue.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
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
            "generativeMotionAvailable": tools["framepack"]["ready"],
            "interpolationAvailable": tools["rife"]["ready"],
            "upscaleAvailable": tools["realEsrgan"]["ready"],
            "musicModelAvailable": tools["aceStep"]["ready"],
            "narrationModelAvailable": tools["kokoro"]["ready"],
        },
        "activePipeline": {
            "motion": "framepack-rife-realesrgan" if tools["framepack"]["ready"] and tools["rife"]["ready"] and tools["realEsrgan"]["ready"] else "product-safe-keyframe-camera",
            "audio": "ace-step-original-music" if tools["aceStep"]["ready"] else "audible-layered-original-fallback",
            "narration": "kokoro" if tools["kokoro"]["ready"] else "disabled",
        },
    }


def _run(args: list[str], timeout: int = 3600) -> None:
    completed = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    if completed.returncode:
        tail = (completed.stderr or completed.stdout)[-2000:]
        raise RuntimeError(f"{Path(args[0]).name} exited with {completed.returncode}: {tail}")


def _emit_progress(stage: str, progress: int, message: str) -> None:
    """Emit a machine-readable progress event for the API trace."""
    print(json.dumps({"event": "progress", "stage": stage, "progress": progress, "message": message}), flush=True)


def _interpolate_rife(clip: Path, work_dir: Path, index: int) -> Path:
    """Double generated frames with the installed Practical-RIFE model."""
    rife_root = _path("RIFE_ROOT", r"D:\AI-Models\Practical-RIFE")
    script = Path(__file__).with_name("rife_runner.py")
    if not script.is_file():
        raise RuntimeError("Practical-RIFE runtime is unavailable.")
    output = work_dir / f"rife-shot-{index + 1:02d}.mp4"
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


def _upscale_realesrgan(clip: Path, work_dir: Path, index: int, ffmpeg: str, fps: int = 60) -> Path:
    """Upscale a generated shot with the installed Real-ESRGAN Vulkan runtime."""
    esrgan_root = _path("REALESRGAN_ROOT", r"D:\AI-Models\Real-ESRGAN")
    executable = next(iter(esrgan_root.glob("realesrgan-ncnn-vulkan*.exe")), None)
    if not executable:
        raise RuntimeError("Real-ESRGAN executable is unavailable.")
    input_dir = work_dir / f"esrgan-in-{index + 1:02d}"
    output_dir = work_dir / f"esrgan-out-{index + 1:02d}"
    shutil.rmtree(input_dir, ignore_errors=True)
    shutil.rmtree(output_dir, ignore_errors=True)
    input_dir.mkdir(parents=True)
    output_dir.mkdir(parents=True)
    _run([
        ffmpeg, "-y", "-i", str(clip),
        "-vf", "scale=270:480:force_original_aspect_ratio=increase,crop=270:480",
        str(input_dir / "frame%08d.png"),
    ])
    _run([
        str(executable),
        "-i", str(input_dir),
        "-o", str(output_dir),
        "-n", "realesrgan-x4plus",
        # x4plus is a native 4x model. Requesting 2x caused NCNN to assemble
        # independently scaled tiles as quadrants on this GPU.
        "-s", "4",
        "-t", "256",
        "-f", "png",
    ])
    output = work_dir / f"esrgan-shot-{index + 1:02d}.mp4"
    _run([
        ffmpeg, "-y", "-framerate", str(fps), "-i", str(output_dir / "frame%08d.png"),
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p", str(output),
    ])
    if not output.is_file():
        raise RuntimeError(f"Real-ESRGAN did not produce shot {index + 1}.")
    return output


def _generate_ace_music(spec: dict, work_dir: Path) -> Path:
    """Generate one original beat-locked instrumental with ACE-Step."""
    ace_python = _path("ACESTEP_PYTHON", r"D:\AI-Models\runtimes\acestep-py311\Scripts\python.exe")
    script = Path(__file__).with_name("ace_music.py")
    if not ace_python.is_file() or not script.is_file():
        raise RuntimeError("ACE-Step music runtime is unavailable.")
    output = work_dir / "ace-step-soundtrack.wav"
    _run([
        str(ace_python), str(script),
        "--prompt", str(spec.get("musicPrompt") or "Minimal cinematic electronic instrumental, tactile percussion, no vocals."),
        "--duration", str(spec["durationSeconds"]),
        "--bpm", str(spec.get("musicBpm") or 120),
        "--seed", str(spec.get("musicSeed") or 20261029),
        "--output", str(output),
    ], timeout=7200)
    if not output.is_file():
        raise RuntimeError("ACE-Step reported success but produced no soundtrack.")
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


def _generate_framepack_clip(shot: dict, work_dir: Path, index: int) -> tuple[Path, float]:
    """Generate one identity-conditioned motion shot with the local FramePack runtime."""
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
    generation_seconds = min(duration, max(1.0, float(os.environ.get("FRAMEPACK_CLIP_SECONDS", "1.0"))))
    destination = work_dir / f"framepack-shot-{index + 1:02d}.mp4"
    runner = Path(__file__).with_name("framepack_runner.py")
    _run([
        sys.executable, str(runner),
        "--source", str(source),
        "--prompt", str(shot.get("prompt") or "Premium product advertising shot with subtle cinematic motion."),
        "--negative-prompt", str(shot.get("negativePrompt") or "text, logo, watermark, deformation, duplicate product, flicker"),
        "--seed", str(int(shot.get("seed") or 1)),
        "--duration", str(generation_seconds),
        "--steps", os.environ.get("FRAMEPACK_STEPS", "9"),
        "--preserved-memory-gb", os.environ.get("FRAMEPACK_PRESERVED_MEMORY_GB", "3.5"),
        "--output", str(destination),
    ], timeout=7200)
    if not destination.is_file():
        raise RuntimeError(f"FramePack did not produce a video for shot {index + 1}.")
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
    arguments = [ffmpeg, "-y"]
    filters: list[str] = []
    labels: list[str] = []
    for index, shot in enumerate(shots):
        duration = float(shot["durationSeconds"])
        generative = bool(spec.get("enableGenerativeMotion")) and shot.get("renderMode") == "GENERATIVE"
        if generative:
            _emit_progress("FRAMEPACK", 44 + min(20, index * 3), f"Generating real motion for story shot {index + 1} of {len(shots)}.")
            clip, generated_duration = _generate_framepack_clip(shot, work_dir, index)
            if spec.get("enableInterpolation"):
                _emit_progress("RIFE", 66, f"Interpolating story shot {index + 1} to smooth 60 fps motion.")
                clip = _interpolate_rife(clip, work_dir, index)
            if spec.get("enableUpscale"):
                _emit_progress("REAL_ESRGAN", 70, f"Upscaling story shot {index + 1} with Real-ESRGAN.")
                clip = _upscale_realesrgan(clip, work_dir, index, ffmpeg, 60 if spec.get("enableInterpolation") else fps)
            stretch = duration / generated_duration
            arguments.extend(("-i", str(clip)))
            filters.append(
                f"[{index}:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                f"crop={width}:{height},setpts={stretch:.6f}*(PTS-STARTPTS),"
                f"fps={fps},tpad=stop_mode=clone:stop_duration={duration:.3f},"
                f"trim=duration={duration:.3f},format=yuv420p[v{index}]"
            )
        else:
            # Image inputs default to 25 fps in FFmpeg. Pin the planned rate.
            arguments.extend(("-framerate", str(fps), "-loop", "1", "-t", f"{duration:.3f}", "-i", str(Path(shot["path"]).resolve())))
            increment = 0.00035 if "slow" in str(shot.get("motion", "")).lower() else 0.00055
            filters.append(
                f"[{index}:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                f"crop={width}:{height},zoompan=z='min(zoom+{increment},1.075)':"
                f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={width}x{height}:fps={fps},"
                f"trim=duration={duration:.3f},setpts=PTS-STARTPTS,format=yuv420p[v{index}]"
            )
        labels.append(f"[v{index}]")
    total_duration = float(spec["durationSeconds"])
    audio_index = len(shots)
    if spec.get("enableAceMusic"):
        _emit_progress("ACE_STEP", 74, "Generating an original 120 BPM synchronized score with ACE-Step.")
        soundtrack_path = _generate_ace_music(spec, work_dir)
        arguments.extend(("-stream_loop", "-1", "-t", f"{total_duration:.3f}", "-i", str(soundtrack_path)))
    else:
        soundtrack = (
            "aevalsrc=exprs="
            "0.10*sin(2*PI*110*t)*(0.65+0.35*sin(2*PI*0.22*t))"
            "+0.045*sin(2*PI*220*t)"
            "+0.025*sin(2*PI*330*t)*(0.5+0.5*sin(2*PI*0.9*t))"
            f":s=48000:d={total_duration:.3f}"
        )
        arguments.extend(("-f", "lavfi", "-t", f"{total_duration:.3f}", "-i", soundtrack))
    filters.append(f"{''.join(labels)}concat=n={len(shots)}:v=1:a=0[outv]")
    fade_out_start = max(0.0, total_duration - 1.2)
    narration_text = str(spec.get("narrationText") or "").strip()
    if narration_text:
        narration_path = _generate_kokoro_narration(spec, work_dir)
        narration_index = audio_index + 1
        arguments.extend(("-i", str(narration_path)))
        filters.extend((
            f"[{audio_index}:a]volume=0.58[music]",
            f"[{narration_index}:a]adelay=1500|1500,volume=1.0[voice]",
            f"[music][voice]amix=inputs=2:duration=first:dropout_transition=1,"
            f"loudnorm=I=-16:TP=-1.5:LRA=9,afade=t=in:st=0:d=1.2,"
            f"afade=t=out:st={fade_out_start:.3f}:d=1.2[outa]",
        ))
    else:
        filters.append(
            f"[{audio_index}:a]loudnorm=I=-16:TP=-1.5:LRA=9,"
            f"afade=t=in:st=0:d=1.2,afade=t=out:st={fade_out_start:.3f}:d=1.2[outa]"
        )
    arguments.extend((
        "-filter_complex", ";".join(filters), "-map", "[outv]", "-map", "[outa]",
        "-c:v", "libx264", "-preset", spec.get("preset", "medium"),
        "-crf", str(spec.get("crf", 22)), "-t", f"{float(spec['durationSeconds']):.3f}",
        "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", str(output_path),
    ))
    _emit_progress("FINAL_EDIT", 79, "Assembling the beat-synchronized edit and final audio mix.")
    _run(arguments)
    return {"ok": True, "outputPath": str(output_path), "byteLength": output_path.stat().st_size}


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

"""Headless LTX-Video 0.9.6 image-to-video runner for ComfyUI.

The runner targets ComfyUI v0.3.30 core nodes so it can use the distilled 2B
checkpoint on CUDA 12.4 without making the Agentic worker depend on ComfyUI's
Python environment. It submits a workflow over the local HTTP API, waits for
the decoded frame sequence, and encodes it as an MP4 with FFmpeg.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path


def _json_request(url: str, payload: dict | None = None, timeout: int = 30) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
        method="POST" if data is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _ensure_server(args: argparse.Namespace) -> None:
    try:
        _json_request(f"{args.server}/system_stats", timeout=5)
        return
    except (OSError, urllib.error.URLError):
        pass
    comfy_root = Path(args.comfy_root).resolve()
    comfy_python = Path(args.comfy_python).resolve()
    model_config = Path(args.model_config).resolve()
    if not (comfy_root / "main.py").is_file() or not comfy_python.is_file() or not model_config.is_file():
        raise RuntimeError("The compatible LTX ComfyUI runtime is not installed.")
    log_dir = comfy_root / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    command = [
        str(comfy_python), "-s", "main.py", "--listen", "127.0.0.1", "--port", str(args.comfy_port),
        "--lowvram", "--disable-auto-launch", "--extra-model-paths-config", str(model_config),
        "--input-directory", str(Path(args.input_dir).resolve()),
        "--output-directory", str(Path(args.output_dir).resolve()),
    ]
    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW
    with (log_dir / "server.stdout.log").open("ab") as stdout, (log_dir / "server.stderr.log").open("ab") as stderr:
        subprocess.Popen(
            command, cwd=str(comfy_root), stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
            creationflags=creationflags, close_fds=True,
        )
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            _json_request(f"{args.server}/system_stats", timeout=5)
            return
        except (OSError, urllib.error.URLError):
            time.sleep(2)
    raise RuntimeError("The LTX ComfyUI server did not become ready within 120 seconds.")


def _workflow(args: argparse.Namespace, input_name: str, prefix: str) -> dict:
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": args.checkpoint}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": args.text_encoder, "type": "ltxv", "device": "cpu"}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": args.prompt, "clip": ["2", 0]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": args.negative_prompt, "clip": ["2", 0]}},
        "5": {"class_type": "LoadImage", "inputs": {"image": input_name}},
        "6": {
            "class_type": "LTXVImgToVideo",
            "inputs": {
                "positive": ["3", 0], "negative": ["4", 0], "vae": ["1", 2], "image": ["5", 0],
                "width": args.width, "height": args.height, "length": args.frames, "batch_size": 1,
            },
        },
        "7": {"class_type": "LTXVConditioning", "inputs": {"positive": ["6", 0], "negative": ["6", 1], "frame_rate": args.fps}},
        "8": {"class_type": "ModelSamplingLTXV", "inputs": {"model": ["1", 0], "max_shift": 2.05, "base_shift": 0.95, "latent": ["6", 2]}},
        "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": args.seed}},
        "10": {"class_type": "BasicGuider", "inputs": {"model": ["8", 0], "conditioning": ["7", 0]}},
        "11": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "12": {
            "class_type": "LTXVScheduler",
            "inputs": {
                "steps": args.steps, "max_shift": 2.05, "base_shift": 0.95,
                "stretch": True, "terminal": 0.1, "latent": ["6", 2],
            },
        },
        "13": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {"noise": ["9", 0], "guider": ["10", 0], "sampler": ["11", 0], "sigmas": ["12", 0], "latent_image": ["6", 2]},
        },
        "14": {
            "class_type": "VAEDecodeTiled",
            "inputs": {"samples": ["13", 1], "vae": ["1", 2], "tile_size": 256, "overlap": 64, "temporal_size": 16, "temporal_overlap": 4},
        },
        "15": {"class_type": "SaveImage", "inputs": {"images": ["14", 0], "filename_prefix": prefix}},
    }


def _wait_for_frames(server: str, prompt_id: str, timeout_seconds: int) -> list[dict]:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        history = _json_request(f"{server}/history/{prompt_id}", timeout=30)
        entry = history.get(prompt_id)
        if entry:
            status = entry.get("status") or {}
            if status.get("status_str") == "error" or status.get("completed") is False and status.get("messages"):
                errors = [message for kind, message in status.get("messages", []) if kind == "execution_error"]
                if errors:
                    raise RuntimeError(f"ComfyUI LTX execution failed: {errors[-1]}")
            images = ((entry.get("outputs") or {}).get("15") or {}).get("images") or []
            if images:
                return images
        time.sleep(2)
    raise TimeoutError(f"ComfyUI LTX generation exceeded {timeout_seconds} seconds.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--negative-prompt", default="text, logo, watermark, deformation, duplicate product, flicker")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--width", type=int, default=576)
    parser.add_argument("--height", type=int, default=1024)
    parser.add_argument("--frames", type=int, default=49)
    parser.add_argument("--fps", type=float, default=16.0)
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--server", default="http://127.0.0.1:8190")
    parser.add_argument("--comfy-port", type=int, default=8190)
    parser.add_argument("--comfy-root", default=r"D:\AI-Models\ComfyUI-LTX096")
    parser.add_argument("--comfy-python", default=r"D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\.venv-cu124\Scripts\python.exe")
    parser.add_argument("--model-config", default=r"D:\Comfy-Desktop\instance-model-paths-cu124.yaml")
    parser.add_argument("--input-dir", default=r"D:\Comfy-Desktop\ComfyUI-Shared\input")
    parser.add_argument("--output-dir", default=r"D:\Comfy-Desktop\ComfyUI-Shared\output")
    parser.add_argument("--checkpoint", default="ltxv-2b-0.9.6-distilled-04-25.safetensors")
    parser.add_argument("--text-encoder", default="t5xxl_fp8_e4m3fn_scaled.safetensors")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--timeout", type=int, default=3600)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    if args.width % 32 or args.height % 32:
        raise ValueError("LTX width and height must be divisible by 32.")
    if (args.frames - 1) % 8:
        raise ValueError("LTX frame count must be divisible by 8 plus 1.")

    _ensure_server(args)
    source = Path(args.source).resolve()
    input_dir = Path(args.input_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    destination = Path(args.output).resolve()
    input_dir.mkdir(parents=True, exist_ok=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex
    input_name = f"agentic-ltx-{run_id}{source.suffix.lower()}"
    copied_input = input_dir / input_name
    prefix = f"agentic-ltx/{run_id}"
    shutil.copy2(source, copied_input)
    started = time.monotonic()
    try:
        queued = _json_request(f"{args.server}/prompt", {"prompt": _workflow(args, input_name, prefix)}, timeout=30)
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI rejected the LTX workflow: {queued}")
        images = _wait_for_frames(args.server, prompt_id, args.timeout)
        sequence_dir = destination.parent / f".{destination.stem}-{run_id}-frames"
        sequence_dir.mkdir(parents=True, exist_ok=True)
        for index, image in enumerate(images):
            frame = output_dir / str(image.get("subfolder") or "") / image["filename"]
            shutil.copy2(frame, sequence_dir / f"frame-{index:05d}.png")
        subprocess.run([
            args.ffmpeg, "-y", "-framerate", str(args.fps), "-i", str(sequence_dir / "frame-%05d.png"),
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", str(destination),
        ], check=True, capture_output=True, timeout=600)
        shutil.rmtree(sequence_dir, ignore_errors=True)
        print(json.dumps({
            "ok": True, "output": str(destination), "frames": len(images), "fps": args.fps,
            "durationSeconds": len(images) / args.fps, "elapsedSeconds": round(time.monotonic() - started, 2),
            "promptId": prompt_id,
        }))
    finally:
        copied_input.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, TimeoutError, urllib.error.URLError) as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        raise SystemExit(1)

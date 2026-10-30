# Local video worker

The worker generates and scores per-shot LTX or FramePack footage, prepares synchronized original audio, and returns an editable `shotSources` manifest to the API. The API can pass those accepted sources to the Remotion editor while retaining the worker's FFmpeg master as a recoverable fallback and audio bed.

This process isolates local media and GPU tools from the Node API. It supports a
stable JSON-file protocol and a readiness report that distinguishes downloaded
weights from an executable runtime.

```powershell
py -3.11 worker.py health
py -3.11 worker.py compose --spec path\to\compose.json
```

The deterministic FFmpeg compositor is always available when `FFMPEG_PATH` is
configured. LTX-Video is the primary motion backend and runs through the
compatible ComfyUI v0.3.30 low-VRAM service on port 8190. FramePack is retained
as a fallback. The director may assign a different valid LTX frame count, FPS
and candidate count to every generative shot; the compositor then applies the
planned editorial motion and overlapping transition grammar. FramePack and RIFE additionally require a CUDA-enabled PyTorch
environment; RIFE also requires pretrained weights in its `train_log` folder.

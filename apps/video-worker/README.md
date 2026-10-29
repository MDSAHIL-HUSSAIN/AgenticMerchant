# Local video worker

This process isolates local media and GPU tools from the Node API. It supports a
stable JSON-file protocol and a readiness report that distinguishes downloaded
weights from an executable runtime.

```powershell
py -3.11 worker.py health
py -3.11 worker.py compose --spec path\to\compose.json
```

The deterministic FFmpeg compositor is always available when `FFMPEG_PATH` is
configured. FramePack and RIFE additionally require a CUDA-enabled PyTorch
environment; RIFE also requires pretrained weights in its `train_log` folder.

import sys

from faster_whisper import WhisperModel


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: transcribe.py <audio-file> [model]")
    audio_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "small"
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(audio_path, beam_size=3, vad_filter=True)
    print(" ".join(segment.text.strip() for segment in segments).strip())


if __name__ == "__main__":
    main()

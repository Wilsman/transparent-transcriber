from __future__ import annotations

import argparse
import base64
import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SAMPLE_RATE = 16_000
CHANNELS = 1
SAMPLE_WIDTH_BYTES = 2
TRANSLATION_MIN_PROBABILITY = 0.55


@dataclass(frozen=True)
class Settings:
    mode: str
    model: str
    device: str
    compute_type: str
    chunk_seconds: int
    url: str | None
    quality: str
    max_chunks: int | None


class StreamUnavailable(RuntimeError):
    pass


class WorkerError(RuntimeError):
    pass


def emit(event: dict[str, Any]) -> None:
    print(json.dumps(event, ensure_ascii=True), flush=True)


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def require_command(name: str) -> str:
    if name == "ffmpeg":
        ffmpeg_path = os.environ.get("FFMPEG_PATH")
        if ffmpeg_path and Path(ffmpeg_path).exists():
            return ffmpeg_path

    command = shutil.which(name)
    if not command:
        scripts_dir = Path(sys.executable).resolve().parent
        candidate = scripts_dir / f"{name}.exe"
        if candidate.exists():
            command = str(candidate)
    if not command:
        raise RuntimeError(f"Missing required command: {name}")
    return command


def configure_nvidia_dll_path() -> None:
    root = Path(sys.executable).resolve().parent
    nvidia_root = os.environ.get("NVIDIA_DLL_ROOT")
    candidates = [
        *((
            Path(nvidia_root) / "cublas" / "bin",
            Path(nvidia_root) / "cudnn" / "bin",
            Path(nvidia_root) / "cuda_nvrtc" / "bin",
        ) if nvidia_root else ()),
        root / "Lib" / "site-packages" / "nvidia" / "cublas" / "bin",
        root / "Lib" / "site-packages" / "nvidia" / "cudnn" / "bin",
        root / "Lib" / "site-packages" / "nvidia" / "cuda_nvrtc" / "bin",
        Path.cwd() / ".venv" / "Lib" / "site-packages" / "nvidia" / "cublas" / "bin",
        Path.cwd() / ".venv" / "Lib" / "site-packages" / "nvidia" / "cudnn" / "bin",
        Path.cwd() / ".venv" / "Lib" / "site-packages" / "nvidia" / "cuda_nvrtc" / "bin",
    ]

    existing = [str(path) for path in candidates if path.exists()]
    if not existing:
        return

    os.environ["PATH"] = os.pathsep.join(existing + [os.environ.get("PATH", "")])
    add_dll_directory = getattr(os, "add_dll_directory", None)
    if add_dll_directory:
        for path in existing:
            add_dll_directory(path)


def looks_like_cuda_failure(error: BaseException) -> bool:
    text = str(error).lower()
    return any(
        marker in text
        for marker in (
            "cublas",
            "cudnn",
            "cuda",
            "cuda not found",
            "cannot be loaded",
        )
    )


def import_whisper_model():
    try:
        from faster_whisper import WhisperModel

        return WhisperModel
    except Exception as error:
        raise RuntimeError(
            "faster-whisper is not installed. Run `python -m pip install -r requirements.txt`."
        ) from error


def load_model(settings: Settings):
    configure_nvidia_dll_path()
    WhisperModel = import_whisper_model()

    emit(
        {
            "type": "status",
            "status": "loading_model",
            "message": f"Loading {settings.model} on {settings.device}/{settings.compute_type}...",
            "model": settings.model,
            "device": settings.device,
            "computeType": settings.compute_type,
        }
    )

    try:
        model = WhisperModel(settings.model, device=settings.device, compute_type=settings.compute_type)
        emit({"type": "status", "status": "model_ready", "message": "Model ready"})
        return model
    except Exception as error:
        if settings.device == "cuda" and looks_like_cuda_failure(error):
            emit(
                {
                    "type": "status",
                    "status": "cuda_fallback",
                    "message": "CUDA unavailable, falling back to CPU/int8",
                }
            )
            model = WhisperModel(settings.model, device="cpu", compute_type="int8")
            emit({"type": "status", "status": "model_ready", "message": "Model ready on CPU"})
            return model
        raise


def load_cpu_fallback_model(settings: Settings):
    WhisperModel = import_whisper_model()
    emit(
        {
            "type": "status",
            "status": "cuda_fallback",
            "message": "CUDA failed during transcription, falling back to CPU/int8",
        }
    )
    model = WhisperModel(settings.model, device="cpu", compute_type="int8")
    emit({"type": "status", "status": "model_ready", "message": "Model ready on CPU"})
    return model


def pcm_to_float32(raw_audio: bytes):
    import numpy as np

    samples = np.frombuffer(raw_audio, dtype=np.int16)
    if samples.size == 0:
        return np.array([], dtype=np.float32)
    return samples.astype(np.float32) / 32768.0


def transcribe_pcm(model: Any, raw_audio: bytes) -> dict[str, Any] | None:
    audio = pcm_to_float32(raw_audio)
    if len(audio) == 0:
        return None

    segments, info = model.transcribe(audio, beam_size=1, vad_filter=True)
    text = " ".join(segment.text.strip() for segment in segments).strip()
    language = getattr(info, "language", None)
    probability = getattr(info, "language_probability", None)

    if not text:
        return None

    translation = None
    if language and language != "en" and (probability is None or probability >= TRANSLATION_MIN_PROBABILITY):
        translated_segments, _ = model.transcribe(audio, beam_size=1, vad_filter=True, task="translate")
        translated = " ".join(segment.text.strip() for segment in translated_segments).strip()
        if translated and translated.lower() != text.lower():
            translation = translated

    return {
        "type": "transcript",
        "timestamp": utc_timestamp(),
        "text": text,
        "language": language,
        "probability": probability,
        "translation": translation,
    }


def decode_media_chunk(data: str) -> bytes:
    ffmpeg = require_command("ffmpeg")
    media_bytes = base64.b64decode(data)
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as media_file:
        media_file.write(media_bytes)
        media_path = media_file.name

    try:
        process = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                media_path,
                "-vn",
                "-ac",
                str(CHANNELS),
                "-ar",
                str(SAMPLE_RATE),
                "-f",
                "s16le",
                "pipe:1",
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        return process.stdout
    finally:
        try:
            os.unlink(media_path)
        except OSError:
            pass


def decode_pcm_chunk(message: dict[str, Any]) -> bytes:
    sample_rate = int(message.get("sampleRate") or SAMPLE_RATE)
    channels = int(message.get("channels") or CHANNELS)
    if sample_rate != SAMPLE_RATE or channels != CHANNELS:
        raise RuntimeError(f"Unsupported PCM format: {sample_rate} Hz, {channels} channel(s)")
    return base64.b64decode(message["data"], validate=True)


def stdin_reader(audio_queue: queue.Queue[dict[str, Any]], stop_event: threading.Event) -> None:
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue

            if message.get("type") == "stop":
                stop_event.set()
                break
            if message.get("type") == "audio":
                audio_queue.put(message)
    finally:
        stop_event.set()


def run_local(settings: Settings, stop_event: threading.Event) -> None:
    audio_queue: queue.Queue[dict[str, Any]] = queue.Queue()
    threading.Thread(target=stdin_reader, args=(audio_queue, stop_event), daemon=True).start()
    model = load_model(settings)
    emit({"type": "status", "status": "listening", "message": "Listening for local audio"})

    while not stop_event.is_set() or not audio_queue.empty():
        try:
            message = audio_queue.get(timeout=0.2)
        except queue.Empty:
            continue

        try:
            if message.get("kind") == "pcm_s16le":
                pcm = decode_pcm_chunk(message)
            else:
                pcm = decode_media_chunk(message["data"])
            try:
                event = transcribe_pcm(model, pcm)
            except Exception as error:
                if settings.device == "cuda" and looks_like_cuda_failure(error):
                    model = load_cpu_fallback_model(settings)
                    event = transcribe_pcm(model, pcm)
                else:
                    raise
            if event:
                emit(event)
        except Exception as error:
            emit({"type": "error", "message": str(error)})


def resolve_stream_url(url: str, quality: str) -> str:
    try:
        import streamlink
    except Exception as error:
        raise WorkerError("streamlink is not available in the worker bundle") from error

    try:
        streams = streamlink.streams(url)
    except Exception as error:
        message = str(error) or repr(error)
        raise WorkerError(f"streamlink failed: {message}") from error

    if not streams:
        raise StreamUnavailable(f"No playable streams found for {url}")

    stream = streams.get(quality) or streams.get("best") or next(iter(streams.values()))
    try:
        stream_url = stream.to_url()
    except Exception as error:
        raise WorkerError(f"streamlink could not resolve stream URL: {error}") from error

    if not stream_url:
        raise StreamUnavailable(f"No playable streams found for {url}")
    return stream_url


def start_audio_process(url: str, quality: str) -> subprocess.Popen[bytes]:
    ffmpeg = require_command("ffmpeg")
    stream_url = resolve_stream_url(url, quality)
    ffmpeg_process = subprocess.Popen(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "warning",
            "-i",
            stream_url,
            "-vn",
            "-ac",
            str(CHANNELS),
            "-ar",
            str(SAMPLE_RATE),
            "-f",
            "s16le",
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return ffmpeg_process


def stop_processes(ffmpeg_process: subprocess.Popen[bytes] | None) -> None:
    if not ffmpeg_process:
        return

    processes = [ffmpeg_process]
    for process in processes:
        if not process or process.poll() is not None:
            continue
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


def read_exact(stream: Any, byte_count: int) -> bytes:
    chunks: list[bytes] = []
    remaining = byte_count
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def run_twitch(settings: Settings, stop_event: threading.Event) -> None:
    if not settings.url:
        raise RuntimeError("Twitch URL is required")

    chunk_bytes = settings.chunk_seconds * SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH_BYTES
    ffmpeg_process = None

    try:
        emit({"type": "status", "status": "checking_stream", "message": "Opening Twitch stream"})
        ffmpeg_process = start_audio_process(settings.url, settings.quality)
        if ffmpeg_process.stdout is None:
            raise WorkerError("ffmpeg stdout was not available")
        emit({"type": "status", "status": "stream_open", "message": "Twitch stream opened"})
        model = load_model(settings)

        chunks = 0
        while not stop_event.is_set():
            raw_audio = read_exact(ffmpeg_process.stdout, chunk_bytes)
            if len(raw_audio) < chunk_bytes:
                stderr = ""
                if ffmpeg_process.stderr is not None:
                    try:
                        stderr = ffmpeg_process.stderr.read().decode("utf-8", errors="ignore").strip()
                    except Exception:
                        stderr = ""
                if stderr:
                    raise WorkerError(f"ffmpeg ended early: {stderr}")
                emit({"type": "status", "status": "stream_ended", "message": "Twitch stream ended"})
                break
            try:
                event = transcribe_pcm(model, raw_audio)
            except Exception as error:
                if settings.device == "cuda" and looks_like_cuda_failure(error):
                    model = load_cpu_fallback_model(settings)
                    event = transcribe_pcm(model, raw_audio)
                else:
                    raise
            if event:
                emit(event)
            chunks += 1
            if settings.max_chunks is not None and chunks >= settings.max_chunks:
                emit({"type": "status", "status": "max_chunks", "message": "Reached test chunk limit"})
                break
    finally:
        stop_processes(ffmpeg_process)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["local", "twitch"], default="local")
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--chunk-seconds", type=int, default=8)
    parser.add_argument("--url")
    parser.add_argument("--quality", default="best")
    parser.add_argument("--max-chunks", type=int)
    parser.add_argument("--self-test", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.self_test:
        emit({"type": "status", "status": "self_test_ok", "message": "Worker self-test OK"})
        return 0

    settings = Settings(
        mode=args.mode,
        model=args.model,
        device=args.device,
        compute_type=args.compute_type,
        chunk_seconds=max(5, args.chunk_seconds),
        url=args.url,
        quality=args.quality,
        max_chunks=args.max_chunks,
    )

    stop_event = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop_event.set())
    signal.signal(signal.SIGINT, lambda *_: stop_event.set())

    try:
        emit({"type": "status", "status": "starting", "message": "Worker starting"})
        if settings.mode == "twitch":
            run_twitch(settings, stop_event)
        else:
            run_local(settings, stop_event)
        emit({"type": "status", "status": "stopped", "message": "Worker stopped"})
        return 0
    except StreamUnavailable as error:
        emit({"type": "error", "message": str(error)})
        return 2
    except Exception as error:
        emit({"type": "error", "message": str(error)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

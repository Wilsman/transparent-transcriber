# Transparent Transcriber

Transparent OBS-friendly caption window for local audio or a Twitch URL.

## What It Does

- Runs as a transparent, frameless, always-on-top Electron window.
- Captures a selected microphone and optional desktop/window audio source.
- Sends audio chunks to a Python `faster-whisper` worker.
- Shows recent captions and English translations for non-English speech.
- Supports Twitch URL transcription as a backup path through `streamlink`.

## Local Setup

Install JavaScript dependencies:

```powershell
bun install
```

Install Python dependencies:

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
```

CUDA 12 plus cuDNN 9 can be installed separately for GPU inference, matching the current `faster-whisper` upstream guidance. They are not bundled into the portable app because that adds roughly 900 MB to the artifact. If CUDA is not available, the worker falls back to CPU/int8.

Run the worker smoke check:

```powershell
bun run check
```

Run the app:

```powershell
$env:PYTHON = ".\.venv\Scripts\python.exe"
bun run dev
```

The first transcription run downloads the selected Whisper model.

## Audio Capture Notes

Local mode can use:

- A microphone.
- A Windows input device such as Stereo Mix.
- A virtual cable such as VB-Cable.
- A desktop/window source if Electron/Windows exposes audio for that selected source.

Desktop capture uses Electron display media with Windows loopback audio. If the chosen desktop source has no audio track, the app shows a setup error and keeps the worker stopped.

## Twitch Backup Mode

Twitch mode requires `streamlink` in the Python environment:

```powershell
.\.venv\Scripts\python -m pip install streamlink
```

Enter a full Twitch URL, then start. The worker checks whether the stream is playable before launching the full audio pipeline.

## Portable Windows Build

Build the Python sidecar and Electron portable app:

```powershell
$env:PYTHON = ".\.venv\Scripts\python.exe"
bun run dist
```

The build script:

1. Packages `worker/transcriber_worker.py` into `dist/transcriber-worker.exe`.
2. Packages Electron as a Windows portable app.
3. Includes `ffmpeg-static` as `resources/bin/ffmpeg.exe`.

Whisper models are not bundled. They are downloaded on first use.

## GitHub Releases

The repo includes a Windows release workflow in `.github/workflows/release.yml`.

To publish a shareable portable exe:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

The workflow builds `Transparent Transcriber-<version>-portable.exe` on `windows-latest` and attaches it to the GitHub release.

You can also run the workflow manually from the GitHub Actions tab to create a downloadable build artifact without publishing a release.

## Current Defaults

- Model: `small`
- Device: `cuda`, with worker fallback to CPU/int8 if CUDA is unavailable
- Compute type: `float16`
- Chunk size: `8s`
- Twitch quality: `best`

On launch, the app selects the first screen/desktop source by default so Start captures desktop audio without manually choosing a source when Electron/Windows exposes that audio track.

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
bun run dev
```

`bun run dev` automatically uses `.\.venv\Scripts\python.exe` when it exists. The Electron app starts the Python worker when you press Start. The first transcription run downloads the selected Whisper model.

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

## Windows Desktop Build

Build the Python sidecar, installer, and portable app:

```powershell
bun run dist:desktop:win
```

The build script:

1. Packages `worker/transcriber_worker.py` into `dist/transcriber-worker.exe`.
2. Packages Electron as a Windows NSIS installer and portable app.
3. Includes `ffmpeg-static` as `resources/bin/ffmpeg.exe`.

Whisper models are not bundled. They are downloaded on first use.

Installed builds check GitHub Releases for updates on startup and through the Updates button. Installer builds can download, install, and relaunch from inside the app. Portable builds open the latest GitHub release so the user can download the new portable exe.

The local build command only creates files in `dist`; it does not publish anything to GitHub.

Expected local output:

- `dist/Transparent Transcriber-<version>-setup.exe`
- `dist/Transparent Transcriber-<version>-setup.exe.blockmap`
- `dist/Transparent Transcriber-<version>-portable.exe`
- `dist/latest.yml`

## GitHub Releases

The repo includes a Windows release workflow in `.github/workflows/release.yml`.

### Push normal code changes

Commit and push the app source without publishing a release:

```powershell
git status
git add .
git commit -m "feat: describe the change"
git push origin master
```

### Run the GitHub Action manually

Run this when you want GitHub to build downloadable artifacts without creating a GitHub Release:

```powershell
gh workflow run Release --ref master
gh run list --workflow Release --limit 3
gh run watch <run-id> --exit-status
```

The manual run uploads a workflow artifact named `Transparent Transcriber Windows`.

### Publish a real updater release

The in-app updater checks GitHub Releases, so a new update needs a new version in `package.json` and a matching tag.

Example:

```powershell
bun run check
bun run dist:desktop:win
git add package.json bun.lock
git commit -m "chore: release v0.1.1"
git tag v0.1.1
git push origin master
git push origin v0.1.1
```

The workflow builds `Transparent Transcriber-<version>-setup.exe`, `Transparent Transcriber-<version>-portable.exe`, and updater metadata on `windows-latest`, then attaches them to the GitHub release.

After the tagged release finishes, installed copies of the app can find it through the startup update check or the Updates button.

## Current Defaults

- Model: `small`
- Device: `cuda`, with worker fallback to CPU/int8 if CUDA is unavailable
- Compute type: `float16`
- Chunk size: `8s`
- Twitch quality: `best`

On launch, the app selects the first screen/desktop source by default so Start captures desktop audio without manually choosing a source when Electron/Windows exposes that audio track.

const { app, BrowserWindow, desktopCapturer, ipcMain, screen, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

let mainWindow;
let workerProcess;
let workerReader;
let preferredDesktopSourceId;

const isPackaged = app.isPackaged;
const appRoot = app.getAppPath();
const resourceRoot = isPackaged ? process.resourcesPath : path.join(__dirname, "..", "..");

function workerCommand() {
  const bundledWorker = path.join(process.resourcesPath, "worker", "transcriber-worker.exe");
  if (isPackaged && fs.existsSync(bundledWorker)) {
    return { command: bundledWorker, args: [] };
  }

  const localWorker = path.join(resourceRoot, "worker", "transcriber_worker.py");
  return { command: process.env.PYTHON || "python", args: [localWorker] };
}

function bundledFfmpegPath() {
  if (isPackaged) {
    return path.join(process.resourcesPath, "bin", "ffmpeg.exe");
  }

  try {
    return require("ffmpeg-static") || process.env.FFMPEG_PATH || "";
  } catch {
    return process.env.FFMPEG_PATH || "";
  }
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(920, width),
    height: Math.min(360, height),
    minWidth: 520,
    minHeight: 220,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.loadFile(path.join(appRoot, "src", "renderer", "index.html"));

  mainWindow.on("closed", () => {
    stopWorker();
    mainWindow = null;
  });
}

function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      fetchWindowIcons: false,
      thumbnailSize: { width: 0, height: 0 }
    });
    const preferred = sources.find((source) => source.id === preferredDesktopSourceId);
    const firstScreen = sources.find((source) => source.id.startsWith("screen:"));
    const source = preferred || firstScreen || sources[0];

    callback({
      video: source,
      audio: "loopback"
    });
  });
}

function stopWorker() {
  if (!workerProcess) return;

  try {
    workerProcess.stdin.write(JSON.stringify({ type: "stop" }) + "\n");
  } catch {}

  const processToKill = workerProcess;
  workerProcess = null;

  setTimeout(() => {
    if (!processToKill.killed) {
      processToKill.kill();
    }
  }, 800);
}

function startWorker(settings) {
  stopWorker();

  const { command, args } = workerCommand();
  const workerArgs = [
    ...args,
    "--mode",
    settings.mode || "local",
    "--model",
    settings.model || "small",
    "--device",
    settings.device || "cuda",
    "--compute-type",
    settings.computeType || "float16",
    "--chunk-seconds",
    String(settings.chunkSeconds || 8)
  ];

  if (settings.mode === "twitch") {
    if (settings.twitchUrl) workerArgs.push("--url", settings.twitchUrl);
    if (settings.twitchQuality) workerArgs.push("--quality", settings.twitchQuality);
  }

  workerProcess = spawn(command, workerArgs, {
    cwd: resourceRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      FFMPEG_PATH: bundledFfmpegPath(),
      NVIDIA_DLL_ROOT: isPackaged
        ? path.join(process.resourcesPath, "nvidia")
        : path.join(resourceRoot, ".venv", "Lib", "site-packages", "nvidia")
    },
    windowsHide: true
  });

  workerReader = readline.createInterface({ input: workerProcess.stdout });
  workerReader.on("line", (line) => {
    if (!line.trim()) return;
    try {
      sendToRenderer("transcriber:event", JSON.parse(line));
    } catch {
      sendToRenderer("transcriber:event", {
        type: "log",
        level: "warn",
        message: line
      });
    }
  });

  workerProcess.stderr.on("data", (chunk) => {
    sendToRenderer("transcriber:event", {
      type: "log",
      level: "stderr",
      message: chunk.toString()
    });
  });

  workerProcess.on("error", (error) => {
    sendToRenderer("transcriber:event", {
      type: "error",
      message: error.message
    });
  });

  workerProcess.on("exit", (code, signal) => {
    workerProcess = null;
    sendToRenderer("transcriber:event", {
      type: "status",
      status: "worker_exit",
      message: signal ? `Worker stopped by ${signal}` : `Worker exited with code ${code}`
    });
  });
}

ipcMain.handle("transcriber:start", (_event, settings) => {
  startWorker(settings || {});
  return { ok: true };
});

ipcMain.handle("transcriber:stop", () => {
  stopWorker();
  return { ok: true };
});

ipcMain.handle("transcriber:audio-chunk", (_event, payload) => {
  if (!workerProcess || !workerProcess.stdin.writable) {
    return { ok: false, error: "Worker is not running" };
  }
  workerProcess.stdin.write(JSON.stringify({ type: "audio", ...payload }) + "\n");
  return { ok: true };
});

ipcMain.handle("desktop-sources:list", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    fetchWindowIcons: false,
    thumbnailSize: { width: 0, height: 0 }
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name
  }));
});

ipcMain.handle("desktop-sources:select", (_event, sourceId) => {
  preferredDesktopSourceId = sourceId || undefined;
  return { ok: true };
});

app.whenReady().then(() => {
  installDisplayMediaHandler();
  createWindow();
});

app.on("window-all-closed", () => {
  stopWorker();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

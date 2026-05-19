const { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { autoUpdater } = require("electron-updater");

let mainWindow;
let workerProcess;
let workerReader;
let preferredDesktopSourceId;
let startupUpdateCheckStarted = false;
let updateCheckInFlight = false;

const isPackaged = app.isPackaged;
const appRoot = app.getAppPath();
const resourceRoot = isPackaged ? process.resourcesPath : path.join(__dirname, "..", "..");
const githubRepo = "Wilsman/transparent-transcriber";
const latestReleaseUrl = `https://github.com/${githubRepo}/releases/latest`;
const latestReleaseApiUrl = `https://api.github.com/repos/${githubRepo}/releases/latest`;
let updateState = {
  status: "idle",
  currentVersion: app.getVersion(),
  version: null,
  message: "",
  progress: null,
  isPackaged,
  isPortable: false,
  releaseUrl: latestReleaseUrl
};

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

function localPythonCommand() {
  if (process.env.PYTHON) return process.env.PYTHON;

  const windowsVenvPython = path.join(resourceRoot, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(windowsVenvPython)) return windowsVenvPython;

  const posixVenvPython = path.join(resourceRoot, ".venv", "bin", "python");
  if (fs.existsSync(posixVenvPython)) return posixVenvPython;

  return process.platform === "win32" ? "python" : "python3";
}

function workerCommand() {
  const bundledWorker = path.join(process.resourcesPath, "worker", "transcriber-worker.exe");
  if (isPackaged && fs.existsSync(bundledWorker)) {
    return { command: bundledWorker, args: [] };
  }

  const localWorker = path.join(resourceRoot, "worker", "transcriber_worker.py");
  return { command: localPythonCommand(), args: [localWorker] };
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

function isPortableBuild() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE);
}

function publishUpdateState(nextState) {
  updateState = {
    ...updateState,
    ...nextState,
    currentVersion: app.getVersion(),
    isPackaged,
    isPortable: isPortableBuild(),
    releaseUrl: latestReleaseUrl
  };
  sendToRenderer("updates:event", updateState);
  return updateState;
}

function parseVersion(version) {
  return String(version || "")
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }

  return 0;
}

function updateInfoFromRelease(release) {
  const version = String(release?.tag_name || release?.name || "").replace(/^v/i, "");
  return {
    version,
    releaseName: release?.name || release?.tag_name || "",
    releaseDate: release?.published_at || "",
    releaseUrl: release?.html_url || latestReleaseUrl
  };
}

async function checkPortableUpdate() {
  publishUpdateState({
    status: "checking",
    message: "Checking GitHub releases...",
    progress: null
  });

  const response = await fetch(latestReleaseApiUrl, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "transparent-transcriber-updater"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub update check failed: ${response.status}`);
  }

  const release = await response.json();
  const info = updateInfoFromRelease(release);

  if (info.version && compareVersions(info.version, app.getVersion()) > 0) {
    return publishUpdateState({
      status: "available",
      updateMode: "portable",
      message: `Update available: v${info.version}`,
      progress: null,
      ...info
    });
  }

  return publishUpdateState({
    status: "no-update",
    updateMode: "portable",
    version: info.version || null,
    message: "You're up to date.",
    progress: null
  });
}

async function checkForUpdates() {
  if (!isPackaged) {
    return publishUpdateState({
      status: "dev",
      updateMode: "dev",
      message: "Updates are only available in packaged builds.",
      progress: null
    });
  }

  if (updateCheckInFlight) {
    return updateState;
  }

  updateCheckInFlight = true;
  try {
    if (isPortableBuild()) {
      return await checkPortableUpdate();
    }

    await autoUpdater.checkForUpdates();
    return updateState;
  } catch (error) {
    return publishUpdateState({
      status: "error",
      message: error.message || "Update check failed.",
      progress: null
    });
  } finally {
    updateCheckInFlight = false;
  }
}

function installUpdateAndRelaunch() {
  if (updateState.status !== "downloaded") {
    return publishUpdateState({
      status: "error",
      message: "Update has not finished downloading.",
      progress: null
    });
  }

  stopWorker();
  publishUpdateState({
    status: "installing",
    message: "Installing update and relaunching...",
    progress: null
  });
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return updateState;
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

  mainWindow.webContents.once("did-finish-load", () => {
    publishUpdateState(updateState);
    if (isPackaged && !startupUpdateCheckStarted) {
      startupUpdateCheckStarted = true;
      setTimeout(() => {
        checkForUpdates().catch((error) => {
          publishUpdateState({
            status: "error",
            message: error.message || "Update check failed.",
            progress: null
          });
        });
      }, 1500);
    }
  });

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

ipcMain.handle("updates:check", () => checkForUpdates());

ipcMain.handle("updates:download", async () => {
  if (!isPackaged) {
    return publishUpdateState({
      status: "dev",
      updateMode: "dev",
      message: "Updates are only available in packaged builds.",
      progress: null
    });
  }

  if (isPortableBuild()) {
    await shell.openExternal(updateState.releaseUrl || latestReleaseUrl);
    return publishUpdateState({
      status: "opened-release",
      updateMode: "portable",
      message: "Opened the latest GitHub release.",
      progress: null
    });
  }

  try {
    publishUpdateState({
      status: "downloading",
      updateMode: "installer",
      message: "Downloading update...",
      progress: 0
    });
    await autoUpdater.downloadUpdate();
    return updateState;
  } catch (error) {
    return publishUpdateState({
      status: "error",
      message: error.message || "Update download failed.",
      progress: null
    });
  }
});

ipcMain.handle("updates:install-and-relaunch", () => installUpdateAndRelaunch());

ipcMain.handle("updates:open-release", async () => {
  await shell.openExternal(updateState.releaseUrl || latestReleaseUrl);
  return updateState;
});

autoUpdater.on("checking-for-update", () => {
  publishUpdateState({
    status: "checking",
    updateMode: "installer",
    message: "Checking for updates...",
    progress: null
  });
});

autoUpdater.on("update-available", (info) => {
  publishUpdateState({
    status: "available",
    updateMode: "installer",
    version: info.version || null,
    releaseName: info.releaseName || "",
    releaseDate: info.releaseDate || "",
    message: info.version ? `Update available: v${info.version}` : "Update available.",
    progress: null
  });
});

autoUpdater.on("update-not-available", (info) => {
  publishUpdateState({
    status: "no-update",
    updateMode: "installer",
    version: info.version || null,
    message: "You're up to date.",
    progress: null
  });
});

autoUpdater.on("download-progress", (progress) => {
  publishUpdateState({
    status: "downloading",
    updateMode: "installer",
    message: `Downloading update: ${Math.round(progress.percent || 0)}%`,
    progress: Math.round(progress.percent || 0)
  });
});

autoUpdater.on("update-downloaded", (info) => {
  publishUpdateState({
    status: "downloaded",
    updateMode: "installer",
    version: info.version || updateState.version,
    releaseName: info.releaseName || updateState.releaseName || "",
    releaseDate: info.releaseDate || updateState.releaseDate || "",
    message: "Update ready to install.",
    progress: 100
  });
});

autoUpdater.on("error", (error) => {
  publishUpdateState({
    status: "error",
    message: error.message || "Update failed.",
    progress: null
  });
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

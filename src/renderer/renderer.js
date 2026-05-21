const SETTINGS_KEY = "transparent-transcriber-settings";
const COLLAPSE_HINT_KEY = "transparent-transcriber-collapse-hint-seen";
const CAPTION_LIFETIME_MS = 10000;
const CAPTION_EXIT_MS = 280;
const CONFIDENCE_SHOW_THRESHOLD = 0.55;
const CAPTION_STAGE_MIN = 88;
const SHELL_PADDING_Y = 28;
const SHELL_GRID_GAP = 12;

const mode = document.querySelector("#mode");
const micDevice = document.querySelector("#micDevice");
const desktopSource = document.querySelector("#desktopSource");
const twitchUrl = document.querySelector("#twitchUrl");
const twitchUrlError = document.querySelector("#twitchUrlError");
const model = document.querySelector("#model");
const chunkSeconds = document.querySelector("#chunkSeconds");
const captionDisplayMode = document.querySelector("#captionDisplayMode");
const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const clearButton = document.querySelector("#clearButton");
const logsButton = document.querySelector("#logsButton");
const checkUpdateButton = document.querySelector("#checkUpdateButton");
const copyLogsButton = document.querySelector("#copyLogsButton");
const clearLogsButton = document.querySelector("#clearLogsButton");
const closeButton = document.querySelector("#closeButton");
const statusText = document.querySelector("#statusText");
const statusDot = document.querySelector("#statusDot");
const captionList = document.querySelector("#captionList");
const emptyState = document.querySelector("#emptyState");
const logPanel = document.querySelector("#logPanel");
const logOutput = document.querySelector("#logOutput");
const controls = document.querySelector("#controls");
const controlGrid = document.querySelector("#controlGrid");
const shell = document.querySelector("#shell");
const toggleControls = document.querySelector("#toggleControls");
const restoreControls = document.querySelector("#restoreControls");
const collapseHint = document.querySelector("#collapseHint");
const obsTip = document.querySelector("#obsTip");
const updatePanel = document.querySelector("#updatePanel");
const updateTitle = document.querySelector("#updateTitle");
const updateMessage = document.querySelector("#updateMessage");
const updateProgress = document.querySelector("#updateProgress");
const updateProgressBar = document.querySelector("#updateProgressBar");
const updatePrimaryButton = document.querySelector("#updatePrimaryButton");
const updateLaterButton = document.querySelector("#updateLaterButton");
const updateChipVersion = document.querySelector("#updateChipVersion");
const updateChipStatus = document.querySelector("#updateChipStatus");
const updateVersionRow = document.querySelector("#updateVersionRow");
const updateVersionCurrent = document.querySelector("#updateVersionCurrent");
const updateVersionArrow = document.querySelector("#updateVersionArrow");
const updateVersionNext = document.querySelector("#updateVersionNext");

let micStream;
let desktopStream;
let mixedStream;
let audioContext;
let sourceNode;
let processorNode;
let silentOutputNode;
let pcmFlushTimer;
let running = false;
let sessionState = "idle";
let sessionDetail = "";
let activityFlashTimer = null;
let nextCaptionId = 1;
const captions = [];
const captionDom = new Map();
const captionExpiryTimers = new Map();
const captionExitTimers = new Map();
const logs = [];
let updateState = { status: "idle" };
let updatePanelDismissed = false;
let manualUpdateCheckPending = false;
let updateNoticeTimer;
let settingsLoaded = false;
let resizeFrame = null;

const SESSION_LABELS = {
  idle: "Idle",
  running: "Running",
  error: "Error"
};

function measureContentSize() {
  const captionOnly = shell.classList.contains("caption-only");

  if (captionOnly) {
    const captionStage = document.querySelector(".caption-stage");
    const stageHeight = Math.max(
      CAPTION_STAGE_MIN,
      captionStage.scrollHeight,
      captionList.offsetHeight + (emptyState.classList.contains("hidden") ? 0 : emptyState.offsetHeight)
    );

    return {
      captionOnly: true,
      width: Math.ceil(shell.scrollWidth || controls.offsetWidth || 920),
      height: Math.ceil(SHELL_PADDING_Y + stageHeight)
    };
  }

  const controlsHeight = Math.ceil(controls.scrollHeight);
  const height = Math.ceil(SHELL_PADDING_Y + SHELL_GRID_GAP + controlsHeight + CAPTION_STAGE_MIN);

  return {
    captionOnly: false,
    width: Math.ceil(Math.max(shell.scrollWidth, controls.scrollWidth, 520)),
    height
  };
}

function scheduleResizeToContent() {
  if (resizeFrame !== null) {
    window.cancelAnimationFrame(resizeFrame);
  }

  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = null;
    if (!window.transcriber?.resizeToContent) return;
    window.transcriber.resizeToContent(measureContentSize()).catch(() => {});
  });
}

function timestampForLog() {
  return new Date().toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function appendLog(level, message, data) {
  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  logs.push(`[${timestampForLog()}] ${level.toUpperCase()} ${message}${suffix}`);
  while (logs.length > 250) logs.shift();
  logOutput.textContent = logs.join("\n");
  logOutput.scrollTop = logOutput.scrollHeight;
}

function updateEmptyState() {
  const visibleCount = captions.filter((caption) => getCaptionDisplayText(caption)).length;
  if (visibleCount > 0) {
    emptyState.classList.add("hidden");
    return;
  }

  emptyState.classList.remove("hidden");
  emptyState.textContent = running ? "Waiting for speech..." : "Press Start to transcribe";
}

function setSessionState(state, detail = "") {
  sessionState = state;
  sessionDetail = detail;
  statusDot.classList.toggle("running", state === "running");
  statusDot.classList.toggle("error", state === "error");
  controls.classList.toggle("is-running", running);
  applyStatusLabel();
  updateEmptyState();
}

function applyStatusLabel() {
  if (activityFlashTimer) return;
  const base = SESSION_LABELS[sessionState] || "Idle";
  const label = sessionDetail && sessionState !== "idle" ? sessionDetail : base;
  statusText.textContent = label;
  statusText.title = label;
}

function flashActivity(message, durationMs = 1800) {
  if (!running || sessionState === "error") return;

  if (activityFlashTimer) {
    window.clearTimeout(activityFlashTimer);
    activityFlashTimer = null;
  }

  statusText.textContent = message;
  statusText.title = message;
  statusText.classList.add("activity-flash");

  activityFlashTimer = window.setTimeout(() => {
    activityFlashTimer = null;
    statusText.classList.remove("activity-flash");
    applyStatusLabel();
  }, durationMs);
}

function setConfigDisabled(disabled) {
  const fields = controlGrid.querySelectorAll("select, input");
  for (const field of fields) {
    field.disabled = disabled;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        mode: mode.value,
        twitchUrl: twitchUrl.value,
        model: model.value,
        chunkSeconds: chunkSeconds.value,
        captionDisplayMode: captionDisplayMode.value,
        micDevice: micDevice.value,
        desktopSource: desktopSource.value
      })
    );
  } catch {
    // Ignore quota or privacy errors.
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function applyStoredSettings(stored) {
  if (!stored) return;

  if (stored.mode === "local" || stored.mode === "twitch") {
    mode.value = stored.mode;
  }
  if (stored.twitchUrl) twitchUrl.value = stored.twitchUrl;
  if (stored.model && [...model.options].some((option) => option.value === stored.model)) {
    model.value = stored.model;
  }
  if (stored.chunkSeconds && [...chunkSeconds.options].some((option) => option.value === stored.chunkSeconds)) {
    chunkSeconds.value = stored.chunkSeconds;
  }
  if (
    stored.captionDisplayMode &&
    [...captionDisplayMode.options].some((option) => option.value === stored.captionDisplayMode)
  ) {
    captionDisplayMode.value = stored.captionDisplayMode;
  }
}

function restoreDeviceSelections(stored) {
  if (!stored) return;

  if (stored.micDevice && [...micDevice.options].some((option) => option.value === stored.micDevice)) {
    micDevice.value = stored.micDevice;
  }
  if (stored.desktopSource && [...desktopSource.options].some((option) => option.value === stored.desktopSource)) {
    desktopSource.value = stored.desktopSource;
  }
}

function bindSettingsPersistence() {
  const persistTargets = [mode, twitchUrl, model, chunkSeconds, captionDisplayMode, micDevice, desktopSource];
  for (const target of persistTargets) {
    target.addEventListener("change", () => {
      saveSettings();
      if (target === mode) {
        updateModeVisibility();
        clearTwitchUrlError();
        scheduleResizeToContent();
      }
    });
    if (target === twitchUrl) {
      target.addEventListener("input", clearTwitchUrlError);
    }
  }
}

function clearTwitchUrlError() {
  twitchUrlError.textContent = "";
  twitchUrlError.classList.add("hidden");
  twitchUrl.removeAttribute("aria-invalid");
}

function validateTwitchUrl(showError = true) {
  if (mode.value !== "twitch") {
    clearTwitchUrlError();
    return true;
  }

  const value = twitchUrl.value.trim();
  const valid = /^https?:\/\/(www\.)?twitch\.tv\/[A-Za-z0-9_]{3,25}\/?$/i.test(value);

  if (!showError) return valid;

  if (!value) {
    twitchUrlError.textContent = "Enter a Twitch channel URL.";
    twitchUrlError.classList.remove("hidden");
    twitchUrl.setAttribute("aria-invalid", "true");
    return false;
  }

  if (!valid) {
    twitchUrlError.textContent = "Use a full URL like https://www.twitch.tv/channel";
    twitchUrlError.classList.remove("hidden");
    twitchUrl.setAttribute("aria-invalid", "true");
    return false;
  }

  clearTwitchUrlError();
  return true;
}

function formatCaptionMeta(caption) {
  const language = caption.language ? caption.language.toUpperCase() : "AUTO";
  const probability = caption.probability;

  if (!Number.isFinite(probability) || probability < CONFIDENCE_SHOW_THRESHOLD) {
    return language;
  }

  const percent = Math.round(probability * 100);
  const displayPercent = percent >= 100 && probability < 0.995 ? 99 : Math.min(99, percent);
  return `${language} · ${displayPercent}% confidence`;
}

function updateNoticeShouldShow(state, forceShow = false) {
  if (updatePanelDismissed && !["downloading", "downloaded", "installing"].includes(state.status)) {
    return false;
  }

  if (["available", "downloading", "downloaded", "installing", "opened-release"].includes(state.status)) {
    return true;
  }

  return forceShow && ["checking", "no-update", "error", "dev"].includes(state.status);
}

function formatVersionLabel(version) {
  if (!version) return "";
  const normalized = String(version).replace(/^v/i, "");
  return normalized ? `v${normalized}` : "";
}

function updateVersionCompareRow(state) {
  const current = formatVersionLabel(state.currentVersion);
  const next = formatVersionLabel(state.version);
  const showCompare = Boolean(
    current && next && ["available", "downloading", "downloaded", "installing"].includes(state.status)
  );

  updateVersionRow.classList.toggle("hidden", !showCompare);
  updateVersionRow.setAttribute("aria-hidden", showCompare ? "false" : "true");
  updateVersionCurrent.textContent = current || "v?";
  updateVersionNext.textContent = next || "";
  updateVersionNext.classList.toggle("hidden", !showCompare);
  updateVersionArrow.classList.toggle("hidden", !showCompare);
}

function updateChipForState(state) {
  const status = state.status || "idle";
  const currentLabel = formatVersionLabel(state.currentVersion) || "v?";
  const nextLabel = formatVersionLabel(state.version);

  checkUpdateButton.dataset.status = status;
  checkUpdateButton.classList.toggle("attention", ["available", "downloaded", "error"].includes(status));
  updateChipVersion.textContent = currentLabel;

  let statusLabel = "Check updates";
  if (status === "checking") {
    statusLabel = "Checking…";
  } else if (status === "available") {
    statusLabel = nextLabel ? `${nextLabel} available` : "Update available";
  } else if (status === "downloading") {
    const pct = Number.isFinite(state.progress) ? Math.round(state.progress) : 0;
    statusLabel = nextLabel ? `Downloading ${nextLabel} · ${pct}%` : `Downloading · ${pct}%`;
  } else if (status === "downloaded") {
    statusLabel = nextLabel ? `${nextLabel} ready` : "Ready to restart";
  } else if (status === "installing") {
    statusLabel = "Installing…";
  } else if (status === "no-update") {
    statusLabel = "Up to date";
  } else if (status === "error") {
    statusLabel = "Update failed";
  } else if (status === "dev") {
    statusLabel = "Dev build";
  } else if (status === "opened-release") {
    statusLabel = "Release opened";
  }

  updateChipStatus.textContent = statusLabel;
  checkUpdateButton.title = `${currentLabel} — ${statusLabel}. Click for details.`;
  checkUpdateButton.setAttribute(
    "aria-label",
    `App version ${currentLabel}. ${statusLabel}. Open update details.`
  );
  updateVersionCompareRow(state);
}

function updatePanelCopyForState(state) {
  const current = formatVersionLabel(state.currentVersion);
  const next = formatVersionLabel(state.version);

  if (state.status === "checking") {
    updateTitle.textContent = "Checking for updates";
    updateMessage.textContent = current
      ? `Looking for releases newer than ${current}…`
      : state.message || "Checking GitHub releases...";
    return;
  }

  if (state.status === "available") {
    updateTitle.textContent = next ? `Update available — ${next}` : "Update available";
    updateMessage.textContent = current && next
      ? `You're on ${current}. ${next} is ready to download.`
      : state.isPortable
        ? "Portable builds open the latest GitHub release so you can download the new exe."
        : "Download the update, then relaunch when it is ready.";
    return;
  }

  if (state.status === "downloading") {
    const pct = Number.isFinite(state.progress) ? Math.round(state.progress) : 0;
    updateTitle.textContent = next ? `Downloading ${next}` : "Downloading update";
    updateMessage.textContent = current && next
      ? `Updating from ${current} to ${next} — ${pct}%`
      : state.message || `Downloading update — ${pct}%`;
    return;
  }

  if (state.status === "downloaded") {
    updateTitle.textContent = next ? `${next} ready to install` : "Restart to finish updating";
    updateMessage.textContent = current && next
      ? `${next} is downloaded. Restart to move on from ${current}.`
      : "The update is downloaded. Relaunch now to switch to the new version.";
    return;
  }

  if (state.status === "installing") {
    updateTitle.textContent = next ? `Installing ${next}` : "Installing update";
    updateMessage.textContent = state.message || "Installing update and relaunching...";
    return;
  }

  if (state.status === "no-update") {
    updateTitle.textContent = "Up to date";
    updateMessage.textContent = current
      ? `${current} is the latest release.`
      : state.message || "You're running the latest version.";
    return;
  }

  if (state.status === "opened-release") {
    updateTitle.textContent = "Release opened";
    updateMessage.textContent = state.message || "Opened the latest GitHub release.";
    return;
  }

  if (state.status === "dev") {
    updateTitle.textContent = "Dev build";
    updateMessage.textContent = current
      ? `${current} — updates are only available in packaged builds.`
      : state.message || "Updates are only available in packaged builds.";
    return;
  }

  if (state.status === "error") {
    updateTitle.textContent = "Update check failed";
    updateMessage.textContent = state.message || "Could not check for updates.";
  }
}

function scheduleUpdatePanelHide(status, forceShow) {
  if (updateNoticeTimer) {
    window.clearTimeout(updateNoticeTimer);
    updateNoticeTimer = null;
  }

  if (!forceShow || ["available", "downloading", "downloaded", "installing", "error"].includes(status)) {
    return;
  }

  updateNoticeTimer = window.setTimeout(() => {
    if (!["available", "downloading", "downloaded", "installing", "error"].includes(updateState.status)) {
      updatePanel.classList.add("hidden");
    }
  }, 3200);
}

function handleUpdateState(nextState, forceShow = false) {
  updateState = { ...updateState, ...nextState };
  const showPanel = updateNoticeShouldShow(updateState, forceShow);
  updatePanel.classList.toggle("hidden", !showPanel);
  updatePanel.dataset.status = updateState.status || "idle";
  updateChipForState(updateState);

  const progress = Number.isFinite(updateState.progress) ? Math.max(0, Math.min(100, updateState.progress)) : 0;
  updateProgress.classList.toggle("hidden", updateState.status !== "downloading");
  updateProgressBar.style.width = `${progress}%`;

  updatePrimaryButton.disabled = false;
  updatePrimaryButton.classList.toggle("hidden", false);
  updateLaterButton.textContent = "Later";

  if (
    updateState.status === "checking" ||
    updateState.status === "available" ||
    updateState.status === "downloading" ||
    updateState.status === "downloaded" ||
    updateState.status === "installing" ||
    updateState.status === "no-update" ||
    updateState.status === "opened-release" ||
    updateState.status === "dev" ||
    updateState.status === "error"
  ) {
    updatePanelCopyForState(updateState);

    if (updateState.status === "checking") {
      updatePrimaryButton.classList.add("hidden");
    } else if (updateState.status === "available") {
      updatePrimaryButton.textContent = updateState.isPortable ? "Download latest" : "Download";
    } else if (updateState.status === "downloading") {
      updatePrimaryButton.textContent = "Downloading";
      updatePrimaryButton.disabled = true;
    } else if (updateState.status === "downloaded") {
      updatePrimaryButton.textContent = "Restart now";
    } else if (updateState.status === "installing") {
      updatePrimaryButton.textContent = "Installing";
      updatePrimaryButton.disabled = true;
      updateLaterButton.textContent = "Close";
    } else if (updateState.status === "no-update" || updateState.status === "opened-release" || updateState.status === "dev") {
      updatePrimaryButton.classList.add("hidden");
    } else if (updateState.status === "error") {
      updatePrimaryButton.textContent = "Open releases";
    }
  } else {
    updatePanel.classList.add("hidden");
  }

  scheduleUpdatePanelHide(updateState.status, forceShow);
  scheduleResizeToContent();
}

function updateModeVisibility() {
  const localMode = mode.value === "local";
  controlGrid.classList.toggle("mode-local", localMode);
  controlGrid.classList.toggle("mode-twitch", !localMode);
  document.querySelectorAll(".local-only").forEach((item) => item.classList.toggle("hidden", !localMode));
  document.querySelectorAll(".twitch-only").forEach((item) => item.classList.toggle("hidden", localMode));
  scheduleResizeToContent();
}

async function loadDevices() {
  micDevice.innerHTML = "";
  desktopSource.innerHTML = "";

  const devices = await navigator.mediaDevices.enumerateDevices();
  const audioInputs = devices.filter((device) => device.kind === "audioinput");

  micDevice.append(new Option("No microphone", ""));
  for (const device of audioInputs) {
    micDevice.append(new Option(device.label || `Microphone ${micDevice.length}`, device.deviceId));
  }

  desktopSource.append(new Option("No desktop audio", ""));
  try {
    const sources = await window.transcriber.listDesktopSources();
    const sortedSources = sources.sort((a, b) => {
      const aScreen = a.id.startsWith("screen:") ? 0 : 1;
      const bScreen = b.id.startsWith("screen:") ? 0 : 1;
      return aScreen - bScreen || a.name.localeCompare(b.name);
    });

    for (const source of sortedSources) {
      desktopSource.append(new Option(source.name, source.id));
    }

    const stored = settingsLoaded ? null : loadSettings();
    const hasStoredDesktop =
      stored?.desktopSource && [...desktopSource.options].some((option) => option.value === stored.desktopSource);

    if (hasStoredDesktop) {
      desktopSource.value = stored.desktopSource;
    } else {
      const firstScreen = sortedSources.find((source) => source.id.startsWith("screen:"));
      if (firstScreen) {
        desktopSource.value = firstScreen.id;
        appendLog("info", `Desktop audio default: ${firstScreen.name}`);
      } else if (sortedSources.length > 0) {
        desktopSource.value = sortedSources[0].id;
        appendLog("info", `Desktop source default: ${sortedSources[0].name}`);
      }
    }
  } catch (error) {
    setSessionState("error", `Desktop sources unavailable: ${error.message}`);
    appendLog("error", `Desktop sources unavailable: ${error.message}`);
  }
}

async function getMicStream() {
  if (!micDevice.value) return null;
  appendLog("info", `Opening microphone: ${micDevice.options[micDevice.selectedIndex]?.text || micDevice.value}`);
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: micDevice.value },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    },
    video: false
  });
}

async function getDesktopStream() {
  if (!desktopSource.value) return null;

  appendLog("info", `Opening desktop source: ${desktopSource.options[desktopSource.selectedIndex]?.text || desktopSource.value}`);
  await window.transcriber.selectDesktopSource(desktopSource.value);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true
  });

  stream.getVideoTracks().forEach((track) => track.stop());

  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("Selected desktop source did not expose audio. Use a virtual audio device or another source.");
  }

  appendLog("info", `Desktop audio tracks: ${stream.getAudioTracks().length}`);
  return stream;
}

function mixStreams(streams) {
  audioContext = new AudioContext({ sampleRate: 48000 });
  const destination = audioContext.createMediaStreamDestination();

  for (const stream of streams) {
    const source = audioContext.createMediaStreamSource(stream);
    const gain = audioContext.createGain();
    gain.gain.value = 1;
    source.connect(gain).connect(destination);
  }

  return destination.stream;
}

function floatToBase64Pcm(floatSamples, inputSampleRate) {
  const outputLength = Math.max(1, Math.floor(floatSamples.length * 16000 / inputSampleRate));
  const output = new Int16Array(outputLength);
  const ratio = inputSampleRate / 16000;

  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(floatSamples.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    let count = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      sum += floatSamples[sampleIndex];
      count += 1;
    }

    const sample = Math.max(-1, Math.min(1, count ? sum / count : floatSamples[start] || 0));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  const bytes = new Uint8Array(output.buffer);
  let binary = "";
  const batchSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += batchSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + batchSize));
  }
  return {
    data: btoa(binary),
    outputBytes: bytes.length
  };
}

function startPcmCapture() {
  const sampleBuffers = [];
  let bufferedSamples = 0;
  sourceNode = audioContext.createMediaStreamSource(mixedStream);
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);

  processorNode.onaudioprocess = (event) => {
    if (!running) return;
    const input = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input.length);
    copy.set(input);
    sampleBuffers.push(copy);
    bufferedSamples += copy.length;
  };

  sourceNode.connect(processorNode);
  silentOutputNode = audioContext.createGain();
  silentOutputNode.gain.value = 0;
  processorNode.connect(silentOutputNode).connect(audioContext.destination);

  pcmFlushTimer = window.setInterval(async () => {
    if (!running || bufferedSamples === 0) return;

    const merged = new Float32Array(bufferedSamples);
    let offset = 0;
    for (const buffer of sampleBuffers.splice(0)) {
      merged.set(buffer, offset);
      offset += buffer.length;
    }
    bufferedSamples = 0;

    const pcm = floatToBase64Pcm(merged, audioContext.sampleRate);
    appendLog("debug", `Sending PCM chunk: ${Math.round(pcm.outputBytes / 1024)} KB`);
    await window.transcriber.sendAudioChunk({
      kind: "pcm_s16le",
      data: pcm.data,
      sampleRate: 16000,
      channels: 1,
      timestamp: new Date().toISOString()
    });
  }, Number(chunkSeconds.value) * 1000);

  appendLog("info", `PCM capture started: ${audioContext.sampleRate} Hz -> 16000 Hz, ${chunkSeconds.value}s chunks`);
}

async function startLocalCapture() {
  micStream = await getMicStream();
  desktopStream = await getDesktopStream();
  const streams = [micStream, desktopStream].filter(Boolean);

  if (streams.length === 0) {
    throw new Error("Select at least one microphone or desktop source");
  }

  mixedStream = mixStreams(streams);
  startPcmCapture();
}

function stopLocalCapture() {
  if (pcmFlushTimer) {
    window.clearInterval(pcmFlushTimer);
    pcmFlushTimer = null;
  }

  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }

  if (silentOutputNode) {
    silentOutputNode.disconnect();
    silentOutputNode = null;
  }

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  for (const stream of [micStream, desktopStream, mixedStream]) {
    if (!stream) continue;
    stream.getTracks().forEach((track) => track.stop());
  }

  micStream = null;
  desktopStream = null;
  mixedStream = null;

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
}

function getCaptionDisplayText(caption) {
  const language = caption.language ? caption.language.toLowerCase() : "";
  const isEnglish = !language || language === "en";
  if (captionDisplayMode.value === "translations-only") {
    if (isEnglish) return "";
    return caption.translation || "";
  }

  if (language && language !== "en") {
    return caption.translation || "";
  }
  return caption.text || "";
}

function clearCaptionTimers(id) {
  const expiryTimer = captionExpiryTimers.get(id);
  if (expiryTimer) {
    window.clearTimeout(expiryTimer);
    captionExpiryTimers.delete(id);
  }

  const exitTimer = captionExitTimers.get(id);
  if (exitTimer) {
    window.clearTimeout(exitTimer);
    captionExitTimers.delete(id);
  }
}

function clearCaptionExpiryTimers() {
  for (const id of [...captionExpiryTimers.keys(), ...captionExitTimers.keys()]) {
    clearCaptionTimers(id);
  }
}

function removeCaptionFromData(id) {
  const index = captions.findIndex((caption) => caption.id === id);
  if (index !== -1) captions.splice(index, 1);
  clearCaptionTimers(id);
}

function destroyCaptionElement(id) {
  const record = captionDom.get(id);
  if (record?.article?.isConnected) {
    record.article.remove();
  }
  captionDom.delete(id);
}

function beginCaptionExit(id) {
  const record = captionDom.get(id);
  if (!record || record.exiting) return;

  record.exiting = true;
  record.article.classList.add("caption-exit");

  const exitTimer = window.setTimeout(() => {
    captionExitTimers.delete(id);
    removeCaptionFromData(id);
    destroyCaptionElement(id);
    updateEmptyState();
  }, CAPTION_EXIT_MS);

  captionExitTimers.set(id, exitTimer);
}

function removeCaption(id, immediate = false) {
  if (immediate) {
    removeCaptionFromData(id);
    destroyCaptionElement(id);
    updateEmptyState();
    return;
  }

  beginCaptionExit(id);
}

function scheduleCaptionRemoval(id) {
  clearCaptionTimers(id);

  const exitAt = Math.max(0, CAPTION_LIFETIME_MS - CAPTION_EXIT_MS);
  const expiryTimer = window.setTimeout(() => beginCaptionExit(id), exitAt);
  captionExpiryTimers.set(id, expiryTimer);
}

function upsertCaptionElement(caption, staggerIndex) {
  const displayText = getCaptionDisplayText(caption);
  if (!displayText) return;

  let record = captionDom.get(caption.id);

  if (!record) {
    const article = document.createElement("article");
    article.className = "caption";
    article.dataset.captionId = String(caption.id);
    article.style.setProperty("--stagger", staggerIndex);

    const text = document.createElement("p");
    text.className = "text";
    text.textContent = displayText;

    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = formatCaptionMeta(caption);

    article.append(text, meta);
    captionList.append(article);
    record = { article, textEl: text, metaEl: meta, exiting: false };
    captionDom.set(caption.id, record);
  } else if (!record.exiting) {
    if (record.textEl.textContent !== displayText) {
      record.textEl.classList.add("is-updating");
      window.setTimeout(() => {
        record.textEl.textContent = displayText;
        record.textEl.classList.remove("is-updating");
      }, 90);
    }
    record.metaEl.textContent = formatCaptionMeta(caption);
    record.article.style.setProperty("--stagger", staggerIndex);
  }

  updateEmptyState();
}

function pruneCaptionDom(visibleIds) {
  for (const [id, record] of captionDom) {
    if (!visibleIds.has(id) && !record.exiting) {
      beginCaptionExit(id);
    }
  }
}

function renderCaptions() {
  const now = Date.now();
  for (let index = captions.length - 1; index >= 0; index -= 1) {
    if (captions[index].expiresAt <= now && !captionDom.get(captions[index].id)?.exiting) {
      beginCaptionExit(captions[index].id);
    }
  }

  const visibleCaptions = captions.filter((caption) => getCaptionDisplayText(caption)).slice(-3);
  const visibleIds = new Set(visibleCaptions.map((caption) => caption.id));

  pruneCaptionDom(visibleIds);

  visibleCaptions.forEach((caption, index) => {
    upsertCaptionElement(caption, index);
  });

  updateEmptyState();
}

function addCaption(event) {
  const caption = {
    ...event,
    id: nextCaptionId,
    expiresAt: Date.now() + CAPTION_LIFETIME_MS
  };
  nextCaptionId += 1;

  if (!getCaptionDisplayText(caption)) return;

  captions.push(caption);
  while (captions.length > 30) {
    const removed = captions.shift();
    if (removed) removeCaption(removed.id);
  }

  scheduleCaptionRemoval(caption.id);
  renderCaptions();
}

async function start() {
  if (running) return;

  if (!validateTwitchUrl(true)) {
    setSessionState("error", "Fix Twitch URL to start");
    twitchUrl.focus();
    return;
  }

  saveSettings();
  clearCaptionExpiryTimers();
  captions.length = 0;
  for (const id of [...captionDom.keys()]) {
    destroyCaptionElement(id);
  }
  renderCaptions();

  appendLog("info", `Starting ${mode.value} mode with ${model.value}, ${chunkSeconds.value}s chunks`);
  running = true;
  setConfigDisabled(true);
  startButton.disabled = true;
  stopButton.disabled = false;
  setSessionState("running", "Starting...");

  await window.transcriber.start({
    mode: mode.value,
    model: model.value,
    device: "cuda",
    computeType: "float16",
    chunkSeconds: Number(chunkSeconds.value),
    twitchUrl: twitchUrl.value.trim(),
    twitchQuality: "best"
  });

  if (mode.value === "local") {
    setSessionState("running", "Opening audio...");
    await startLocalCapture();
    setSessionState("running", "Listening");
  } else {
    setSessionState("running", "Opening Twitch stream");
  }
}

async function stop() {
  running = false;
  stopLocalCapture();
  appendLog("info", "Stopping worker");
  await window.transcriber.stop();
  startButton.disabled = false;
  stopButton.disabled = true;
  setConfigDisabled(false);
  setSessionState("idle");
}

function setLogsPanelVisible(visible) {
  logPanel.classList.toggle("hidden", !visible);
  logsButton.textContent = visible ? "Hide logs" : "Logs";
  logsButton.setAttribute("aria-pressed", visible ? "true" : "false");
  logsButton.setAttribute("aria-expanded", visible ? "true" : "false");
  scheduleResizeToContent();
}

function requestClose() {
  if (running) {
    const confirmed = window.confirm("Transcription is running. Stop and close?");
    if (!confirmed) return;
    stop()
      .catch((error) => appendLog("error", error.message))
      .finally(() => window.transcriber.closeWindow());
    return;
  }

  window.transcriber.closeWindow();
}

window.transcriber.onEvent((event) => {
  if (event.type === "transcript") {
    appendLog("transcript", event.text, {
      language: event.language,
      probability: event.probability,
      translation: event.translation
    });
  } else if (event.type === "error") {
    appendLog("error", event.message || "Worker error");
  } else if (event.type === "log") {
    appendLog(event.level || "log", event.message || "");
  } else if (event.type === "status") {
    appendLog("status", event.message || event.status || "Working");
  } else {
    appendLog("event", event.type || "unknown", event);
  }

  if (event.type === "transcript") {
    addCaption(event);
    flashActivity("New caption");
    return;
  }

  if (event.type === "error") {
    console.error(event);
    running = false;
    stopLocalCapture();
    setConfigDisabled(false);
    startButton.disabled = false;
    stopButton.disabled = true;
    setSessionState("error", event.message || "Worker error");
    updateEmptyState();
    return;
  }

  if (event.type === "log") {
    console.log(event.message || "");
    return;
  }

  if (event.type === "status") {
    const message = event.message || event.status || "Working";
    if (running) {
      setSessionState("running", message);
    } else {
      setSessionState("idle");
    }
  }
});

window.transcriber.onUpdateEvent((event) => {
  handleUpdateState(event, manualUpdateCheckPending);
});

mode.addEventListener("change", updateModeVisibility);
captionDisplayMode.addEventListener("change", renderCaptions);
startButton.addEventListener("click", () =>
  start().catch(async (error) => {
    running = false;
    stopLocalCapture();
    await window.transcriber.stop();
    startButton.disabled = false;
    stopButton.disabled = true;
    setConfigDisabled(false);
    setSessionState("error", error.message);
  })
);
stopButton.addEventListener("click", () => stop().catch((error) => setSessionState("error", error.message)));
clearButton.addEventListener("click", () => {
  clearCaptionExpiryTimers();
  captions.length = 0;
  for (const id of [...captionDom.keys()]) {
    destroyCaptionElement(id);
  }
  updateEmptyState();
  appendLog("info", "Captions cleared");
});
logsButton.addEventListener("click", () => {
  setLogsPanelVisible(logPanel.classList.contains("hidden"));
});
checkUpdateButton.addEventListener("click", async () => {
  if (["available", "downloading", "downloaded", "installing", "error"].includes(updateState.status)) {
    updatePanelDismissed = false;
    handleUpdateState(updateState, true);
    return;
  }

  manualUpdateCheckPending = true;
  updatePanelDismissed = false;
  handleUpdateState({ status: "checking", message: "Checking GitHub releases..." }, true);

  try {
    const state = await window.transcriber.checkForUpdates();
    handleUpdateState(state, true);
  } catch (error) {
    handleUpdateState({ status: "error", message: error.message || "Update check failed." }, true);
  } finally {
    manualUpdateCheckPending = false;
  }
});
updatePrimaryButton.addEventListener("click", async () => {
  updatePanelDismissed = false;

  try {
    if (updateState.status === "downloaded") {
      const state = await window.transcriber.installUpdateAndRelaunch();
      handleUpdateState(state, true);
      return;
    }

    if (updateState.status === "error") {
      await window.transcriber.openUpdateRelease();
      return;
    }

    const state = await window.transcriber.downloadUpdate();
    handleUpdateState(state, true);
  } catch (error) {
    handleUpdateState({ status: "error", message: error.message || "Update action failed." }, true);
  }
});
updateLaterButton.addEventListener("click", () => {
  updatePanelDismissed = true;
  updatePanel.classList.add("hidden");
});
copyLogsButton.addEventListener("click", async () => {
  const text = logs.join("\n");
  await navigator.clipboard.writeText(text);
  appendLog("info", `Copied ${logs.length} log lines`);
});
clearLogsButton.addEventListener("click", () => {
  logs.length = 0;
  logOutput.textContent = "";
});
toggleControls.addEventListener("click", () => {
  controls.classList.add("hidden");
  restoreControls.classList.remove("hidden");
  shell.classList.add("caption-only");
  scheduleResizeToContent();

  try {
    if (!localStorage.getItem(COLLAPSE_HINT_KEY)) {
      collapseHint.classList.remove("hidden");
      localStorage.setItem(COLLAPSE_HINT_KEY, "1");
      window.setTimeout(() => collapseHint.classList.add("hidden"), 6000);
    }
  } catch {
    // Ignore storage errors.
  }
});
restoreControls.addEventListener("click", () => {
  controls.classList.remove("hidden");
  restoreControls.classList.add("hidden");
  shell.classList.remove("caption-only");
  collapseHint.classList.add("hidden");
  scheduleResizeToContent();
});
closeButton.addEventListener("click", requestClose);

bindSettingsPersistence();

if (obsTip) {
  obsTip.addEventListener("toggle", scheduleResizeToContent);
}

if (typeof ResizeObserver !== "undefined") {
  const contentResizeObserver = new ResizeObserver(scheduleResizeToContent);
  contentResizeObserver.observe(controls);
  contentResizeObserver.observe(document.querySelector(".caption-stage"));
}

const storedSettings = loadSettings();
applyStoredSettings(storedSettings);
updateModeVisibility();
setConfigDisabled(false);
setSessionState("idle");
updateEmptyState();

await loadDevices().catch((error) => setSessionState("error", error.message));
restoreDeviceSelections(storedSettings);
settingsLoaded = true;
saveSettings();
scheduleResizeToContent();

try {
  const appVersion = await window.transcriber.getVersion();
  handleUpdateState({ status: "idle", currentVersion: appVersion });
} catch {
  handleUpdateState({ status: "idle" });
}

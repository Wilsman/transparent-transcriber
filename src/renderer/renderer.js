const mode = document.querySelector("#mode");
const micDevice = document.querySelector("#micDevice");
const desktopSource = document.querySelector("#desktopSource");
const twitchUrl = document.querySelector("#twitchUrl");
const model = document.querySelector("#model");
const chunkSeconds = document.querySelector("#chunkSeconds");
const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const clearButton = document.querySelector("#clearButton");
const logsButton = document.querySelector("#logsButton");
const copyLogsButton = document.querySelector("#copyLogsButton");
const clearLogsButton = document.querySelector("#clearLogsButton");
const statusText = document.querySelector("#statusText");
const statusDot = document.querySelector("#statusDot");
const captionList = document.querySelector("#captionList");
const emptyState = document.querySelector("#emptyState");
const logPanel = document.querySelector("#logPanel");
const logOutput = document.querySelector("#logOutput");
const controls = document.querySelector("#controls");
const toggleControls = document.querySelector("#toggleControls");
const restoreControls = document.querySelector("#restoreControls");

let micStream;
let desktopStream;
let mixedStream;
let audioContext;
let sourceNode;
let processorNode;
let silentOutputNode;
let pcmFlushTimer;
let running = false;
const captions = [];
const logs = [];

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

function setStatus(message, state = "idle") {
  statusText.textContent = message;
  statusText.title = message;
  statusDot.classList.toggle("running", state === "running");
  statusDot.classList.toggle("error", state === "error");
}

function updateModeVisibility() {
  const localMode = mode.value === "local";
  document.querySelectorAll(".local-only").forEach((item) => item.classList.toggle("hidden", !localMode));
  document.querySelectorAll(".twitch-only").forEach((item) => item.classList.toggle("hidden", localMode));
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

    const firstScreen = sortedSources.find((source) => source.id.startsWith("screen:"));
    if (firstScreen) {
      desktopSource.value = firstScreen.id;
      setStatus(`Desktop audio default: ${firstScreen.name}`);
      appendLog("info", `Desktop audio default: ${firstScreen.name}`);
    } else if (sortedSources.length > 0) {
      desktopSource.value = sortedSources[0].id;
      setStatus(`Desktop source default: ${sortedSources[0].name}`);
      appendLog("info", `Desktop source default: ${sortedSources[0].name}`);
    }
  } catch (error) {
    setStatus(`Desktop sources unavailable: ${error.message}`, "error");
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

function renderCaptions() {
  captionList.innerHTML = "";
  emptyState.classList.toggle("hidden", captions.length > 0);

  for (const caption of captions.slice(-3)) {
    const item = document.createElement("article");
    item.className = "caption";

    const text = document.createElement("p");
    text.className = "text";
    text.textContent = caption.text;
    item.append(text);

    if (caption.translation) {
      const translation = document.createElement("p");
      translation.className = "translation";
      translation.textContent = caption.translation;
      item.append(translation);
    }

    const meta = document.createElement("p");
    meta.className = "meta";
    const language = caption.language ? caption.language.toUpperCase() : "AUTO";
    meta.textContent = caption.probability ? `${language} ${Math.round(caption.probability * 100)}%` : language;
    item.append(meta);

    captionList.append(item);
  }
}

async function start() {
  if (running) return;

  captions.length = 0;
  renderCaptions();
  appendLog("info", `Starting ${mode.value} mode with ${model.value}, ${chunkSeconds.value}s chunks`);
  running = true;
  startButton.disabled = true;
  stopButton.disabled = false;
  setStatus("Starting worker...", "running");

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
    setStatus("Opening audio sources...", "running");
    await startLocalCapture();
    setStatus("Listening...", "running");
  } else {
    setStatus("Opening Twitch stream...", "running");
  }
}

async function stop() {
  running = false;
  stopLocalCapture();
  appendLog("info", "Stopping worker");
  await window.transcriber.stop();
  startButton.disabled = false;
  stopButton.disabled = true;
  setStatus("Stopped");
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
    captions.push(event);
    while (captions.length > 30) captions.shift();
    renderCaptions();
    setStatus("Caption received", "running");
    return;
  }

  if (event.type === "error") {
    console.error(event);
    setStatus(event.message || "Worker error", "error");
    return;
  }

  if (event.type === "log") {
    console.log(event.message || "");
    setStatus(event.message || "Worker log", "error");
    return;
  }

  if (event.type === "status") {
    setStatus(event.message || event.status || "Working", running ? "running" : "idle");
  }
});

mode.addEventListener("change", updateModeVisibility);
startButton.addEventListener("click", () => start().catch(async (error) => {
  running = false;
  stopLocalCapture();
  await window.transcriber.stop();
  startButton.disabled = false;
  stopButton.disabled = true;
  setStatus(error.message, "error");
}));
stopButton.addEventListener("click", () => stop().catch((error) => setStatus(error.message, "error")));
clearButton.addEventListener("click", () => {
  captions.length = 0;
  renderCaptions();
  appendLog("info", "Captions cleared");
});
logsButton.addEventListener("click", () => {
  const visible = logPanel.classList.toggle("hidden");
  logsButton.textContent = visible ? "Logs" : "Hide logs";
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
});
restoreControls.addEventListener("click", () => {
  controls.classList.remove("hidden");
  restoreControls.classList.add("hidden");
});

await loadDevices().catch((error) => setStatus(error.message, "error"));
updateModeVisibility();

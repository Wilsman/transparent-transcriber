const { spawn } = require("node:child_process");
const path = require("node:path");
const { resolvePython } = require("./python-env.cjs");

const rootDir = path.resolve(__dirname, "..");
const python = resolvePython(rootDir);

const args = [
  "-m",
  "PyInstaller",
  "--clean",
  "--onefile",
  "--name",
  "transcriber-worker",
  "--collect-all",
  "streamlink",
  "--collect-all",
  "faster_whisper",
  "worker/transcriber_worker.py"
];

const child = spawn(python, args, {
  cwd: rootDir,
  stdio: "inherit",
  env: {
    ...process.env,
    PYTHON: python
  },
  windowsHide: true
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

const fs = require("node:fs");
const path = require("node:path");

function resolvePython(rootDir) {
  if (process.env.PYTHON) return process.env.PYTHON;

  const windowsVenvPython = path.join(rootDir, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(windowsVenvPython)) return windowsVenvPython;

  const posixVenvPython = path.join(rootDir, ".venv", "bin", "python");
  if (fs.existsSync(posixVenvPython)) return posixVenvPython;

  return process.platform === "win32" ? "python" : "python3";
}

module.exports = {
  resolvePython
};

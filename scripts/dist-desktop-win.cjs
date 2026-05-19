const { spawn } = require("node:child_process");
const path = require("node:path");
const { resolvePython } = require("./python-env.cjs");

const rootDir = path.resolve(__dirname, "..");
const python = resolvePython(rootDir);
const env = {
  ...process.env,
  PYTHON: python
};

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      env,
      windowsHide: true
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} stopped by ${signal}`));
        return;
      }
      if (code) {
        reject(new Error(`${command} exited with code ${code}`));
        return;
      }
      resolve();
    });

    child.on("error", reject);
  });
}

async function main() {
  await run(process.execPath, ["scripts/build-worker-win.cjs"]);
  await run(process.execPath, [require.resolve("electron-builder/cli.js"), "--win"]);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const androidDirectory = path.resolve(__dirname, "..", "android");
const isWindows = process.platform === "win32";
const command = isWindows ? process.env.ComSpec || "cmd.exe" : "./gradlew";
const args = isWindows ? ["/d", "/s", "/c", "gradlew.bat assembleDebug"] : ["assembleDebug"];
const result = spawnSync(command, args, {
  cwd: androidDirectory,
  env: process.env,
  stdio: "inherit",
  windowsHide: true
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);

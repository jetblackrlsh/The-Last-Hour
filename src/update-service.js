const crypto = require("node:crypto");
const { createReadStream } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const LATEST_RELEASE_URL = "https://api.github.com/repos/jetblackrlsh/The-Last-Hour/releases/latest";

function versionParts(value) {
  return String(value || "0").replace(/^v/i, "").split(/[.-]/).slice(0, 3).map((part) => Number(part) || 0);
}

function isNewerVersion(latest, current) {
  const latestParts = versionParts(latest);
  const currentParts = versionParts(current);
  for (let index = 0; index < 3; index += 1) {
    if (latestParts[index] > currentParts[index]) return true;
    if (latestParts[index] < currentParts[index]) return false;
  }
  return false;
}

function pickReleaseAsset(assets, platform, arch) {
  const items = Array.isArray(assets) ? assets : [];
  if (platform === "darwin") {
    return items.find((asset) => {
      const name = String(asset.name || "").toLowerCase();
      return name.endsWith(".zip") && name.includes("mac") && name.includes(arch === "arm64" ? "arm64" : "x64");
    });
  }
  if (platform === "win32") {
    return items.find((asset) => {
      const name = String(asset.name || "").toLowerCase();
      return name.endsWith(".exe") && name.includes("setup");
    }) || items.find((asset) => String(asset.name || "").toLowerCase().endsWith(".exe"));
  }
  return undefined;
}

function releaseVersion(release) {
  return String(release?.tag_name || release?.name || "").replace(/^v/i, "").trim();
}

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function verifyDigest(filePath, digest) {
  if (!/^sha256:[a-f0-9]{64}$/i.test(String(digest || ""))) {
    throw new Error("The release is missing its SHA-256 verification digest.");
  }
  const actual = await sha256(filePath);
  const expected = digest.slice("sha256:".length).toLowerCase();
  if (actual !== expected) throw new Error("The downloaded update failed its SHA-256 verification.");
}

async function downloadAsset(netFetch, asset, destination, onProgress) {
  const response = await netFetch(asset.browser_download_url, {
    headers: { "User-Agent": "The-Last-Hour-Updater", Accept: "application/octet-stream" }
  });
  if (!response.ok || !response.body) throw new Error(`Update download failed (${response.status}).`);
  const total = Number(response.headers.get("content-length")) || Number(asset.size) || 0;
  const file = await fs.open(destination, "w");
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
        offset += bytesWritten;
      }
      received += value.byteLength;
      onProgress?.({ phase: "downloading", received, total, percent: total ? Math.round((received / total) * 100) : 0 });
    }
  } finally {
    await file.close();
  }
}

async function findAppBundle(directory, depth = 0) {
  if (depth > 2) return "";
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.name.endsWith(".app")) return fullPath;
    const nested = await findAppBundle(fullPath, depth + 1);
    if (nested) return nested;
  }
  return "";
}

async function plistValue(appBundle, key) {
  const plistPath = path.join(appBundle, "Contents", "Info.plist");
  const { stdout } = await execFileAsync("/usr/libexec/PlistBuddy", ["-c", `Print:${key}`, plistPath]);
  return stdout.trim();
}

function macBundleFromExecutable(executablePath) {
  let current = executablePath;
  while (current && current !== path.dirname(current)) {
    if (current.endsWith(".app")) return current;
    current = path.dirname(current);
  }
  return "";
}

const MAC_INSTALL_SCRIPT = [
  'pid="$1"',
  'new_app="$2"',
  'target_app="$3"',
  'backup_app="${target_app}.update-backup"',
  'while kill -0 "$pid" 2>/dev/null; do sleep 0.25; done',
  'if [ -e "$backup_app" ]; then /bin/rm -rf "$backup_app"; fi',
  'if /bin/mv "$target_app" "$backup_app" && /bin/mv "$new_app" "$target_app"; then',
  '  /bin/rm -rf "$backup_app"',
  '  /usr/bin/open "$target_app"',
  'else',
  '  if [ ! -e "$target_app" ] && [ -e "$backup_app" ]; then /bin/mv "$backup_app" "$target_app"; fi',
  '  /usr/bin/open "$target_app"',
  'fi'
].join("\n");

class DesktopUpdateService {
  constructor(electronApp, netFetch, options = {}) {
    this.app = electronApp;
    this.netFetch = netFetch;
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.spawn = options.spawn || spawn;
  }

  async latest() {
    const response = await this.netFetch(LATEST_RELEASE_URL, {
      headers: { "User-Agent": "The-Last-Hour-Updater", Accept: "application/vnd.github+json" }
    });
    if (!response.ok) throw new Error(`Could not check GitHub for updates (${response.status}).`);
    const release = await response.json();
    const latestVersion = releaseVersion(release);
    const asset = pickReleaseAsset(release.assets, this.platform, this.arch);
    return {
      currentVersion: this.app.getVersion(),
      latestVersion,
      available: isNewerVersion(latestVersion, this.app.getVersion()),
      releaseUrl: release.html_url,
      asset,
      release
    };
  }

  async downloadAndInstall(onProgress) {
    if (!this.app.isPackaged) throw new Error("Updates can only be installed from a packaged copy of The Last Hour.");
    const latest = await this.latest();
    if (!latest.available) return { ...latest, installing: false };
    if (!latest.asset) throw new Error(`No ${this.platform} ${this.arch} installer is attached to the latest release.`);

    const updateDirectory = await fs.mkdtemp(path.join(this.app.getPath("temp"), "the-last-hour-update-"));
    const fileName = path.basename(new URL(latest.asset.browser_download_url).pathname);
    const downloadPath = path.join(updateDirectory, fileName);
    onProgress?.({ phase: "starting", latestVersion: latest.latestVersion, percent: 0 });
    await downloadAsset(this.netFetch, latest.asset, downloadPath, onProgress);
    onProgress?.({ phase: "verifying", percent: 100 });
    await verifyDigest(downloadPath, latest.asset.digest);

    if (this.platform === "darwin") {
      const extractDirectory = path.join(updateDirectory, "extracted");
      await fs.mkdir(extractDirectory);
      onProgress?.({ phase: "preparing", percent: 100 });
      await execFileAsync("/usr/bin/ditto", ["-x", "-k", downloadPath, extractDirectory]);
      const newApp = await findAppBundle(extractDirectory);
      if (!newApp) throw new Error("The macOS update archive did not contain an application.");
      const [bundleId, bundleVersion] = await Promise.all([
        plistValue(newApp, "CFBundleIdentifier"),
        plistValue(newApp, "CFBundleShortVersionString")
      ]);
      if (bundleId !== "com.jetblackrlsh.thelasthour" || bundleVersion !== latest.latestVersion) {
        throw new Error("The macOS update does not match The Last Hour release metadata.");
      }
      const targetApp = macBundleFromExecutable(this.app.getPath("exe"));
      if (!targetApp) throw new Error("Could not locate the installed macOS application bundle.");
      this.spawn("/bin/sh", ["-c", MAC_INSTALL_SCRIPT, "the-last-hour-updater", String(process.pid), newApp, targetApp], {
        detached: true,
        stdio: "ignore"
      }).unref();
    } else if (this.platform === "win32") {
      this.spawn(downloadPath, ["/S", "--updated", "--force-run"], {
        detached: true,
        stdio: "ignore",
        windowsHide: false
      }).unref();
    } else {
      throw new Error(`Automatic installation is not supported on ${this.platform}.`);
    }

    onProgress?.({ phase: "installing", percent: 100 });
    setTimeout(() => this.app.quit(), 350);
    return { ...latest, installing: true };
  }
}

module.exports = {
  DesktopUpdateService,
  LATEST_RELEASE_URL,
  MAC_INSTALL_SCRIPT,
  downloadAsset,
  isNewerVersion,
  macBundleFromExecutable,
  pickReleaseAsset,
  releaseVersion,
  verifyDigest,
  versionParts
};

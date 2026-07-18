const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, dialog, ipcMain, net, shell } = require("electron");
const { CodexSummaryService } = require("./src/codex-service");
const { FeedService } = require("./src/feed-service");
const { DesktopUpdateService } = require("./src/update-service");
const { WeatherService } = require("./src/weather-service");

let mainWindow;
let feedService;
let summaryService;
let updateService;
let weatherService;
let speechProcess;

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function feedAsRss(feed) {
  const items = (feed.items || []).map((item) => `
    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <guid isPermaLink="false">${escapeXml(item.id)}</guid>
      <pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate>
      <source>${escapeXml(item.source)}</source>
      <category>${escapeXml(item.topic)}</category>
    </item>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>The Last Hour — Local Export</title>
  <description>Locally refreshed Google News stories from the past 24 hours.</description>
  <lastBuildDate>${new Date(feed.generatedAt).toUTCString()}</lastBuildDate>${items}
</channel></rss>`;
}

function createWindow() {
  const macWindowOptions = process.platform === "darwin"
    ? {
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 20, y: 18 }
      }
    : {};

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    ...macWindowOptions,
    backgroundColor: "#05040b",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
      if (url.startsWith("https://")) shell.openExternal(url);
    }
  });
}

function sendToRenderer(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
}

function stopSpeech() {
  if (!speechProcess) return false;
  speechProcess.kill();
  speechProcess = undefined;
  sendToRenderer("speech:state", { speaking: false });
  return true;
}

function speakText(text) {
  stopSpeech();
  const safeText = String(text || "").trim().slice(0, 24_000);
  if (!safeText) throw new Error("There is no summary to read aloud.");

  if (process.platform === "darwin") {
    speechProcess = spawn("/usr/bin/say", ["-f", "-"], { stdio: ["pipe", "ignore", "ignore"] });
  } else if (process.platform === "win32") {
    const script = [
      "$text = [Console]::In.ReadToEnd()",
      "Add-Type -AssemblyName System.Speech",
      "$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "$speaker.Speak($text)"
    ].join("; ");
    speechProcess = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true
    });
  } else {
    throw new Error("Read aloud is currently supported on macOS and Windows.");
  }

  const activeProcess = speechProcess;
  activeProcess.once("error", (error) => {
    if (speechProcess === activeProcess) speechProcess = undefined;
    sendToRenderer("speech:state", { speaking: false, error: error.message });
  });
  activeProcess.once("close", () => {
    if (speechProcess === activeProcess) speechProcess = undefined;
    sendToRenderer("speech:state", { speaking: false });
  });
  activeProcess.stdin.on("error", () => {});
  activeProcess.stdin.end(safeText);
  sendToRenderer("speech:state", { speaking: true });
  return true;
}

function registerIpc() {
  ipcMain.handle("app:info", async () => {
    const codex = await summaryService.availability();
    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
      codexAvailable: codex.available
    };
  });
  ipcMain.handle("feeds:snapshot", () => feedService.snapshot());
  ipcMain.handle("feeds:refresh-all", (_event, options) => feedService.refreshAll(options));
  ipcMain.handle("feeds:refresh-topic", (_event, topic, options) => feedService.refreshTopic(topic, options));
  ipcMain.handle("shell:open-external", (_event, url) => {
    if (typeof url === "string" && url.startsWith("https://")) return shell.openExternal(url);
    return false;
  });
  ipcMain.handle("story:summarize", (_event, story) => summaryService.summarize(story));
  ipcMain.handle("speech:speak", (_event, text) => speakText(text));
  ipcMain.handle("speech:stop", () => stopSpeech());
  ipcMain.handle("update:check", () => updateService.latest());
  ipcMain.handle("update:install", () => updateService.downloadAndInstall((progress) => {
    sendToRenderer("update:progress", progress);
  }));
  ipcMain.handle("weather:current", (_event, force = false) => weatherService.current(Boolean(force)));
  ipcMain.handle("feed:export", async (_event, format, feed) => {
    const extension = format === "rss" ? "xml" : "json";
    const result = await dialog.showSaveDialog(mainWindow, {
      title: `Export ${format.toUpperCase()} Feed`,
      defaultPath: `the-last-hour-${feed.mode || "feed"}.${extension}`,
      filters: [{ name: format === "rss" ? "RSS/XML" : "JSON", extensions: [extension] }]
    });
    if (result.canceled || !result.filePath) return { saved: false };
    const content = format === "rss" ? feedAsRss(feed) : JSON.stringify(feed, null, 2);
    await fs.writeFile(result.filePath, content, "utf8");
    return { saved: true, path: result.filePath };
  });
  feedService.on("progress", (progress) => {
    sendToRenderer("feeds:progress", progress);
  });
}

app.whenReady().then(async () => {
  feedService = new FeedService(app.getPath("userData"));
  summaryService = new CodexSummaryService(app.getPath("userData"));
  updateService = new DesktopUpdateService(app, (...args) => net.fetch(...args));
  weatherService = new WeatherService((...args) => net.fetch(...args));
  await Promise.all([feedService.init(), summaryService.init()]);
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopSpeech();
  if (process.platform !== "darwin") app.quit();
});

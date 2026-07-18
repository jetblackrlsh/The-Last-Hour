const path = require("node:path");
const fs = require("node:fs/promises");
const { app, BrowserWindow, dialog, ipcMain, net, shell } = require("electron");
const { CodexSummaryService, publicSummaryError } = require("./src/codex-summary-service");
const { FeedService } = require("./src/feed-service");
const { DesktopUpdateService } = require("./src/update-service");
const { WeatherService } = require("./src/weather-service");

let mainWindow;
let feedService;
let summaryService;
let updateService;
let weatherService;

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

function registerIpc() {
  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged
  }));
  ipcMain.handle("feeds:snapshot", () => feedService.snapshot());
  ipcMain.handle("feeds:refresh-all", (_event, options) => feedService.refreshAll(options));
  ipcMain.handle("feeds:refresh-topic", (_event, topic, options) => feedService.refreshTopic(topic, options));
  ipcMain.handle("shell:open-external", (_event, url) => {
    if (typeof url === "string" && url.startsWith("https://")) return shell.openExternal(url);
    return false;
  });
  ipcMain.handle("story:summarize", async (_event, story) => {
    try {
      return { ok: true, summary: await summaryService.summarize(story) };
    } catch (error) {
      console.error("Codex summary failed:", error);
      return { ok: false, error: publicSummaryError(error) };
    }
  });
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
  summaryService = new CodexSummaryService({ cwd: app.getPath("temp") });
  updateService = new DesktopUpdateService(app, (...args) => net.fetch(...args));
  weatherService = new WeatherService((...args) => net.fetch(...args));
  await feedService.init();
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

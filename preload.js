const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lastHour", {
  snapshot: () => ipcRenderer.invoke("feeds:snapshot"),
  refreshAll: (options = {}) => ipcRenderer.invoke("feeds:refresh-all", options),
  refreshTopic: (topic, options = {}) => ipcRenderer.invoke("feeds:refresh-topic", topic, options),
  summarizeStory: (story) => ipcRenderer.invoke("story:summarize", story),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  exportFeed: (format, feed) => ipcRenderer.invoke("feed:export", format, feed),
  onProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("feeds:progress", listener);
    return () => ipcRenderer.removeListener("feeds:progress", listener);
  }
});

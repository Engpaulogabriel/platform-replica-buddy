const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("logAPI", {
  getAll: () => ipcRenderer.invoke("log:get-all"),
  onLine: (cb) => ipcRenderer.on("log:line", (_e, entry) => cb(entry)),
});

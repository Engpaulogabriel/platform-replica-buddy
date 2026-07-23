const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("configAPI", {
  getStatus: () => ipcRenderer.invoke("config:get-status"),
  closePort: () => ipcRenderer.invoke("config:close-port"),
  openPort: (port) => ipcRenderer.invoke("config:open-port", port),
  listPorts: () => ipcRenderer.invoke("config:list-ports"),
});

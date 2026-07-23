const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("setupAPI", {
  saveConfig: (creds) => ipcRenderer.invoke("save-config", creds),
  listPorts:  ()      => ipcRenderer.invoke("list-ports"),
});

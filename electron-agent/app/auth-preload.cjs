const { contextBridge, ipcRenderer } = require("electron");

// Janela de autenticação reutilizável (senha p/ Ver Log; email+senha p/ Reconfigurar).
// O resultado é validado no processo principal (main.cjs); esta janela só coleta.
contextBridge.exposeInMainWorld("authAPI", {
  getMode: () => ipcRenderer.invoke("auth:get-mode"),
  submit: (data) => ipcRenderer.send("auth:submit", data),
  cancel: () => ipcRenderer.send("auth:cancel"),
});

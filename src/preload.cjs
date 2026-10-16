const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("captureLab", {
  request: (op, payload) =>
    ipcRenderer.invoke("interview:request", op, payload),
  audio: (buffer) => ipcRenderer.invoke("interview:audio", buffer),
  state: () => ipcRenderer.invoke("lab:state"),
  change: (key, value) => ipcRenderer.invoke("lab:change", key, value),
  action: (name) => ipcRenderer.invoke("lab:action", name),
  subscribe: (callback) => {
    const listener = (_, value) => callback(value);
    ipcRenderer.on("lab:update", listener);
    return () => ipcRenderer.removeListener("lab:update", listener);
  },
});

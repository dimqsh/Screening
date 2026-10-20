const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("captureLab", {
  request: (op, payload) =>
    ipcRenderer.invoke("interview:request", op, payload),
  audio: (buffer) => ipcRenderer.invoke("interview:audio", buffer),
  onAudioCommand: (callback) => {
    const listener = (_, command) => callback(command);
    ipcRenderer.on("audio:command", listener);
    return () => ipcRenderer.removeListener("audio:command", listener);
  },
  onDraft: (callback) => {
    const listener = (_, value) => callback(value);
    ipcRenderer.on("draft:update", listener);
    return () => ipcRenderer.removeListener("draft:update", listener);
  },
  level: (value) => ipcRenderer.send("audio:level", value),
  onLevel: (callback) => {
    const listener = (_, value) => callback(value);
    ipcRenderer.on("audio:level-update", listener);
    return () => ipcRenderer.removeListener("audio:level-update", listener);
  },
  audioComplete: (id, error) => ipcRenderer.invoke("audio:complete", id, error),
  state: () => ipcRenderer.invoke("lab:state"),
  change: (key, value) => ipcRenderer.invoke("lab:change", key, value),
  action: (name) => ipcRenderer.invoke("lab:action", name),
  buddyMouse: (inside) => ipcRenderer.send("buddy:mouse", Boolean(inside)),
  remember: (memory) => ipcRenderer.send("buddy:memory", memory),
  keyboard: (on) => ipcRenderer.send("buddy:keyboard", Boolean(on)),
  drag: (phase) =>
    ipcRenderer.send("buddy:drag", phase === "start" ? "start" : "end"),
  onAsk: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("buddy:ask", listener);
    return () => ipcRenderer.removeListener("buddy:ask", listener);
  },
  subscribe: (callback) => {
    const listener = (_, value) => callback(value);
    ipcRenderer.on("lab:update", listener);
    return () => ipcRenderer.removeListener("lab:update", listener);
  },
});

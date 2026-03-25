const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("slidescribe", {
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  saveSession: (session) => ipcRenderer.invoke("session:save", session),
  selectPdfs: () => ipcRenderer.invoke("dialog:select-pdfs"),
  loadCompareData: (pdfPath) => ipcRenderer.invoke("compare:load", pdfPath),
  clearCache: (pdfPath) => ipcRenderer.invoke("cache:clear", pdfPath),
  startWorker: (payload) => ipcRenderer.invoke("worker:start", payload),
  stopWorker: () => ipcRenderer.invoke("worker:stop"),
  onWorkerEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("worker:event", wrapped);
    return () => ipcRenderer.removeListener("worker:event", wrapped);
  }
});

// 渲染进程桥：只暴露最小 IPC 面（invoke + 事件订阅），不开 nodeIntegration
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("harness", {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  onEvent: (cb) => {
    const f = (_e, ev) => cb(ev);
    ipcRenderer.on("ev", f);
    return () => ipcRenderer.removeListener("ev", f);
  },
});

import { contextBridge, ipcRenderer } from "electron/renderer";

contextBridge.exposeInMainWorld("electronAPI", {
  invoke: (service: string, method: string, ...args: unknown[]) =>
    ipcRenderer.invoke("invoke", service, method, ...args),

  on: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...args));
  },

  off: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.removeListener(channel, callback);
  },
});

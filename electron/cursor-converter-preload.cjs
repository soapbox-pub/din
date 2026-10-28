// Preload for the cursor converter's sandboxed window (cursorConverter.mts):
// its one channel to the main process. The page gets a single job and hands
// back a single result; there's nothing else here for it to reach.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cursorConverterHost', {
  /** @param {(job: unknown) => void} callback */
  onJob: (callback) => {
    ipcRenderer.once('cursor-converter:job', (_event, job) => callback(job));
  },
  /** @param {unknown} outcome */
  done: (outcome) => ipcRenderer.send('cursor-converter:done', outcome),
});

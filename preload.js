/* ================================================================
   Map Music – Preload Script (Main Window)
   Bridges IPC between main process and renderer
   ================================================================ */
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

contextBridge.exposeInMainWorld('electronAPI', {
    getVideoInfo: (url) => ipcRenderer.invoke('get-video-info', url),
    getLyrics: (artist, title) => ipcRenderer.invoke('get-lyrics', artist, title),
    getChords: (artist, title) => ipcRenderer.invoke('get-chords', artist, title),
    getWebviewPreloadPath: () => 'file://' + path.join(__dirname, 'webview-preload.js').replace(/\\/g, '/'),
});

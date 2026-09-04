'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Unwrap the {ok,data|error} envelope so renderer code can just await.
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || !res.ok) {
    const err = new Error(res ? res.error : 'IPC failure');
    if (res && res.kind) err.kind = res.kind;
    throw err;
  }
  return res.data;
}

function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  platform: process.platform, // 'darwin' | 'win32' | 'linux': UI wording and title-bar layout
  toggleFullscreen: () => call('window:toggleFullscreen'),
  getSettings: () => call('settings:get'),
  saveSettings: (patch) => call('settings:save', patch),
  getNotices: () => call('store:notices'),
  chooseFolder: () => call('dialog:chooseFolder'),
  getLibrary: () => call('library:get'),
  scanLibrary: (opts) => call('library:scan', opts),
  checkFile: (movieId) => call('library:checkFile', { movieId }),
  searchTmdb: (query, year) => call('tmdb:search', { query, year }),
  fixMatch: (movieId, tmdbId) => call('library:fixMatch', { movieId, tmdbId }),
  searchTv: (query, year) => call('tmdb:searchTv', { query, year }),
  fixMatchShow: (showKey, tmdbId) => call('library:fixMatchShow', { showKey, tmdbId }),
  savePosition: (movieId, position, duration) => call('playback:savePosition', { movieId, position, duration }),
  openExternal: (movieId) => call('shell:openExternal', { movieId }),
  revealInFinder: (movieId) => call('shell:revealInFinder', { movieId }),
  openUrl: (url) => call('shell:openUrl', url),
  onProgress: (cb) => on('library:progress', cb),
  onLibraryChanged: (cb) => on('library:changed', cb),
  onMoviesUpdated: (cb) => on('library:moviesUpdated', cb),
});

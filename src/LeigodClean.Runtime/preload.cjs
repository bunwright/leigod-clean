'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (method, payload = {}) => ipcRenderer.invoke('leigod-clean:invoke', method, payload);

contextBridge.exposeInMainWorld('leigodClean', Object.freeze({
  initialize: () => invoke('initialize'),
  searchGames: (query, limit = 60) => invoke('searchGames', { query, limit }),
  getGame: (gameId) => invoke('getGame', { gameId }),
  getLines: (selection) => invoke('getLines', selection),
  start: (selection) => invoke('start', selection),
  stopAcceleration: () => invoke('stopAcceleration'),
  pauseTime: () => invoke('pauseTime'),
  resumeTime: () => invoke('resumeTime'),
  showOfficial: () => invoke('showOfficial'),
  hideOfficial: () => invoke('hideOfficial'),
  getSettings: () => invoke('getSettings'),
  updateSettings: (settings) => invoke('updateSettings', settings),
  rememberSelection: (selection) => invoke('rememberSelection', selection),
  setGameAutoAcceleration: (gameId, enabled) =>
    invoke('setGameAutoAcceleration', { gameId, enabled }),
  openLogs: () => invoke('openLogs'),
  copyDiagnostics: () => invoke('copyDiagnostics'),
  onState(callback) {
    if (typeof callback !== 'function') {
      return () => {};
    }
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('leigod-clean:state', listener);
    return () => ipcRenderer.removeListener('leigod-clean:state', listener);
  },
}));

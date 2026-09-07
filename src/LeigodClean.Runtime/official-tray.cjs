'use strict';

const { EventEmitter } = require('node:events');

function installOfficialShellIsolation({
  moduleLoader,
  electron,
  log = () => {},
}) {
  if (!moduleLoader || typeof moduleLoader._load !== 'function') {
    throw new TypeError('A Node module loader is required.');
  }
  if (!electron || typeof electron.Tray !== 'function') {
    throw new TypeError('An Electron Tray constructor is required.');
  }

  class HiddenTray extends EventEmitter {
    constructor() {
      super();
      this._destroyed = false;
      log('Official tray icon suppressed');
    }

    destroy() {
      this._destroyed = true;
      this.removeAllListeners();
    }

    isDestroyed() {
      return this._destroyed;
    }

    getBounds() {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    getIgnoreDoubleClickEvents() {
      return false;
    }

    getTitle() {
      return '';
    }

    setContextMenu() { return this; }
    setImage() { return this; }
    setPressedImage() { return this; }
    setToolTip() { return this; }
    setTitle() { return this; }
    setIgnoreDoubleClickEvents() { return this; }
    displayBalloon() { return this; }
    removeBalloon() { return this; }
    focus() { return this; }
    popUpContextMenu() { return this; }
    closeContextMenu() { return this; }
  }

  const SuppressedTray = new Proxy(electron.Tray, {
    apply() {
      return new HiddenTray();
    },
    construct() {
      return new HiddenTray();
    },
  });
  const officialApp = new Proxy(electron.app, {
    get(target, property) {
      if (property === 'setAppUserModelId') {
        return () => undefined;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const officialElectron = new Proxy(electron, {
    get(target, property) {
      if (property === 'Tray') {
        return SuppressedTray;
      }
      if (property === 'app') {
        return officialApp;
      }
      return Reflect.get(target, property, target);
    },
  });
  const originalLoad = moduleLoader._load;
  function loadWithOfficialShellIsolation(request, parent, isMain) {
    if (request === 'electron' || request === 'electron/main') {
      return officialElectron;
    }
    return Reflect.apply(originalLoad, this, [request, parent, isMain]);
  }
  moduleLoader._load = loadWithOfficialShellIsolation;

  let restored = false;
  return function restore() {
    if (restored) {
      return;
    }
    restored = true;
    if (moduleLoader._load === loadWithOfficialShellIsolation) {
      moduleLoader._load = originalLoad;
    }
  };
}

module.exports = { installOfficialShellIsolation };

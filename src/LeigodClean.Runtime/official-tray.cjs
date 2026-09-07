'use strict';

const { EventEmitter } = require('node:events');

function createOfficialWindowOptions(options = {}, visible = false) {
  const source = options && typeof options === 'object' ? options : {};
  const webPreferences = {
    ...(source.webPreferences ?? {}),
    backgroundThrottling: true,
  };
  if (!visible) {
    webPreferences.paintWhenInitiallyHidden = false;
  }
  return {
    ...source,
    show: visible ? source.show : false,
    skipTaskbar: visible ? source.skipTaskbar : true,
    webPreferences,
  };
}

function installOfficialShellIsolation({
  moduleLoader,
  electron,
  shouldShowWindow = () => false,
  log = () => {},
}) {
  if (!moduleLoader || typeof moduleLoader._load !== 'function') {
    throw new TypeError('A Node module loader is required.');
  }
  if (!electron || typeof electron.Tray !== 'function' ||
    typeof electron.BrowserWindow !== 'function') {
    throw new TypeError('Electron Tray and BrowserWindow constructors are required.');
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

  function setWindowMuted(window, muted) {
    try {
      window.webContents?.setAudioMuted?.(Boolean(muted));
    } catch {
      // Optional power-saving APIs differ across supported Electron builds.
    }
  }

  function guardOfficialWindow(window, forwardReadyToShow) {
    const nativeShow = window.show?.bind(window);
    const nativeShowInactive = window.showInactive?.bind(window);
    const nativeHide = window.hide?.bind(window);
    const nativeFocus = window.focus?.bind(window);
    const nativeSetSkipTaskbar = window.setSkipTaskbar?.bind(window);
    const nativeSetOpacity = window.setOpacity?.bind(window);

    const canShow = () => shouldShowWindow() === true;
    const prepareToShow = () => {
      nativeSetSkipTaskbar?.(false);
      setWindowMuted(window, false);
      nativeSetOpacity?.(1);
    };
    const keepHidden = () => {
      nativeSetOpacity?.(0);
      nativeHide?.();
      nativeSetSkipTaskbar?.(true);
      setWindowMuted(window, true);
    };
    const defineGuard = (name, value) => {
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          writable: true,
          value,
        });
      } catch {
        // Some Electron builds expose non-configurable native methods.
      }
    };

    try {
      window.webContents?.setBackgroundThrottling?.(true);
      if (canShow()) {
        prepareToShow();
      } else {
        keepHidden();
      }
    } catch {
      // The regular browser-window-created guard remains as a fallback.
    }

    if (nativeShow) {
      defineGuard('show', () => {
        if (!canShow()) {
          keepHidden();
          return undefined;
        }
        prepareToShow();
        return nativeShow();
      });
    }
    if (nativeShowInactive) {
      defineGuard('showInactive', () => {
        if (!canShow()) {
          keepHidden();
          return undefined;
        }
        prepareToShow();
        return nativeShowInactive();
      });
    }
    if (nativeFocus) {
      defineGuard('focus', () => canShow() ? nativeFocus() : undefined);
    }
    if (nativeSetSkipTaskbar) {
      defineGuard('setSkipTaskbar', (skip) =>
        nativeSetSkipTaskbar(canShow() ? Boolean(skip) : true));
    }
    if (nativeSetOpacity) {
      defineGuard('setOpacity', (opacity) => nativeSetOpacity(canShow() ? opacity : 0));
    }
    if (nativeHide) {
      defineGuard('hide', () => {
        keepHidden();
        return undefined;
      });
    }
    if (forwardReadyToShow && typeof window.once === 'function' &&
      typeof window.emit === 'function' && typeof window.webContents?.once === 'function') {
      let readyToShowObserved = false;
      window.once('ready-to-show', () => {
        readyToShowObserved = true;
      });
      window.webContents.once('did-finish-load', () => {
        if (!readyToShowObserved && window.isDestroyed?.() !== true) {
          window.emit('ready-to-show');
        }
      });
    }
    log('Official window created in background rendering mode');
    return window;
  }

  const SuppressedTray = new Proxy(electron.Tray, {
    apply() {
      return new HiddenTray();
    },
    construct() {
      return new HiddenTray();
    },
  });
  const SuppressedBrowserWindow = new Proxy(electron.BrowserWindow, {
    apply(target, _thisArg, argumentsList) {
      const visible = shouldShowWindow() === true;
      const options = createOfficialWindowOptions(argumentsList[0], visible);
      return guardOfficialWindow(Reflect.construct(target, [options], target), !visible);
    },
    construct(target, argumentsList) {
      const visible = shouldShowWindow() === true;
      const options = createOfficialWindowOptions(argumentsList[0], visible);
      return guardOfficialWindow(Reflect.construct(target, [options], target), !visible);
    },
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
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
      if (property === 'BrowserWindow') {
        return SuppressedBrowserWindow;
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

module.exports = {
  createOfficialWindowOptions,
  installOfficialShellIsolation,
};

'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const startLeigodClean = require('../main.cjs');

test('renderer initialization preserves a ready official state while its window stays hidden', async () => {
  const singletonKey = Symbol.for('dev.leigodclean.runtime');
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'leigodclean-ready-'));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const previousResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  const bridgePath = require.resolve('../official-bridge.cjs');
  const previousBridgeModule = require.cache[bridgePath];
  let cleanWindow = null;
  let officialWindow = null;
  let invokeHandler = null;
  let nextWindowId = 0;
  let timeStatus = 'timeing';
  let idlePauseCalls = 0;

  class FakeOfficialBridge {
    async install() {}
    invalidate() {}
    async call(method) {
      if (method === 'state') {
        return {
          ready: true,
          isLogin: true,
          accStatus: 'normal',
          gameId: 0,
          timeStatus,
          totalTimeLeft: 7200,
        };
      }
      if (method === 'pause') {
        idlePauseCalls += 1;
        timeStatus = 'pause';
        return {
          ready: true,
          isLogin: true,
          accStatus: 'normal',
          gameId: 0,
          timeStatus,
          totalTimeLeft: 7200,
        };
      }
      if (method === 'recentGames' || method === 'autoCandidates') {
        return [];
      }
      if (method === 'watchState') {
        return new Promise(() => {});
      }
      throw new Error(`Unexpected bridge method: ${method}`);
    }
  }

  const app = new EventEmitter();
  app.whenReady = () => Promise.resolve();
  app.isReady = () => true;
  app.setAppUserModelId = () => {};
  app.setLoginItemSettings = () => {};
  app.exit = () => {};

  class BrowserWindow extends EventEmitter {
    constructor(options = {}) {
      super();
      this.id = ++nextWindowId;
      this.options = options;
      this.title = String(options.title ?? '');
      this.destroyed = false;
      this.visible = Boolean(options.show);
      this.opacity = 1;
      this.skipTaskbar = false;
      this.backgroundThrottling = null;
      this.webContents = new EventEmitter();
      this.webContents.id = this.id;
      this.webContents.url = '';
      this.webContents.session = { setPermissionRequestHandler() {} };
      this.webContents.isDestroyed = () => false;
      this.webContents.getURL = () => this.webContents.url;
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.setAudioMuted = () => {};
      this.webContents.setBackgroundThrottling = (allowed) => {
        this.backgroundThrottling = allowed;
      };
      this.webContents.send = () => {};
      if (this.title === 'LeigodClean') {
        cleanWindow = this;
      }
    }

    getTitle() { return this.title; }
    getBounds() { return { width: 1000, height: 700 }; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    setIcon() {}
    setTitleBarOverlay() {}
    setOpacity(value) { this.opacity = value; }
    setSkipTaskbar(value) { this.skipTaskbar = value; }
    show() { this.visible = true; this.emit('show'); }
    hide() { this.visible = false; }
    focus() {}
    restore() {}
    destroy() { this.destroyed = true; this.emit('closed'); }
    loadFile(filePath) {
      this.webContents.url = filePath;
      queueMicrotask(() => this.emit('ready-to-show'));
      return Promise.resolve();
    }
  }

  class Tray extends EventEmitter {
    setIgnoreDoubleClickEvents() {}
    setImage() {}
    setToolTip() {}
    popUpContextMenu() {}
    destroy() {}
  }

  const bitmap = {
    isEmpty: () => false,
    resize: () => ({ toBitmap: () => Buffer.alloc(20 * 20 * 4) }),
  };
  const electron = {
    app,
    BrowserWindow,
    clipboard: { writeText() {} },
    dialog: { showErrorBox() {}, async showMessageBox() { return { response: 1 }; } },
    ipcMain: {
      handle(channel, listener) {
        if (channel === 'leigod-clean:invoke') {
          invokeHandler = listener;
        }
      },
    },
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: {
      createFromPath: () => bitmap,
      createFromBitmap: () => bitmap,
    },
    Notification: { isSupported: () => false },
    shell: { showItemInFolder() {} },
    Tray,
  };
  const officialRequire = (request) => {
    if (request === 'electron') {
      return electron;
    }
    if (request === './main.jsc') {
      queueMicrotask(() => {
        officialWindow = new BrowserWindow({ title: 'LeiGod', show: true });
        officialWindow.webContents.url = 'file:///resources/renderer.asar/index.html';
        app.emit('browser-window-created', {}, officialWindow);
        queueMicrotask(() => officialWindow.webContents.emit('did-finish-load'));
      });
    }
    return {};
  };

  try {
    require.cache[bridgePath] = {
      id: bridgePath,
      filename: bridgePath,
      loaded: true,
      exports: { OfficialBridge: FakeOfficialBridge },
      children: [],
      paths: [],
    };
    delete globalThis[singletonKey];
    process.env.LOCALAPPDATA = dataRoot;
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: path.join(__dirname, 'resources'),
    });

    startLeigodClean(officialRequire);
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(cleanWindow);
    assert.ok(officialWindow);
    assert.equal(typeof invokeHandler, 'function');
    assert.equal(officialWindow.visible, false);
    assert.equal(officialWindow.opacity, 0);
    assert.equal(officialWindow.skipTaskbar, true);
    assert.equal(officialWindow.backgroundThrottling, false);

    const result = await invokeHandler(
      { sender: cleanWindow.webContents },
      'initialize',
      {},
    );
    assert.equal(result.ok, true);
    assert.equal(result.data.client.ready, true);
    assert.equal(result.data.client.isLogin, true);
    assert.equal(officialWindow.backgroundThrottling, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(idlePauseCalls, 1);
  } finally {
    delete globalThis[singletonKey];
    if (previousBridgeModule) {
      require.cache[bridgePath] = previousBridgeModule;
    } else {
      delete require.cache[bridgePath];
    }
    if (previousLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = previousLocalAppData;
    }
    if (previousResourcesPath) {
      Object.defineProperty(process, 'resourcesPath', previousResourcesPath);
    } else {
      delete process.resourcesPath;
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

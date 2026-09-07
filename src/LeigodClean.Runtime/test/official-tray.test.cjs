'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createOfficialWindowOptions,
  installOfficialShellIsolation,
} = require('../official-tray.cjs');

function createHarness() {
  let nativeTrayCount = 0;
  let identityChanges = 0;
  const windows = [];
  class NativeTray {
    constructor() {
      nativeTrayCount += 1;
    }
  }
  class NativeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = Boolean(options.show);
      this.skipTaskbar = Boolean(options.skipTaskbar);
      this.muted = false;
      this.backgroundThrottling = null;
      this.focused = false;
      this.webContents = new EventEmitter();
      this.webContents.setAudioMuted = (muted) => { this.muted = muted; };
      this.webContents.setBackgroundThrottling = (allowed) => {
        this.backgroundThrottling = allowed;
      };
      windows.push(this);
    }

    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    setSkipTaskbar(skip) { this.skipTaskbar = skip; }
  }
  NativeBrowserWindow.getAllWindows = () => [...windows];
  const electron = {
    app: {
      name: 'LeiGod',
      setAppUserModelId() { identityChanges += 1; },
    },
    BrowserWindow: NativeBrowserWindow,
    Tray: NativeTray,
  };
  const fallback = { name: 'fallback' };
  const originalLoad = (request) => request === 'electron' ? electron : fallback;
  const moduleLoader = { _load: originalLoad };
  const messages = [];
  return {
    electron,
    fallback,
    moduleLoader,
    originalLoad,
    messages,
    identityChanges: () => identityChanges,
    nativeTrayCount: () => nativeTrayCount,
  };
}

test('hidden official windows are created without taskbar or initial painting', () => {
  const options = createOfficialWindowOptions({
    show: true,
    skipTaskbar: false,
    webPreferences: { sandbox: true, backgroundThrottling: false },
  });
  assert.equal(options.show, false);
  assert.equal(options.skipTaskbar, true);
  assert.deepEqual(options.webPreferences, {
    sandbox: true,
    backgroundThrottling: true,
    paintWhenInitiallyHidden: false,
  });
});

test('suppresses the official shell while preserving an explicitly opened fallback window', () => {
  const harness = createHarness();
  let visible = false;
  const restore = installOfficialShellIsolation({
    moduleLoader: harness.moduleLoader,
    electron: harness.electron,
    shouldShowWindow: () => visible,
    log: (message) => harness.messages.push(message),
  });

  const intercepted = harness.moduleLoader._load('electron');
  assert.equal(intercepted.app.name, 'LeiGod');
  intercepted.app.setAppUserModelId('com.leigod.official');
  assert.equal(harness.identityChanges(), 0);

  const tray = new intercepted.Tray('icon');
  assert.equal(harness.nativeTrayCount(), 0);
  assert.equal(tray.isDestroyed(), false);
  assert.equal(tray.setToolTip('LeiGod'), tray);
  assert.deepEqual(tray.getBounds(), { x: 0, y: 0, width: 0, height: 0 });

  const window = new intercepted.BrowserWindow({
    show: true,
    webPreferences: { sandbox: false },
  });
  assert.equal(window.options.show, false);
  assert.equal(window.options.skipTaskbar, true);
  assert.equal(window.options.webPreferences.paintWhenInitiallyHidden, false);
  assert.equal(window.options.webPreferences.backgroundThrottling, true);
  assert.equal(window.backgroundThrottling, true);
  assert.equal(window.muted, true);
  window.show();
  window.focus();
  window.setSkipTaskbar(false);
  assert.equal(window.visible, false);
  assert.equal(window.focused, false);
  assert.equal(window.skipTaskbar, true);

  let readyToShowCount = 0;
  window.on('ready-to-show', () => { readyToShowCount += 1; });
  window.webContents.emit('did-finish-load');
  window.webContents.emit('did-finish-load');
  assert.equal(readyToShowCount, 1);
  assert.equal(window.visible, false);

  visible = true;
  window.show();
  window.focus();
  window.setSkipTaskbar(false);
  assert.equal(window.visible, true);
  assert.equal(window.focused, true);
  assert.equal(window.skipTaskbar, false);
  assert.equal(window.muted, false);
  window.hide();
  assert.equal(window.visible, false);
  assert.equal(window.muted, true);

  assert.equal(intercepted.BrowserWindow.getAllWindows().length, 1);
  assert.equal(harness.moduleLoader._load('node:path'), harness.fallback);
  assert.deepEqual(harness.messages, [
    'Official tray icon suppressed',
    'Official window created in background rendering mode',
  ]);

  tray.destroy();
  assert.equal(tray.isDestroyed(), true);
  restore();
  assert.equal(harness.moduleLoader._load, harness.originalLoad);
  assert.equal(harness.moduleLoader._load('electron').Tray, harness.electron.Tray);
});

test('restore is idempotent and does not overwrite a later loader hook', () => {
  const harness = createHarness();
  const restore = installOfficialShellIsolation({
    moduleLoader: harness.moduleLoader,
    electron: harness.electron,
  });
  const laterHook = () => 'later';
  harness.moduleLoader._load = laterHook;

  restore();
  restore();
  assert.equal(harness.moduleLoader._load, laterHook);
});

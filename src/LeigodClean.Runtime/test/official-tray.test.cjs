'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const { installOfficialShellIsolation } = require('../official-tray.cjs');

function createHarness() {
  let nativeTrayCount = 0;
  let identityChanges = 0;
  class NativeTray {
    constructor() {
      nativeTrayCount += 1;
    }
  }
  class NativeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
    }
  }
  const electron = {
    app: {
      name: 'LeiGod',
      setAppUserModelId() { identityChanges += 1; },
      setToastActivatorCLSID() { identityChanges += 1; },
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

test('suppresses the official tray and identity without replacing BrowserWindow', () => {
  const harness = createHarness();
  const restore = installOfficialShellIsolation({
    moduleLoader: harness.moduleLoader,
    electron: harness.electron,
    log: (message) => harness.messages.push(message),
  });

  const intercepted = harness.moduleLoader._load('electron');
  assert.equal(intercepted.app.name, 'LeiGod');
  intercepted.app.setAppUserModelId('com.leigod.official');
  intercepted.app.setToastActivatorCLSID('{00000000-0000-0000-0000-000000000000}');
  assert.equal(harness.identityChanges(), 0);

  const tray = new intercepted.Tray('icon');
  assert.equal(harness.nativeTrayCount(), 0);
  assert.equal(tray.isDestroyed(), false);
  assert.equal(tray.setToolTip('LeiGod'), tray);
  assert.deepEqual(tray.getBounds(), { x: 0, y: 0, width: 0, height: 0 });

  assert.equal(intercepted.BrowserWindow, harness.electron.BrowserWindow);
  const options = {
    show: true,
    skipTaskbar: false,
    webPreferences: { sandbox: false, backgroundThrottling: false },
  };
  const window = new intercepted.BrowserWindow(options);
  assert.equal(window.options, options);
  assert.equal(window.options.show, true);
  assert.equal(window.options.skipTaskbar, false);
  assert.equal(window.options.webPreferences.backgroundThrottling, false);
  assert.equal(Object.hasOwn(window.options.webPreferences, 'paintWhenInitiallyHidden'), false);

  let readyToShowCount = 0;
  window.on('ready-to-show', () => { readyToShowCount += 1; });
  window.emit('ready-to-show');
  assert.equal(readyToShowCount, 1);

  assert.equal(harness.moduleLoader._load('node:path'), harness.fallback);
  assert.deepEqual(harness.messages, ['Official tray icon suppressed']);

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

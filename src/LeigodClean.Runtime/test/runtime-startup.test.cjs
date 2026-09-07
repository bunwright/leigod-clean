'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const startLeigodClean = require('../main.cjs');

test('main runtime loads first-run settings before starting the official client', () => {
  const singletonKey = Symbol.for('dev.leigodclean.runtime');
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'leigodclean-startup-'));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const previousResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  const officialCalls = [];
  const app = new EventEmitter();
  app.whenReady = () => new Promise(() => {});
  app.setAppUserModelId = () => {};

  class BrowserWindow {}
  class Tray {}

  const electron = {
    app,
    BrowserWindow,
    clipboard: {},
    dialog: { showErrorBox() {} },
    ipcMain: { handle() {} },
    Menu: {},
    nativeImage: {
      createFromPath() {
        return { isEmpty: () => false };
      },
    },
    Notification: {},
    shell: {},
    Tray,
  };
  const officialRequire = (request) => {
    officialCalls.push(request);
    return request === 'electron' ? electron : {};
  };

  try {
    delete globalThis[singletonKey];
    process.env.LOCALAPPDATA = dataRoot;
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: path.join(__dirname, 'resources'),
    });
    assert.doesNotThrow(() => startLeigodClean(officialRequire));
    assert.deepEqual(officialCalls, ['electron', 'bytenode', './main.jsc']);
  } finally {
    delete globalThis[singletonKey];
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

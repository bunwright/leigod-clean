'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installOfficialTraySuppression } = require('../official-tray.cjs');

function createHarness() {
  let nativeTrayCount = 0;
  class NativeTray {
    constructor() {
      nativeTrayCount += 1;
    }
  }
  const electron = { app: { name: 'LeiGod' }, Tray: NativeTray };
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
    nativeTrayCount: () => nativeTrayCount,
  };
}

test('suppresses only the official Electron Tray while the loader hook is installed', () => {
  const harness = createHarness();
  const restore = installOfficialTraySuppression({
    moduleLoader: harness.moduleLoader,
    electron: harness.electron,
    log: (message) => harness.messages.push(message),
  });

  const intercepted = harness.moduleLoader._load('electron');
  assert.equal(intercepted.app, harness.electron.app);
  assert.notEqual(intercepted.Tray, harness.electron.Tray);
  const tray = new intercepted.Tray('icon');
  assert.equal(harness.nativeTrayCount(), 0);
  assert.equal(tray.isDestroyed(), false);
  assert.equal(tray.setToolTip('LeiGod'), tray);
  assert.deepEqual(tray.getBounds(), { x: 0, y: 0, width: 0, height: 0 });
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
  const restore = installOfficialTraySuppression({
    moduleLoader: harness.moduleLoader,
    electron: harness.electron,
  });
  const laterHook = () => 'later';
  harness.moduleLoader._load = laterHook;

  restore();
  restore();
  assert.equal(harness.moduleLoader._load, laterHook);
});

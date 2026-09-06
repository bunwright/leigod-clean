'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OfficialBridge, installOfficialBridge, rankGames } = require('../official-bridge.cjs');

function createHarness(execute = async () => true) {
  let calls = 0;
  const webContents = {
    id: 7,
    isDestroyed: () => false,
    executeJavaScript: async (...args) => {
      calls += 1;
      return execute(...args);
    },
  };
  const window = { isDestroyed: () => false, webContents };
  return {
    bridge: new OfficialBridge(() => window),
    window,
    get calls() { return calls; },
  };
}

test('installs the official bridge once per renderer lifecycle', async () => {
  const harness = createHarness();
  await harness.bridge.install();
  await harness.bridge.install();
  assert.equal(harness.calls, 1);

  harness.bridge.invalidate(harness.window);
  await harness.bridge.install();
  assert.equal(harness.calls, 2);
});

test('coalesces concurrent bridge installation', async () => {
  let resolveInstallation;
  const pending = new Promise((resolve) => { resolveInstallation = resolve; });
  const harness = createHarness(() => pending);
  const first = harness.bridge.install();
  const second = harness.bridge.install();
  resolveInstallation(true);
  await Promise.all([first, second]);
  assert.equal(harness.calls, 1);
});

test('ranks the active game, recent games, and local games before recommendations', () => {
  const games = [
    { id: 1, hot: 10, sort_index: 50 },
    { id: 2, hot: 0, sort_index: 20 },
    { id: 3, hot: 100, sort_index: 1 },
    { id: 4, hot: 0, sort_index: 10 },
    { id: 5, hot: 20, sort_index: 30 },
    { id: 6, hot: 20, sort_index: 5 },
  ];

  const ranked = rankGames(games, {
    activeGameId: 4,
    recentGameIds: [2, 1],
    localGameIds: [{ id: 3 }],
  });

  assert.deepEqual(ranked.map((game) => game.id), [4, 2, 1, 3, 6, 5]);
});

test('de-duplicates malformed catalog priorities without dropping games', () => {
  const games = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const ranked = rankGames(games, {
    recentGameIds: [{ id: 2 }, 2, 'invalid'],
    localGameIds: [3, 2],
  });

  assert.deepEqual(ranked.map((game) => game.id), [2, 3, 1]);
});

test('manual acceleration and account-time controls use independent official actions', async () => {
  const originalGlobals = new Map(
    ['window', 'document', 'Element', 'indexedDB']
      .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  const events = [];
  const user = {
    isLogin: true,
    accountToken: 'test-token',
    userTimeInfo: { timeStatus: 'pause' },
    async toggleTimeStatus(status, options) {
      events.push(`time:${status}:${options.scene}`);
      this.userTimeInfo.timeStatus = status;
    },
  };
  const acc = {
    accInfo: { accStatus: 'normal', game_id: 0 },
    recordManualLineSelect() {
      events.push('record-line');
    },
    async startAcc() {
      events.push('start-acceleration');
    },
    async stopAcc() {
      events.push('stop-acceleration');
      this.accInfo.accStatus = 'normal';
      this.accInfo.game_id = 0;
    },
  };
  const pinia = { _s: new Map([['user', user], ['acc', acc]]) };
  const stores = new Map([
    ['game_list', [{ id: 42, title: 'Test Game', game_type: 0 }]],
    ['local_games', []],
    ['recent_games', []],
  ]);
  const database = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    transaction(name) {
      return {
        objectStore() {
          return {
            getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = stores.get(name);
                request.onsuccess?.();
              });
              return request;
            },
          };
        },
      };
    },
    close() {},
  };

  try {
    globalThis.Element = class {};
    globalThis.document = {
      querySelector: (selector) => selector === '#app'
        ? { __vue_app__: { _context: { provides: { pinia } } } }
        : null,
      querySelectorAll: () => [],
    };
    globalThis.indexedDB = {
      databases: async () => [{ name: 'leigod_database_test' }],
      open() {
        const request = {};
        queueMicrotask(() => {
          request.result = database;
          request.onsuccess?.();
        });
        return request;
      },
    };
    globalThis.window = {
      leigodSimplify: {
        async invoke() {
          return {
            data: {
              recomRegion: 'OPTIMAL',
              list_OPTIMAL: Array.from({ length: 3005 }, (_value, index) => ({
                line_id: index + 1,
                leigod_assign_id: index + 100,
                line_type: 0,
                line_title: `Test Line ${index + 1}`,
              })),
            },
          };
        },
      },
    };

    assert.equal(installOfficialBridge(rankGames), true);
    const lines = await window.__leigodCleanOfficial.call('getLines', {
      gameId: 42,
      areaId: 3,
      subAreaId: -1,
    });
    assert.equal(lines.length, 3005);
    await window.__leigodCleanOfficial.call('start', {
      gameId: 42,
      areaId: 3,
      subAreaId: -1,
      lineKey: lines[0].key,
    });

    assert.deepEqual(events, [
      'time:resume:other',
      'record-line',
      'start-acceleration',
    ]);

    events.length = 0;
    acc.accInfo = { accStatus: 'speeding', game_id: 42 };
    user.userTimeInfo.timeStatus = 'timeing';
    await window.__leigodCleanOfficial.call('stop');
    assert.deepEqual(events, ['stop-acceleration']);
    assert.equal(user.userTimeInfo.timeStatus, 'timeing');

    events.length = 0;
    acc.accInfo = { accStatus: 'speeding', game_id: 42 };
    await window.__leigodCleanOfficial.call('pause');
    assert.deepEqual(events, ['stop-acceleration', 'time:pause:other']);

    events.length = 0;
    await window.__leigodCleanOfficial.call('resume');
    assert.deepEqual(events, ['time:resume:other']);
  } finally {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
  }
});

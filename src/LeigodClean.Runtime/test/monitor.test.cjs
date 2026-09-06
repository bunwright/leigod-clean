'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProcessMonitor, normalizeProcesses, resolveProcesses } = require('../monitor.cjs');
const community = require('../community-processes.json');

function createHarness() {
  let now = 0;
  let pauseCount = 0;
  const running = new Set();
  const snapshots = [];
  const monitor = new ProcessMonitor({
    isRunning: async (name) => running.has(name.toLocaleLowerCase('en-US')),
    pause: async () => { pauseCount += 1; },
    onState: (snapshot) => snapshots.push(snapshot),
    now: () => now,
    setIntervalFn: () => ({ fake: true }),
    clearIntervalFn: () => {},
    missThreshold: 2,
  });

  return {
    monitor,
    running,
    snapshots,
    get pauseCount() { return pauseCount; },
    advance(milliseconds) { now += milliseconds; },
  };
}

test('normalizes and de-duplicates process names safely', () => {
  assert.deepEqual(
    normalizeProcesses(' Launcher.exe，Game.exe;launcher.exe\ncrashpad_handler.exe '),
    ['Launcher.exe', 'Game.exe'],
  );
});

test('resolves process lists using user, community, then official precedence', () => {
  const official = ['Official.exe', 'StaleHelper.exe'];
  const community = { 42: ['Launcher.exe', 'Game.exe'] };

  assert.deepEqual(
    resolveProcesses(42, official, { 42: ['Custom.exe'] }, community),
    ['Custom.exe'],
  );
  assert.deepEqual(resolveProcesses(42, official, {}, community), ['Launcher.exe', 'Game.exe']);
  assert.deepEqual(resolveProcesses(7, official, {}, community), official);
});

test('community process catalog is normalized and internally consistent', () => {
  assert.equal(community.schemaVersion, 1);
  assert.equal(new Set(community.excludedGameIds.map(String)).size, community.excludedGameIds.length);
  for (const [gameId, processes] of Object.entries(community.games)) {
    assert.match(gameId, /^\d+$/u);
    assert.ok(Array.isArray(processes) && processes.length > 0);
    assert.deepEqual(normalizeProcesses(processes), processes);
  }
});

test('keeps monitoring when a later process appears during handoff grace', async () => {
  const harness = createHarness();
  await harness.monitor.start(['Launcher.exe', 'Game.exe'], {
    gameId: 42,
    startupTimeoutMs: 5000,
    graceMs: 1000,
  });
  assert.equal(harness.monitor.snapshot.state, 'waiting');

  harness.running.add('launcher.exe');
  await harness.monitor.checkNow();
  assert.equal(harness.monitor.snapshot.state, 'active');
  assert.equal(harness.monitor.snapshot.activeProcess, 'Launcher.exe');

  harness.running.clear();
  await harness.monitor.checkNow();
  assert.equal(harness.monitor.snapshot.state, 'active');
  await harness.monitor.checkNow();
  assert.equal(harness.monitor.snapshot.state, 'grace');

  harness.advance(700);
  harness.running.add('game.exe');
  await harness.monitor.checkNow();
  assert.equal(harness.monitor.snapshot.state, 'active');
  assert.equal(harness.monitor.snapshot.activeProcess, 'Game.exe');
  assert.equal(harness.pauseCount, 0);
});

test('pauses exactly once after every configured process stays absent', async () => {
  const harness = createHarness();
  harness.running.add('game.exe');
  await harness.monitor.start(['Launcher.exe', 'Game.exe'], {
    startupTimeoutMs: 5000,
    graceMs: 1000,
  });
  assert.equal(harness.monitor.snapshot.state, 'active');

  harness.running.clear();
  await harness.monitor.checkNow();
  await harness.monitor.checkNow();
  assert.equal(harness.monitor.snapshot.state, 'grace');
  harness.advance(1000);
  await harness.monitor.checkNow();
  assert.equal(harness.monitor.snapshot.state, 'paused');
  assert.equal(harness.pauseCount, 1);

  await harness.monitor.checkNow();
  assert.equal(harness.pauseCount, 1);
});

test('pauses when no process appears before startup timeout', async () => {
  const harness = createHarness();
  await harness.monitor.start(['Game.exe'], {
    startupTimeoutMs: 500,
    graceMs: 1000,
  });
  harness.advance(500);
  await harness.monitor.checkNow();
  assert.equal(harness.monitor.snapshot.state, 'paused');
  assert.equal(harness.monitor.snapshot.reason, 'startup-timeout');
  assert.equal(harness.pauseCount, 1);
});

test('rechecks processes and retries after a transient pause failure', async () => {
  let now = 0;
  let attempts = 0;
  const running = new Set(['game.exe']);
  const monitor = new ProcessMonitor({
    isRunning: async (name) => running.has(name.toLocaleLowerCase('en-US')),
    pause: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('temporary pause failure');
      }
    },
    now: () => now,
    setIntervalFn: () => ({ fake: true }),
    clearIntervalFn: () => {},
    missThreshold: 1,
    pauseRetryMs: 1000,
  });

  await monitor.start(['Game.exe'], { graceMs: 1000 });
  running.clear();
  await monitor.checkNow();
  now += 1000;
  await monitor.checkNow();
  assert.equal(monitor.snapshot.state, 'grace');
  assert.equal(monitor.snapshot.reason, 'pause-failed');
  assert.equal(monitor.snapshot.error, 'temporary pause failure');
  assert.equal(attempts, 1);

  now += 1000;
  await monitor.checkNow();
  assert.equal(monitor.snapshot.state, 'paused');
  assert.equal(attempts, 2);
});

test('does not interpret process API failure as a process exit', async () => {
  let shouldThrow = false;
  const monitor = new ProcessMonitor({
    isRunning: async () => {
      if (shouldThrow) {
        throw new Error('native API unavailable');
      }
      return true;
    },
    pause: async () => assert.fail('pause must not be called'),
    setIntervalFn: () => ({ fake: true }),
    clearIntervalFn: () => {},
  });
  await monitor.start(['Game.exe']);
  assert.equal(monitor.snapshot.state, 'active');
  shouldThrow = true;
  await monitor.checkNow();
  assert.equal(monitor.snapshot.state, 'active');
  assert.equal(monitor.snapshot.error, 'native API unavailable');
});

test('does not interpret a partial process API failure as every process exiting', async () => {
  let failLauncherCheck = false;
  const running = new Set(['launcher.exe']);
  const monitor = new ProcessMonitor({
    isRunning: async (name) => {
      if (failLauncherCheck && name === 'Launcher.exe') {
        throw new Error('launcher check failed');
      }
      return running.has(name.toLocaleLowerCase('en-US'));
    },
    pause: async () => assert.fail('pause must not be called'),
    setIntervalFn: () => ({ fake: true }),
    clearIntervalFn: () => {},
  });

  await monitor.start(['Launcher.exe', 'Game.exe']);
  assert.equal(monitor.snapshot.state, 'active');
  running.clear();
  failLauncherCheck = true;
  await monitor.checkNow();

  assert.equal(monitor.snapshot.state, 'active');
  assert.equal(monitor.snapshot.error, 'launcher check failed');
});

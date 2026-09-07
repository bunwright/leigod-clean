'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProcessMonitor, normalizeProcesses, resolveProcesses } = require('../monitor.cjs');
const community = require('../community-processes.json');

function createHarness(options = {}) {
  let now = 0;
  let pauseCount = 0;
  let nextTimerId = 0;
  const timers = new Map();
  const running = new Set();
  const snapshots = [];
  const monitor = new ProcessMonitor({
    isRunning: async (name) => running.has(name.toLocaleLowerCase('en-US')),
    pause: async () => { pauseCount += 1; },
    onState: (snapshot) => snapshots.push(snapshot),
    now: () => now,
    setTimeoutFn: (callback, delay) => {
      const timer = { id: ++nextTimerId, at: now + delay, callback, unref() {} };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimeoutFn: (timer) => timers.delete(timer.id),
    ...options,
  });

  return {
    monitor,
    running,
    snapshots,
    timers,
    get pauseCount() { return pauseCount; },
    async advance(milliseconds) {
      now += milliseconds;
      const due = [...timers.values()]
        .filter((timer) => timer.at <= now)
        .sort((left, right) => left.at - right.at);
      for (const timer of due) {
        if (timers.delete(timer.id)) {
          timer.callback();
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
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
  const catalog = { 42: ['Launcher.exe', 'Game.exe'] };

  assert.deepEqual(
    resolveProcesses(42, official, { 42: ['Custom.exe'] }, catalog),
    ['Custom.exe'],
  );
  assert.deepEqual(resolveProcesses(42, official, {}, catalog), ['Launcher.exe', 'Game.exe']);
  assert.deepEqual(resolveProcesses(7, official, {}, catalog), official);
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

test('uses the current process snapshot immediately on start', async () => {
  const harness = createHarness();
  harness.running.add('game.exe');

  await harness.monitor.start(['Launcher.exe', 'Game.exe'], { startupTimeoutMs: 5000 });

  assert.equal(harness.monitor.snapshot.state, 'active');
  assert.equal(harness.monitor.snapshot.activeProcess, 'Game.exe');
  assert.equal(harness.timers.size, 0);
});

test('keeps monitoring when a later process appears during handoff grace', async () => {
  const harness = createHarness();
  harness.running.add('launcher.exe');
  await harness.monitor.start(['Launcher.exe', 'Game.exe'], {
    gameId: 42,
    startupTimeoutMs: 5000,
    graceMs: 1000,
  });

  harness.running.clear();
  await harness.monitor.processesChanged(['Launcher.exe']);
  assert.equal(harness.monitor.snapshot.state, 'grace');

  await harness.advance(700);
  harness.running.add('game.exe');
  await harness.monitor.processesChanged(['Game.exe']);
  assert.equal(harness.monitor.snapshot.state, 'active');
  assert.equal(harness.monitor.snapshot.activeProcess, 'Game.exe');
  assert.equal(harness.pauseCount, 0);

  await harness.advance(1000);
  assert.equal(harness.pauseCount, 0, 'the canceled grace deadline must not pause later');
});

test('pauses exactly once at the grace deadline', async () => {
  const harness = createHarness();
  harness.running.add('game.exe');
  await harness.monitor.start(['Game.exe'], { graceMs: 1000 });
  harness.running.clear();
  await harness.monitor.processesChanged(['Game.exe']);

  await harness.advance(999);
  assert.equal(harness.pauseCount, 0);
  await harness.advance(1);
  assert.equal(harness.monitor.snapshot.state, 'paused');
  assert.equal(harness.pauseCount, 1);

  await harness.advance(10000);
  assert.equal(harness.pauseCount, 1);
});

test('pauses when no process appears before the exact startup deadline', async () => {
  const harness = createHarness();
  await harness.monitor.start(['Game.exe'], { startupTimeoutMs: 500, graceMs: 1000 });

  await harness.advance(499);
  assert.equal(harness.pauseCount, 0);
  await harness.advance(1);
  assert.equal(harness.monitor.snapshot.state, 'paused');
  assert.equal(harness.monitor.snapshot.reason, 'startup-timeout');
  assert.equal(harness.pauseCount, 1);
});

test('rechecks process state and retries after a transient pause failure', async () => {
  let attempts = 0;
  const harness = createHarness({
    pause: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('temporary pause failure');
      }
    },
    pauseRetryMs: 1000,
  });
  harness.running.add('game.exe');
  await harness.monitor.start(['Game.exe'], { graceMs: 1000 });
  harness.running.clear();
  await harness.monitor.processesChanged(['Game.exe']);
  await harness.advance(1000);

  assert.equal(harness.monitor.snapshot.state, 'grace');
  assert.equal(harness.monitor.snapshot.reason, 'pause-failed');
  assert.equal(harness.monitor.snapshot.error, 'temporary pause failure');
  assert.equal(attempts, 1);

  await harness.advance(1000);
  assert.equal(harness.monitor.snapshot.state, 'paused');
  assert.equal(attempts, 2);
});

test('a returning process cancels a pending pause retry', async () => {
  let attempts = 0;
  const harness = createHarness({
    pause: async () => {
      attempts += 1;
      throw new Error('temporary pause failure');
    },
    pauseRetryMs: 1000,
  });
  harness.running.add('game.exe');
  await harness.monitor.start(['Game.exe'], { graceMs: 1000 });
  harness.running.clear();
  await harness.monitor.processesChanged(['Game.exe']);
  await harness.advance(1000);
  harness.running.add('game.exe');
  await harness.monitor.processesChanged(['Game.exe']);

  assert.equal(harness.monitor.snapshot.state, 'active');
  await harness.advance(1000);
  assert.equal(attempts, 1);
});

test('observer outages suspend deadlines and never look like process exits', async () => {
  const harness = createHarness();
  harness.running.add('game.exe');
  await harness.monitor.start(['Game.exe'], { graceMs: 1000 });
  harness.running.clear();
  await harness.monitor.processesChanged(['Game.exe']);
  await harness.advance(400);

  harness.monitor.observerUnavailable(new Error('observer stopped'));
  await harness.advance(5000);
  assert.equal(harness.pauseCount, 0);
  assert.equal(harness.monitor.snapshot.reason, 'process-observer-unavailable');
  harness.monitor.observerUnavailable(new Error('observer reconnecting'));
  assert.equal(harness.monitor.snapshot.error, 'observer reconnecting');

  await harness.monitor.observerAvailable();
  assert.equal(harness.monitor.snapshot.state, 'grace');
  await harness.advance(599);
  assert.equal(harness.pauseCount, 0);
  await harness.advance(1);
  assert.equal(harness.pauseCount, 1);
});

test('ignores unrelated process events', async () => {
  let checks = 0;
  const harness = createHarness({
    isRunning: async () => {
      checks += 1;
      return false;
    },
  });
  await harness.monitor.start(['Game.exe'], { startupTimeoutMs: 5000 });
  const initialChecks = checks;

  await harness.monitor.processesChanged(['Unrelated.exe']);

  assert.equal(checks, initialChecks);
  assert.equal(harness.monitor.snapshot.state, 'waiting');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ProcessEventSource, normalizeProcessName } = require('../process-events.cjs');

function createChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

function createHarness(options = {}) {
  const children = [];
  const timers = [];
  let now = 1000;
  const source = new ProcessEventSource({
    launcherPath: 'C:\\Apps\\LeigodClean.exe',
    spawnFn: (_path, _args, _options) => {
      const child = createChild();
      children.push(child);
      return child;
    },
    now: () => now,
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => { timer.cleared = true; },
    ...options,
  });
  return {
    source,
    children,
    timers,
    advance(milliseconds) { now += milliseconds; },
    runTimer(index = 0) {
      const timer = timers.filter((item) => !item.cleared)[index];
      assert.ok(timer, 'expected a pending timer');
      timer.cleared = true;
      timer.callback();
    },
  };
}

function send(child, event) {
  child.stdout.write(`${JSON.stringify(event)}\n`);
}

test('normalizes executable names and paths while rejecting invalid names', () => {
  assert.equal(normalizeProcessName('Game'), 'Game.exe');
  assert.equal(normalizeProcessName('C:\\Games\\Launcher.EXE'), 'Launcher.EXE');
  assert.equal(normalizeProcessName('bad:name'), '');
});

test('starts a hidden observer and accepts its initial snapshot', () => {
  const harness = createHarness();
  const events = [];
  harness.source.subscribe((event) => events.push(event));

  harness.source.start();
  assert.equal(harness.children.length, 1);
  send(harness.children[0], {
    type: 'snapshot',
    sequence: 1,
    processes: [{ pid: 10, name: 'Game.exe' }],
  });

  assert.equal(harness.source.snapshot.ready, true);
  assert.equal(harness.source.snapshot.status, 'ready');
  assert.equal(harness.source.isRunning('game.EXE'), true);
  assert.deepEqual(harness.source.runningNames, ['game.exe']);
  assert.equal(events.at(-1).kind, 'snapshot');
  assert.deepEqual(events.at(-1).names, ['game.exe']);
});

test('keeps a same-name process running until its final pid exits', () => {
  const harness = createHarness();
  const changes = [];
  harness.source.subscribe((event) => {
    if (event.type === 'change') {
      changes.push(event);
    }
  });
  harness.source.start();
  const child = harness.children[0];
  send(child, {
    type: 'snapshot',
    sequence: 1,
    processes: [
      { pid: 10, name: 'Game.exe' },
      { pid: 11, name: 'game.exe' },
    ],
  });
  send(child, { type: 'stopped', sequence: 2, pid: 10, name: 'Game.exe' });
  assert.equal(harness.source.isRunning('Game.exe'), true);
  assert.equal(changes.length, 1, 'first duplicate exit does not change name presence');

  send(child, { type: 'stopped', sequence: 3, pid: 11, name: 'game.exe' });
  assert.equal(harness.source.isRunning('Game.exe'), false);
  assert.deepEqual(changes.at(-1).names, ['game.exe']);
});

test('does not let a delayed stop remove a reused pid', () => {
  const harness = createHarness();
  harness.source.start();
  const child = harness.children[0];
  send(child, {
    type: 'snapshot',
    sequence: 1,
    processes: [{ pid: 42, name: 'Old.exe' }],
  });
  send(child, { type: 'started', sequence: 2, pid: 42, name: 'New.exe' });
  send(child, { type: 'stopped', sequence: 3, pid: 42, name: 'Old.exe' });

  assert.equal(harness.source.isRunning('Old.exe'), false);
  assert.equal(harness.source.isRunning('New.exe'), true);
});

test('reconciles missed events from a later snapshot', () => {
  const harness = createHarness();
  harness.source.start();
  const child = harness.children[0];
  send(child, {
    type: 'snapshot',
    sequence: 1,
    processes: [{ pid: 1, name: 'Stale.exe' }],
  });
  send(child, {
    type: 'snapshot',
    sequence: 2,
    processes: [{ pid: 2, name: 'Current.exe' }],
  });

  assert.equal(harness.source.isRunning('Stale.exe'), false);
  assert.equal(harness.source.isRunning('Current.exe'), true);
});

test('restarts with backoff after malformed output without clearing known state', () => {
  const harness = createHarness();
  harness.source.start();
  const child = harness.children[0];
  send(child, {
    type: 'snapshot',
    sequence: 1,
    processes: [{ pid: 10, name: 'Game.exe' }],
  });
  child.stdout.write('{malformed}\n');

  assert.equal(child.killed, true);
  assert.equal(harness.source.snapshot.ready, false);
  assert.equal(harness.source.snapshot.status, 'restarting');
  assert.equal(harness.source.snapshot.processCount, 1);
  assert.throws(() => harness.source.isRunning('Game.exe'), { code: 'PROCESS_EVENTS_UNAVAILABLE' });
  assert.equal(harness.timers.find((timer) => !timer.cleared).delay, 1000);

  harness.runTimer();
  assert.equal(harness.children.length, 2);
  const restarted = harness.children[1];
  send(restarted, { type: 'snapshot', sequence: 1, processes: [] });
  restarted.stdout.write('{malformed}\n');
  assert.equal(harness.timers.find((timer) => !timer.cleared).delay, 2000);
});

test('restarts an observer that never becomes ready or stops sending heartbeats', () => {
  const harness = createHarness({ startupTimeoutMs: 5000, staleTimeoutMs: 90000 });
  harness.source.start();
  const first = harness.children[0];
  assert.equal(harness.timers.find((timer) => !timer.cleared).delay, 5000);

  harness.runTimer();
  assert.equal(first.killed, true);
  assert.equal(harness.source.snapshot.status, 'restarting');
  assert.equal(harness.timers.find((timer) => !timer.cleared).delay, 1000);

  harness.runTimer();
  const second = harness.children[1];
  send(second, { type: 'snapshot', sequence: 1, processes: [] });
  assert.equal(harness.timers.find((timer) => !timer.cleared).delay, 90000);

  harness.runTimer();
  assert.equal(second.killed, true);
  assert.equal(harness.source.snapshot.ready, false);
  assert.equal(harness.source.snapshot.error, '进程事件服务失去响应。');
});

test('rejects sequence regressions and oversized messages', () => {
  const harness = createHarness({ maxLineLength: 4096 });
  harness.source.start();
  const first = harness.children[0];
  send(first, { type: 'snapshot', sequence: 1, processes: [] });
  send(first, { type: 'started', sequence: 1, pid: 7, name: 'Game.exe' });
  assert.equal(first.killed, true);

  harness.runTimer();
  const second = harness.children[1];
  second.stdout.write('x'.repeat(4097));
  assert.equal(second.killed, true);
});

test('does not loop on a permanent observer permission failure', () => {
  const harness = createHarness();
  harness.source.start();
  const child = harness.children[0];
  send(child, {
    type: 'error',
    fatal: true,
    code: 'ACCESS_DENIED',
    retryable: false,
    message: 'access denied',
  });

  assert.equal(child.killed, true);
  assert.equal(harness.source.snapshot.status, 'failed');
  assert.equal(harness.source.snapshot.error, 'access denied');
  assert.equal(harness.timers.filter((timer) => !timer.cleared).length, 0);
});

test('stopping closes the control pipe and never schedules a restart', () => {
  const harness = createHarness();
  harness.source.start();
  const child = harness.children[0];
  let input = '';
  child.stdin.on('data', (chunk) => { input += chunk; });

  harness.source.stop();
  child.emit('close', 0, null);

  assert.equal(input, 'stop\n');
  assert.equal(harness.source.snapshot.status, 'stopped');
  assert.equal(harness.timers.filter((timer) => !timer.cleared).length, 0);
});

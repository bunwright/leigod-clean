'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AutoEvaluationQueue,
  completeAutoWatchAttempt,
  defaultAutoSelection,
  evaluateAutoWatchState,
  GameLifecycleTracker,
  resolveAutoGameIds,
  selectAutoEventGames,
} = require('../auto-acceleration.cjs');

test('serializes distinct process starts while allowing one switch per event', async () => {
  const calls = [];
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const queue = new AutoEvaluationQueue({
    getOrder: () => ['42', '43', '44'],
    evaluate: async (gameId, allowSwitch) => {
      calls.push([gameId, allowSwitch]);
      if (gameId === '42') {
        await firstPending;
      }
      return true;
    },
  });

  const draining = queue.enqueue(['42', '43'], { allowSwitch: true });
  queue.enqueue(['44'], { allowSwitch: true });
  releaseFirst();
  await draining;

  assert.deepEqual(calls, [
    ['42', true],
    ['44', true],
  ]);
});

test('coalesces routine checks without granting session switching', async () => {
  const calls = [];
  const queue = new AutoEvaluationQueue({
    getOrder: () => ['42', '43'],
    evaluate: async (gameId, allowSwitch) => {
      calls.push([gameId, allowSwitch]);
      return false;
    },
  });

  const draining = queue.enqueue(['43', '42', '42']);
  queue.enqueue(['43']);
  await draining;

  assert.deepEqual(calls, [
    ['42', false],
    ['43', false],
  ]);
});

test('forwards lifecycle metadata without changing switch serialization', async () => {
  const calls = [];
  const queue = new AutoEvaluationQueue({
    getOrder: () => ['42'],
    evaluate: async (...args) => {
      calls.push(args);
      return false;
    },
  });

  await queue.enqueue(['42'], { allowSwitch: true, lifecycleKind: 'started' });
  await queue.enqueue(['42'], { lifecycleKind: 'stopped' });

  assert.deepEqual(calls, [
    ['42', true, 'started'],
    ['42', false, 'stopped'],
  ]);
});

test('forwards the matched process name with lifecycle events', async () => {
  const calls = [];
  const queue = new AutoEvaluationQueue({
    getOrder: () => ['42'],
    evaluate: async (...args) => {
      calls.push(args);
      return false;
    },
  });

  await queue.enqueue(['42'], {
    allowSwitch: true,
    lifecycleKind: 'started',
    processNames: new Map([['42', 'game.exe']]),
  });

  assert.deepEqual(calls, [['42', true, 'started', 'game.exe']]);
});

test('announces lifecycle edges immediately while suppressing launcher handoff exits', async () => {
  const scheduled = [];
  const events = [];
  let running = true;
  const tracker = new GameLifecycleTracker({
    isRunning: () => running,
    onStarted: (_gameId, game, processName) =>
      events.push(`started:${game.title}:${processName}`),
    onStopped: (_gameId, game, processName) =>
      events.push(`stopped:${game.title}:${processName}`),
    schedule(callback) {
      const handle = { callback, cancelled: false, unref() {} };
      scheduled.push(handle);
      return handle;
    },
    cancel(handle) {
      handle.cancelled = true;
    },
  });
  const game = { title: 'Test Game' };

  tracker.observe('42', game, true, 'started', 'launcher.exe');
  tracker.observe('42', game, false, 'stopped', 'launcher.exe');
  tracker.observe('42', game, true, 'started', 'game.exe');
  assert.equal(scheduled[0].cancelled, true);
  assert.deepEqual(events, ['started:Test Game:launcher.exe']);

  running = false;
  tracker.observe('42', game, false, 'stopped', 'game.exe');
  scheduled[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    'started:Test Game:launcher.exe',
    'stopped:Test Game:game.exe',
  ]);

  running = true;
  tracker.observe('42', game, true, 'started', 'game.exe');
  assert.deepEqual(events, [
    'started:Test Game:launcher.exe',
    'stopped:Test Game:game.exe',
    'started:Test Game:game.exe',
  ]);
});

test('keeps launcher handoffs on the active game and prefers precise path matches', () => {
  assert.deepEqual(selectAutoEventGames(['316', '2642'], [], {
    accelerating: true,
    activeGameId: 316,
  }), { gameIds: ['316'], activeHandoff: true });

  assert.deepEqual(selectAutoEventGames(['316', '2642'], ['2642'], {
    accelerating: true,
    activeGameId: 316,
  }), { gameIds: ['316'], activeHandoff: true });

  assert.deepEqual(selectAutoEventGames(['2642'], ['2642'], {
    accelerating: true,
    activeGameId: 316,
  }), { gameIds: ['2642'], activeHandoff: false });
});

const idleContext = Object.freeze({
  running: true,
  loggedIn: true,
  accelerating: false,
  activeGameId: '',
  gameId: '42',
});

test('starts once when an enabled game process appears', () => {
  const first = evaluateAutoWatchState(undefined, idleContext, 1000);
  assert.equal(first.shouldStart, true);

  const completed = completeAutoWatchAttempt(first.state, true, 1000);
  const second = evaluateAutoWatchState(completed, idleContext, 2000);
  assert.equal(second.shouldStart, false);
  assert.equal(second.state.latched, true);
});

test('an exit event immediately rearms the next process start', () => {
  const latched = completeAutoWatchAttempt({}, true, 0);
  const exited = evaluateAutoWatchState(latched, { ...idleContext, running: false }, 1000);
  assert.equal(exited.state.latched, false);
  assert.equal(evaluateAutoWatchState(exited.state, idleContext, 2000).shouldStart, true);
});

test('backs off after failure and retries while the process remains running', () => {
  const failed = completeAutoWatchAttempt({}, false, 1000, 30000);
  assert.equal(evaluateAutoWatchState(failed, idleContext, 30999).shouldStart, false);
  assert.equal(evaluateAutoWatchState(failed, idleContext, 31000).shouldStart, true);
});

test('switches only when a fresh enabled-game process event allows it', () => {
  const otherGame = evaluateAutoWatchState(undefined, {
    ...idleContext,
    accelerating: true,
    activeGameId: '99',
  }, 1000);
  assert.equal(otherGame.shouldStart, false);
  assert.equal(otherGame.state.latched, false);

  const freshProcess = evaluateAutoWatchState(otherGame.state, {
    ...idleContext,
    accelerating: true,
    activeGameId: '99',
    allowSwitch: true,
  }, 1001);
  assert.equal(freshProcess.shouldStart, true);

  const sameGame = evaluateAutoWatchState(undefined, {
    ...idleContext,
    accelerating: true,
    activeGameId: '42',
  }, 1000);
  assert.equal(sameGame.state.latched, true);
});

test('a newly launched enabled game can take over without reactivating stale running games', () => {
  const firstStarted = completeAutoWatchAttempt({}, true, 1000);
  const second = evaluateAutoWatchState(undefined, {
    ...idleContext,
    gameId: '43',
    accelerating: true,
    activeGameId: '42',
    allowSwitch: true,
  }, 2000);
  assert.equal(second.shouldStart, true);

  const secondStarted = completeAutoWatchAttempt(second.state, true, 2000);
  const staleFirst = evaluateAutoWatchState(firstStarted, {
    ...idleContext,
    gameId: '42',
    accelerating: true,
    activeGameId: '43',
  }, 3000);
  assert.equal(staleFirst.shouldStart, false);

  const third = evaluateAutoWatchState(undefined, {
    ...idleContext,
    gameId: '44',
    accelerating: true,
    activeGameId: '43',
    allowSwitch: true,
  }, 4000);
  assert.equal(secondStarted.latched, true);
  assert.equal(third.shouldStart, true);
});

test('waits for login without consuming the process trigger', () => {
  const loggedOut = evaluateAutoWatchState(undefined, { ...idleContext, loggedIn: false }, 1000);
  assert.equal(loggedOut.shouldStart, false);
  assert.equal(loggedOut.state.latched, false);
  assert.equal(evaluateAutoWatchState(loggedOut.state, idleContext, 2000).shouldStart, true);
});

test('dedicated game switches remain active when the global switch is off', () => {
  assert.deepEqual(resolveAutoGameIds({
    autoAccelerationEnabled: false,
    autoAccelerateGames: { 42: true, 43: false },
    gameSelections: { 99: { areaId: 1 } },
  }, [100]), ['42']);
});

test('the global switch covers configured, local, and recent games', () => {
  assert.deepEqual(resolveAutoGameIds({
    autoAccelerationEnabled: true,
    autoAccelerateGames: { 42: true },
    gameSelections: { 43: { areaId: 1 }, invalid: {} },
  }, [{ id: 44 }, 45, '43', 0, 'invalid']), ['42', '43', '44', '45']);
});

test('notifications alone do not add automatic lifecycle targets', () => {
  assert.deepEqual(resolveAutoGameIds({
    notificationsEnabled: true,
    autoAccelerationEnabled: false,
    autoAccelerateGames: {},
  }, [{ id: 42 }, '43']), []);
});

test('a global candidate can use the first playable area and sub-area', () => {
  assert.deepEqual(defaultAutoSelection({
    areas: [
      { id: 'invalid', subAreas: [] },
      { id: 8, subAreas: [{ id: 9 }] },
    ],
  }), { areaId: 8, subAreaId: 9, lineId: -1, assignId: -1 });
  assert.equal(defaultAutoSelection({ areas: [] }), null);
});

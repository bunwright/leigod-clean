'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  completeAutoWatchAttempt,
  defaultAutoSelection,
  evaluateAutoWatchState,
  resolveAutoGameIds,
} = require('../auto-acceleration.cjs');

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

test('does not switch away from another active acceleration', () => {
  const otherGame = evaluateAutoWatchState(undefined, {
    ...idleContext,
    accelerating: true,
    activeGameId: '99',
  }, 1000);
  assert.equal(otherGame.shouldStart, false);
  assert.equal(otherGame.state.latched, false);

  const sameGame = evaluateAutoWatchState(undefined, {
    ...idleContext,
    accelerating: true,
    activeGameId: '42',
  }, 1000);
  assert.equal(sameGame.state.latched, true);
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

test('a global candidate can use the first playable area and sub-area', () => {
  assert.deepEqual(defaultAutoSelection({
    areas: [
      { id: 'invalid', subAreas: [] },
      { id: 8, subAreas: [{ id: 9 }] },
    ],
  }), { areaId: 8, subAreaId: 9, lineId: -1, assignId: -1 });
  assert.equal(defaultAutoSelection({ areas: [] }), null);
});

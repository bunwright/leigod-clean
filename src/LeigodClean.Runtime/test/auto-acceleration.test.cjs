'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  completeAutoWatchAttempt,
  evaluateAutoWatchState,
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

test('requires two missing samples before a process can trigger again', () => {
  const latched = completeAutoWatchAttempt({}, true, 0);
  const firstMiss = evaluateAutoWatchState(latched, { ...idleContext, running: false }, 1000);
  assert.equal(firstMiss.state.latched, true);

  const secondMiss = evaluateAutoWatchState(firstMiss.state, { ...idleContext, running: false }, 2000);
  assert.equal(secondMiss.state.latched, false);
  assert.equal(evaluateAutoWatchState(secondMiss.state, idleContext, 3000).shouldStart, true);
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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createExitConfirmation, createShutdownCoordinator } = require('../shutdown.cjs');

test('exit confirmation coalesces duplicate requests and exits once when approved', async () => {
  const events = [];
  let resolveConfirmation = null;
  const confirmation = createExitConfirmation({
    confirm: () => new Promise((resolve) => {
      events.push('confirm');
      resolveConfirmation = resolve;
    }),
    exit: async () => events.push('exit'),
  });

  const first = confirmation.request();
  const second = confirmation.request();
  assert.equal(first, second);
  assert.equal(confirmation.pending, true);
  await Promise.resolve();
  assert.deepEqual(events, ['confirm']);

  resolveConfirmation(true);
  assert.equal(await first, true);
  assert.equal(confirmation.pending, false);
  assert.deepEqual(events, ['confirm', 'exit']);
});

test('cancelling exit leaves the application open and permits a later request', async () => {
  const decisions = [false, true];
  let exits = 0;
  const confirmation = createExitConfirmation({
    confirm: async () => decisions.shift(),
    exit: async () => { exits += 1; },
  });

  assert.equal(await confirmation.request(), false);
  assert.equal(exits, 0);
  assert.equal(await confirmation.request(), true);
  assert.equal(exits, 1);
});

test('a confirmation failure is reported and does not exit', async () => {
  const errors = [];
  const confirmation = createExitConfirmation({
    confirm: async () => { throw new Error('dialog failed'); },
    exit: async () => assert.fail('exit must not run'),
    onError: (error) => errors.push(error.message),
  });

  assert.equal(await confirmation.request(), false);
  assert.deepEqual(errors, ['dialog failed']);
});

test('a single shutdown request conceals immediately and finishes exactly once', async () => {
  const events = [];
  const timer = {};
  const shutdown = createShutdownCoordinator({
    conceal: () => events.push('conceal'),
    prepare: async () => events.push('prepare'),
    dispose: () => events.push('dispose'),
    exit: (code) => events.push(`exit:${code}`),
    schedule: (_callback, delay) => {
      events.push(`schedule:${delay}`);
      return timer;
    },
    cancel: (candidate) => events.push(candidate === timer ? 'cancel' : 'cancel-unknown'),
  });

  const first = shutdown.request();
  const second = shutdown.request();
  assert.equal(first, second);
  assert.equal(shutdown.phase, 'closing');
  assert.deepEqual(events, ['conceal', 'schedule:5000']);

  await first;
  assert.equal(shutdown.phase, 'finished');
  assert.deepEqual(events, [
    'conceal',
    'schedule:5000',
    'prepare',
    'cancel',
    'dispose',
    'exit:0',
  ]);
});

test('the shutdown deadline exits once even when preparation remains pending', async () => {
  const events = [];
  let deadline = null;
  let completePreparation = null;
  const shutdown = createShutdownCoordinator({
    conceal: () => events.push('conceal'),
    prepare: () => new Promise((resolve) => {
      events.push('prepare');
      completePreparation = resolve;
    }),
    dispose: () => events.push('dispose'),
    exit: (code) => events.push(`exit:${code}`),
    schedule: (callback) => {
      deadline = callback;
      return 1;
    },
    cancel: () => events.push('cancel'),
  });

  const completion = shutdown.request();
  await Promise.resolve();
  assert.equal(typeof deadline, 'function');
  deadline();
  assert.equal(shutdown.phase, 'finished');
  assert.deepEqual(events, ['conceal', 'prepare', 'cancel', 'dispose', 'exit:0']);

  completePreparation();
  await completion;
  assert.deepEqual(events, ['conceal', 'prepare', 'cancel', 'dispose', 'exit:0']);
});

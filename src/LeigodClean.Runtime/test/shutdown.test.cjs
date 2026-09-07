'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createShutdownCoordinator } = require('../shutdown.cjs');

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

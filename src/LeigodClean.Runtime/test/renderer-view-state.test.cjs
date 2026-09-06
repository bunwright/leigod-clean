'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  accelerationContext,
  promoteGame,
  shouldDisplayMonitor,
} = require('../renderer/view-state.js');

test('scopes acceleration and the stop action to the selected game', () => {
  const client = { accStatus: 'speeding', gameId: 42 };

  assert.deepEqual(accelerationContext(client, 42), {
    status: 'speeding',
    activeGameId: '42',
    selectedGameId: '42',
    selectedIsActive: true,
    anotherIsActive: false,
    accelerating: true,
    loading: false,
    canStop: true,
  });

  const other = accelerationContext(client, 99);
  assert.equal(other.selectedIsActive, false);
  assert.equal(other.anotherIsActive, true);
  assert.equal(other.accelerating, false);
  assert.equal(other.canStop, false);
});

test('does not leak another game monitor session into the selected game', () => {
  const activeClient = { accStatus: 'speeding', gameId: 42 };
  const monitor = { state: 'active', gameId: '42' };

  assert.equal(shouldDisplayMonitor(activeClient, monitor, 42), true);
  assert.equal(shouldDisplayMonitor(activeClient, monitor, 99), false);
  assert.equal(shouldDisplayMonitor({ accStatus: 'normal' }, monitor, 42), true);
  assert.equal(shouldDisplayMonitor({ accStatus: 'normal' }, monitor, 99), false);
});

test('promotes the active game without mutating the catalog', () => {
  const games = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const promoted = promoteGame(games, 3);

  assert.deepEqual(promoted.map((game) => game.id), [3, 1, 2]);
  assert.deepEqual(games.map((game) => game.id), [1, 2, 3]);
  assert.equal(promoteGame(promoted, 3), promoted);
  assert.equal(promoteGame(promoted, 99), promoted);
});

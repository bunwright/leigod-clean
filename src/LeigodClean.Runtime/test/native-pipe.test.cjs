'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const {
  compactApplicationState,
  compactClientState,
  createNativePipeServer,
  validatePipeName,
} = require('../native-pipe.cjs');

test('native mode exposes only essential account and acceleration state', () => {
  const client = compactClientState({
    ready: true,
    isLogin: true,
    displayName: 'Player',
    timeStatus: 'pause',
    totalTimeLeft: 3661,
    accStatus: 'speeding',
    gameId: 42,
    connected: true,
    clientVersion: '1.2.3',
    duration: 120,
    delay: 18,
    loss: 0.2,
    trafficKb: 4096,
  });

  assert.equal(client.totalTimeLeft, 3661);
  assert.equal(client.gameId, 42);
  assert.equal(client.clientVersion, '1.2.3');
  assert.equal(Object.hasOwn(client, 'duration'), false);
  assert.equal(Object.hasOwn(client, 'delay'), false);
  assert.equal(Object.hasOwn(client, 'loss'), false);
  assert.equal(Object.hasOwn(client, 'trafficKb'), false);
});

test('native application state drops monitor and process telemetry', () => {
  const compact = compactApplicationState({
    application: { version: '0.6.0' },
    client: { ready: true },
    settings: { minimalMode: true },
    monitor: { state: 'running' },
    processEvents: { processCount: 100 },
  });
  assert.deepEqual(Object.keys(compact), ['application', 'client', 'settings']);
  assert.equal(compact.settings.minimalMode, true);
});

test('native pipe names are strictly local and bounded', () => {
  assert.equal(validatePipeName('LeigodClean-123-abcdef12'), 'LeigodClean-123-abcdef12');
  assert.throws(() => validatePipeName('..\\unsafe'), /Invalid native pipe name/u);
  assert.throws(() => validatePipeName('short'), /Invalid native pipe name/u);
});

test('native pipe authenticates and returns newline-delimited responses', async () => {
  const pipeName = `LeigodClean-test-${process.pid}-${Date.now()}`;
  const token = 'b'.repeat(64);
  const server = createNativePipeServer({
    pipeName,
    token,
    initialState: () => ({ client: { ready: false }, settings: {} }),
    invoke: async (method, payload) => ({ method, value: payload.value }),
  });
  const socket = net.createConnection(`\\\\.\\pipe\\${pipeName}`);
  socket.setEncoding('utf8');
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const messages = [];
    let buffer = '';
    const response = new Promise((resolve, reject) => {
      socket.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          messages.push(message);
          if (message.id === 7) {
            resolve(message);
          }
        }
      });
      socket.once('error', reject);
    });
    socket.write(`${JSON.stringify({ id: 7, token, method: 'echo', payload: { value: 42 } })}\n`);
    assert.deepEqual(await response, {
      id: 7,
      ok: true,
      data: { method: 'echo', value: 42 },
    });
    assert.equal(messages[0].type, 'state');
  } finally {
    socket.destroy();
    server.close();
  }
});

test('native pipe broadcasts notifications to connected clients', async () => {
  const pipeName = `LeigodClean-notification-${process.pid}-${Date.now()}`;
  const token = 'c'.repeat(64);
  const server = createNativePipeServer({
    pipeName,
    token,
    initialState: () => ({ client: { ready: true }, settings: {} }),
    invoke: async () => null,
  });
  const socket = net.createConnection(`\\\\.\\pipe\\${pipeName}`);
  socket.setEncoding('utf8');
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    let resolveInitialState;
    const initialState = new Promise((resolve) => { resolveInitialState = resolve; });
    const notification = new Promise((resolve, reject) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (message.type === 'state') {
            resolveInitialState(message);
          }
          if (message.type === 'notification') {
            resolve(message);
          }
        }
      });
      socket.once('error', reject);
    });
    await initialState;
    assert.equal(server.broadcastNotification({
      title: 'LeigodClean',
      body: '检测到游戏已启动。',
      silent: false,
    }), 1);
    assert.deepEqual(await notification, {
      type: 'notification',
      data: {
        title: 'LeigodClean',
        body: '检测到游戏已启动。',
        silent: false,
      },
    });
  } finally {
    socket.destroy();
    server.close();
  }
});

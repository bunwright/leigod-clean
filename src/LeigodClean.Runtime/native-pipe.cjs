'use strict';

const net = require('node:net');

const MAX_MESSAGE_BYTES = 256 * 1024;

function compactClientState(state) {
  const source = state && typeof state === 'object' ? state : {};
  return {
    ready: source.ready === true,
    isLogin: source.isLogin === true,
    displayName: String(source.displayName ?? ''),
    timeStatus: String(source.timeStatus ?? ''),
    totalTimeLeft: Math.max(0, Number(source.totalTimeLeft) || 0),
    canPauseTimeLeft: Math.max(0, Number(source.canPauseTimeLeft) || 0),
    accStatus: String(source.accStatus ?? 'normal'),
    gameId: Math.max(0, Number(source.gameId) || 0),
    connected: source.connected === true,
    clientVersion: String(source.clientVersion ?? ''),
    officialVisible: source.officialVisible === true,
    needsAttention: source.needsAttention === true,
    attentionTitle: String(source.attentionTitle ?? ''),
    message: String(source.message ?? source.error ?? ''),
  };
}

function compactApplicationState(state) {
  const source = state && typeof state === 'object' ? state : {};
  return {
    application: source.application ?? {},
    client: compactClientState(source.client),
    settings: source.settings ?? {},
  };
}

function validatePipeName(value) {
  const name = String(value ?? '');
  if (!/^[A-Za-z0-9._-]{8,120}$/u.test(name)) {
    throw new Error('Invalid native pipe name.');
  }
  return name;
}

function createNativePipeServer({ pipeName, token, invoke, initialState, log = () => {} }) {
  const name = validatePipeName(pipeName);
  const secret = String(token ?? '');
  if (secret.length < 32 || typeof invoke !== 'function') {
    throw new Error('Invalid native bridge configuration.');
  }

  const sockets = new Set();
  let closed = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_MESSAGE_BYTES) {
        socket.destroy(new Error('Native bridge message is too large.'));
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          void handleLine(socket, line);
        }
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', (error) => log(`Native bridge client error: ${error.message}`));
    try {
      write(socket, { type: 'state', data: compactApplicationState(initialState()) });
    } catch (error) {
      log(`Native bridge initial state failed: ${error.message}`);
    }
  });

  async function handleLine(socket, line) {
    let request;
    try {
      request = JSON.parse(line);
      if (!request || request.token !== secret || !Number.isSafeInteger(request.id)) {
        throw Object.assign(new Error('Native bridge request rejected.'), { code: 'REQUEST_REJECTED' });
      }
      const method = String(request.method ?? '');
      const result = await invoke(method, request.payload ?? {});
      const data = method === 'initialize' || method === 'start' ||
        method === 'stopAcceleration' || method === 'pauseTime' || method === 'resumeTime' ||
        method === 'toggleTime' || method === 'startSavedGame' ||
        method === 'showOfficial' || method === 'hideOfficial'
        ? compactApplicationState(result)
        : result;
      write(socket, { id: request.id, ok: true, data });
    } catch (error) {
      write(socket, {
        id: Number.isSafeInteger(request?.id) ? request.id : 0,
        ok: false,
        error: {
          code: String(error?.code ?? 'OPERATION_FAILED'),
          message: String(error?.message ?? error ?? 'Operation failed.'),
        },
      });
    }
  }

  function write(socket, message) {
    if (!socket.destroyed) {
      socket.write(`${JSON.stringify(message)}\n`);
    }
  }

  server.on('error', (error) => log(`Native bridge server error: ${error.message}`));
  server.listen(`\\\\.\\pipe\\${name}`, () => log(`Native bridge listening on ${name}`));

  return {
    broadcast(state) {
      const message = { type: 'state', data: compactApplicationState(state) };
      for (const socket of sockets) {
        write(socket, message);
      }
    },
    broadcastNotification(notification) {
      const source = notification && typeof notification === 'object' ? notification : {};
      const message = {
        type: 'notification',
        data: {
          title: String(source.title ?? 'LeigodClean').slice(0, 128),
          body: String(source.body ?? '').slice(0, 1024),
          silent: source.silent !== false,
        },
      };
      for (const socket of sockets) {
        write(socket, message);
      }
      return sockets.size;
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      server.close();
    },
  };
}

module.exports = {
  compactApplicationState,
  compactClientState,
  createNativePipeServer,
  validatePipeName,
};

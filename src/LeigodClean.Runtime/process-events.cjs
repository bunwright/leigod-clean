'use strict';

const { spawn } = require('node:child_process');

const MAX_LINE_LENGTH = 1024 * 1024;
const MAX_PROCESSES = 16384;
const RESTART_DELAYS_MS = Object.freeze([1000, 2000, 5000, 10000, 30000]);
const STARTUP_TIMEOUT_MS = 15000;
const STALE_TIMEOUT_MS = 90000;

function normalizeProcessName(value) {
  const name = String(value ?? '').trim().split(/[\\/]/u).at(-1) ?? '';
  if (!name || name.length > 260 || /[\0:*?"<>|]/u.test(name)) {
    return '';
  }
  return name.toLocaleLowerCase('en-US').endsWith('.exe') ? name : `${name}.exe`;
}

function normalizeExecutablePath(value) {
  const executablePath = String(value ?? '').trim().replace(/^"|"$/gu, '').replace(/\//gu, '\\');
  if (!executablePath || executablePath.length > 32767 || /[\0\r\n]/u.test(executablePath)) {
    return '';
  }
  return executablePath;
}

function processKey(value) {
  return normalizeProcessName(value).toLocaleLowerCase('en-US');
}

class ProcessEventSource {
  constructor({
    executablePath,
    spawnFn = spawn,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    log = () => {},
    restartDelaysMs = RESTART_DELAYS_MS,
    maxLineLength = MAX_LINE_LENGTH,
    startupTimeoutMs = STARTUP_TIMEOUT_MS,
    staleTimeoutMs = STALE_TIMEOUT_MS,
  }) {
    if (!String(executablePath ?? '').trim()) {
      throw new TypeError('ProcessEventSource requires an observer executable path.');
    }
    if (typeof spawnFn !== 'function') {
      throw new TypeError('ProcessEventSource requires a spawn function.');
    }

    this._executablePath = String(executablePath).trim();
    this._spawn = spawnFn;
    this._now = now;
    this._setTimeout = setTimeoutFn;
    this._clearTimeout = clearTimeoutFn;
    this._log = log;
    this._restartDelays = Array.isArray(restartDelaysMs) && restartDelaysMs.length > 0
      ? restartDelaysMs.map((delay) => Math.max(0, Number(delay) || 0))
      : [...RESTART_DELAYS_MS];
    this._maxLineLength = Math.max(4096, Number(maxLineLength) || MAX_LINE_LENGTH);
    this._startupTimeout = Math.max(1000, Number(startupTimeoutMs) || STARTUP_TIMEOUT_MS);
    this._staleTimeout = Math.max(
      this._startupTimeout,
      Number(staleTimeoutMs) || STALE_TIMEOUT_MS,
    );

    this._listeners = new Set();
    this._processes = new Map();
    this._nameCounts = new Map();
    this._child = null;
    this._restartTimer = null;
    this._shutdownTimer = null;
    this._healthTimer = null;
    this._restartAttempt = 0;
    this._generation = 0;
    this._sequence = 0;
    this._buffer = '';
    this._started = false;
    this._stopping = false;
    this._ready = false;
    this._status = 'stopped';
    this._error = '';
    this._lastEventAt = 0;
    this._readySince = 0;
    this._restartCount = 0;
  }

  get snapshot() {
    return {
      status: this._status,
      ready: this._ready,
      error: this._error,
      processCount: this._processes.size,
      lastEventAt: this._lastEventAt,
      restartCount: this._restartCount,
      generation: this._generation,
    };
  }

  get runningNames() {
    return [...this._nameCounts.keys()].sort((left, right) => left.localeCompare(right, 'en-US'));
  }

  get runningProcesses() {
    return [...this._processes.entries()].map(([pid, process]) => ({ pid, ...process }));
  }

  isRunning(processName) {
    if (!this._ready) {
      const error = new Error(this._error || '进程事件服务尚未就绪。');
      error.code = 'PROCESS_EVENTS_UNAVAILABLE';
      throw error;
    }
    const key = processKey(processName);
    return Boolean(key && (this._nameCounts.get(key) ?? 0) > 0);
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Process event listener must be a function.');
    }
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  start() {
    if (this._started && !this._stopping && this._status !== 'failed') {
      return this.snapshot;
    }
    this._started = true;
    this._stopping = false;
    this._restartAttempt = 0;
    this._readySince = 0;
    this._spawnObserver();
    return this.snapshot;
  }

  stop() {
    if (!this._started && this._status === 'stopped') {
      return;
    }
    this._started = false;
    this._stopping = true;
    this._ready = false;
    this._clearRestartTimer();
    this._clearHealthTimer();
    const child = this._child;
    if (child) {
      try {
        child.stdin?.end('stop\n');
      } catch {
        // The observer may already have closed its input pipe.
      }
      this._shutdownTimer = this._setTimeout(() => {
        this._shutdownTimer = null;
        try {
          child.kill();
        } catch {
          // The process has already exited.
        }
      }, 2000);
      this._shutdownTimer?.unref?.();
    }
    this._setStatus('stopped', '');
  }

  _spawnObserver() {
    if (!this._started || this._stopping || this._child) {
      return;
    }
    this._generation += 1;
    this._sequence = 0;
    this._buffer = '';
    this._ready = false;
    this._setStatus(this._restartAttempt === 0 ? 'starting' : 'restarting', this._error);

    let child;
    try {
      child = this._spawn(this._executablePath, ['--process-events'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this._observerExited(null, `无法启动进程事件服务：${messageOf(error)}`);
      return;
    }
    this._child = child;
    this._armHealthTimer(child, this._startupTimeout, '进程事件服务启动超时。');
    child.__leigodCleanHandled = false;
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => this._consume(String(chunk), child));
    child.stderr?.on('data', (chunk) => {
      const message = String(chunk).replace(/\s+/gu, ' ').trim().slice(0, 1000);
      if (message) {
        this._log(`Process observer: ${message}`);
      }
    });
    child.once('error', (error) => {
      this._observerExited(child, `进程事件服务启动失败：${messageOf(error)}`);
    });
    child.once('close', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      this._observerExited(child, `进程事件服务已退出（${detail}）。`);
    });
  }

  _consume(chunk, child) {
    if (child !== this._child || this._stopping) {
      return;
    }
    this._buffer += chunk;
    if (this._buffer.length > this._maxLineLength && !this._buffer.includes('\n')) {
      this._protocolFailure(child, '进程事件消息超过安全长度。');
      return;
    }

    let newline = this._buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this._buffer.slice(0, newline).replace(/\r$/u, '');
      this._buffer = this._buffer.slice(newline + 1);
      if (line.length > this._maxLineLength) {
        this._protocolFailure(child, '进程事件消息超过安全长度。');
        return;
      }
      if (line.trim()) {
        this._acceptLine(line, child);
        if (child !== this._child) {
          return;
        }
      }
      newline = this._buffer.indexOf('\n');
    }
  }

  _acceptLine(line, child) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this._protocolFailure(child, '进程事件服务返回了无效数据。');
      return;
    }
    if (!event || typeof event !== 'object') {
      this._protocolFailure(child, '进程事件服务返回了无效消息。');
      return;
    }
    if (event.type === 'error') {
      const message = String(event.message || '进程事件服务发生错误。');
      if (event.retryable === false) {
        this._observerFailed(child, message);
      } else {
        this._observerExited(child, message);
      }
      try {
        child.kill();
      } catch {
        // The child may already be exiting after its fatal event.
      }
      return;
    }

    const sequence = Number(event.sequence);
    if (!Number.isSafeInteger(sequence) || sequence <= this._sequence) {
      this._protocolFailure(child, '进程事件序列无效。');
      return;
    }
    this._sequence = sequence;
    this._lastEventAt = this._now();
    this._armHealthTimer(child, this._staleTimeout, '进程事件服务失去响应。');

    if (event.type === 'snapshot') {
      this._acceptSnapshot(event, child);
      return;
    }
    if (!this._ready || (event.type !== 'started' && event.type !== 'stopped')) {
      this._protocolFailure(child, '进程事件顺序无效。');
      return;
    }
    this._acceptChange(event);
  }

  _acceptSnapshot(event, child) {
    if (!Array.isArray(event.processes) || event.processes.length > MAX_PROCESSES) {
      this._protocolFailure(child, '进程快照无效。');
      return;
    }
    const nextProcesses = new Map();
    for (const item of event.processes) {
      const pid = Number(item?.pid);
      const name = normalizeProcessName(item?.name);
      if (Number.isSafeInteger(pid) && pid > 0 && name) {
        nextProcesses.set(pid, {
          name,
          path: normalizeExecutablePath(item?.path),
        });
      }
    }
    const previousPresence = new Set(this._nameCounts.keys());
    this._processes = nextProcesses;
    this._rebuildNameCounts();
    const nextPresence = new Set(this._nameCounts.keys());
    const changedNames = symmetricDifference(previousPresence, nextPresence);
    const wasReady = this._ready;
    this._ready = true;
    this._error = '';
    if (!wasReady) {
      this._readySince = this._now();
    } else if (this._readySince > 0 && this._now() - this._readySince >= 60000) {
      this._restartAttempt = 0;
    }
    this._setStatus('ready', '');
    this._emit({
      type: 'change',
      kind: 'snapshot',
      names: [...changedNames],
      sequence: this._sequence,
      initial: !wasReady,
    });
  }

  _acceptChange(event) {
    const pid = Number(event.pid);
    const name = normalizeProcessName(event.name);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !name) {
      return;
    }
    const affected = new Set();
    const oldProcess = this._processes.get(pid);
    const oldName = oldProcess?.name ?? '';
    if (event.type === 'started') {
      if (oldName && processKey(oldName) !== processKey(name)) {
        affected.add(processKey(oldName));
      }
      affected.add(processKey(name));
      const before = presenceFor(this._nameCounts, affected);
      const process = { name, path: normalizeExecutablePath(event.path) };
      this._processes.set(pid, process);
      this._rebuildNameCounts();
      this._emitPresenceChange(event.type, before, affected, { pid, ...process });
      return;
    }

    if (!oldName || (event.name && processKey(oldName) !== processKey(name))) {
      return;
    }
    affected.add(processKey(oldName));
    const before = presenceFor(this._nameCounts, affected);
    this._processes.delete(pid);
    this._rebuildNameCounts();
    this._emitPresenceChange(event.type, before, affected, { pid, ...oldProcess });
  }

  _emitPresenceChange(kind, before, affected, process) {
    const changedNames = [...affected].filter(
      (name) => before.get(name) !== ((this._nameCounts.get(name) ?? 0) > 0),
    );
    this._emit({
      type: 'change',
      kind,
      names: changedNames,
      processes: [process],
      sequence: this._sequence,
    });
  }

  _rebuildNameCounts() {
    const counts = new Map();
    for (const process of this._processes.values()) {
      const key = processKey(process.name);
      if (key) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    this._nameCounts = counts;
  }

  _protocolFailure(child, message) {
    this._observerExited(child, message);
    try {
      child.kill();
    } catch {
      // The child may already have exited.
    }
  }

  _observerExited(child, message) {
    if (child && child.__leigodCleanHandled) {
      return;
    }
    if (child) {
      child.__leigodCleanHandled = true;
    }
    if (child && this._child !== child) {
      return;
    }
    if (this._shutdownTimer) {
      this._clearTimeout(this._shutdownTimer);
      this._shutdownTimer = null;
    }
    this._clearHealthTimer();
    this._child = null;
    if (this._stopping || !this._started) {
      this._child = null;
      return;
    }
    this._ready = false;
    this._restartCount += 1;
    this._setStatus('restarting', message);
    this._scheduleRestart();
  }

  _observerFailed(child, message) {
    if (child && child.__leigodCleanHandled) {
      return;
    }
    if (child) {
      child.__leigodCleanHandled = true;
    }
    if (child && this._child !== child) {
      return;
    }
    this._clearHealthTimer();
    this._child = null;
    this._ready = false;
    this._setStatus('failed', message);
  }

  _scheduleRestart() {
    if (this._restartTimer || this._stopping || !this._started) {
      return;
    }
    const index = Math.min(this._restartAttempt, this._restartDelays.length - 1);
    const delay = this._restartDelays[index];
    this._restartAttempt += 1;
    this._restartTimer = this._setTimeout(() => {
      this._restartTimer = null;
      this._spawnObserver();
    }, delay);
    this._restartTimer?.unref?.();
  }

  _clearRestartTimer() {
    if (this._restartTimer) {
      this._clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
  }

  _armHealthTimer(child, delay, message) {
    this._clearHealthTimer();
    this._healthTimer = this._setTimeout(() => {
      this._healthTimer = null;
      if (child !== this._child || this._stopping || !this._started) {
        return;
      }
      this._observerExited(child, message);
      try {
        child.kill();
      } catch {
        // The unresponsive observer may already have exited.
      }
    }, delay);
    this._healthTimer?.unref?.();
  }

  _clearHealthTimer() {
    if (this._healthTimer) {
      this._clearTimeout(this._healthTimer);
      this._healthTimer = null;
    }
  }

  _setStatus(status, error) {
    const changed = status !== this._status || String(error ?? '') !== this._error;
    this._status = status;
    this._error = String(error ?? '');
    if (changed) {
      this._emit({ type: 'health', ...this.snapshot });
    }
  }

  _emit(event) {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch (error) {
        this._log(`Process event listener failed: ${messageOf(error)}`);
      }
    }
  }
}

function presenceFor(counts, names) {
  return new Map([...names].map((name) => [name, (counts.get(name) ?? 0) > 0]));
}

function symmetricDifference(left, right) {
  const result = new Set();
  for (const value of left) {
    if (!right.has(value)) {
      result.add(value);
    }
  }
  for (const value of right) {
    if (!left.has(value)) {
      result.add(value);
    }
  }
  return result;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? '未知错误');
}

module.exports = {
  normalizeExecutablePath,
  normalizeProcessName,
  ProcessEventSource,
};

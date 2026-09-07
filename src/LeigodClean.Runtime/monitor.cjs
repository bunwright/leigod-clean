'use strict';

const STATES = Object.freeze({
  IDLE: 'idle',
  WAITING: 'waiting',
  ACTIVE: 'active',
  GRACE: 'grace',
  PAUSING: 'pausing',
  PAUSED: 'paused',
  MISSING: 'missing',
});

const AUXILIARY_PROCESS_MARKERS = [
  'crashhandler',
  'crashpad_handler',
  'crashreport',
];

function normalizeProcesses(input) {
  const values = Array.isArray(input)
    ? input
    : String(input ?? '').split(/[,，;；|\r\n]+/u);
  const seen = new Set();

  return values
    .map((value) => String(value ?? '').trim().replace(/^['"]|['"]$/gu, ''))
    .map((value) => value.split(/[\\/]/u).at(-1)?.trim() ?? '')
    .filter((value) => value.length > 0 && value.length <= 260)
    .filter((value) => !/[\/:*?"<>|]/u.test(value))
    .filter((value) => !AUXILIARY_PROCESS_MARKERS.some(
      (marker) => value.toLocaleLowerCase('en-US').includes(marker),
    ))
    .filter((value) => {
      const key = value.toLocaleLowerCase('en-US');
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
}

function resolveProcesses(gameId, officialProcesses, processOverrides = {}, communityGames = {}) {
  const key = String(gameId ?? '');
  const userProcesses = normalizeProcesses(processOverrides?.[key] ?? []);
  if (userProcesses.length > 0) {
    return userProcesses;
  }

  const communityProcesses = normalizeProcesses(communityGames?.[key] ?? []);
  if (communityProcesses.length > 0) {
    return communityProcesses;
  }

  return normalizeProcesses(officialProcesses);
}

class ProcessMonitor {
  constructor({
    isRunning,
    pause,
    onState = () => {},
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    pauseRetryMs = 30000,
  }) {
    if (typeof isRunning !== 'function' || typeof pause !== 'function') {
      throw new TypeError('ProcessMonitor requires isRunning and pause functions.');
    }

    this._isRunning = isRunning;
    this._pause = pause;
    this._onState = onState;
    this._now = now;
    this._setTimeout = setTimeoutFn;
    this._clearTimeout = clearTimeoutFn;
    this._pauseRetryMs = Math.min(5 * 60 * 1000, Math.max(1000, Number(pauseRetryMs) || 30000));

    this._generation = 0;
    this._timer = null;
    this._timerDeadline = 0;
    this._checking = false;
    this._pendingCheck = false;
    this._checkPromise = null;
    this._observerAvailable = true;
    this._suspendedRemainingMs = 0;
    this._reasonBeforeUnavailable = '';
    this._snapshot = this._emptySnapshot();
  }

  get snapshot() {
    const result = { ...this._snapshot, processes: [...this._snapshot.processes] };
    if (result.deadline > 0 && this._observerAvailable &&
      [STATES.WAITING, STATES.GRACE].includes(result.state)) {
      result.remainingMs = Math.max(0, result.deadline - this._now());
    }
    if (result.startedAt > 0) {
      result.elapsedMs = Math.max(0, this._now() - result.startedAt);
    }
    return result;
  }

  async start(processes, options = {}) {
    const normalized = normalizeProcesses(processes);
    this._clearDeadline();
    const generation = ++this._generation;
    const now = this._now();

    if (normalized.length === 0) {
      this._snapshot = {
        ...this._emptySnapshot(),
        state: STATES.MISSING,
        gameId: String(options.gameId ?? ''),
        gameName: String(options.gameName ?? ''),
        reason: 'process-list-missing',
        checkedAt: now,
      };
      this._emit();
      return this.snapshot;
    }

    const startupTimeoutMs = clampDuration(options.startupTimeoutMs, 15 * 60 * 1000);
    const graceMs = clampDuration(options.graceMs, 10 * 60 * 1000);
    this._snapshot = {
      state: STATES.WAITING,
      gameId: String(options.gameId ?? ''),
      gameName: String(options.gameName ?? ''),
      processes: normalized,
      activeProcess: '',
      reason: 'waiting-for-process',
      startedAt: now,
      deadline: now + startupTimeoutMs,
      remainingMs: startupTimeoutMs,
      elapsedMs: 0,
      checkedAt: now,
      graceMs,
      startupTimeoutMs,
      observerReady: this._observerAvailable,
      error: '',
    };
    if (!this._observerAvailable) {
      this._reasonBeforeUnavailable = this._snapshot.reason;
      this._suspendedRemainingMs = startupTimeoutMs;
      this._snapshot.reason = 'process-observer-unavailable';
    }
    this._emit();

    if (this._observerAvailable) {
      await this.checkNow();
      this._scheduleDeadline(generation);
    }

    return this.snapshot;
  }

  stop(reason = 'stopped') {
    this._clearDeadline();
    this._generation += 1;
    this._pendingCheck = false;
    this._suspendedRemainingMs = 0;
    this._reasonBeforeUnavailable = '';
    this._snapshot = {
      ...this._emptySnapshot(),
      state: STATES.IDLE,
      reason,
      checkedAt: this._now(),
      observerReady: this._observerAvailable,
    };
    this._emit();
    return this.snapshot;
  }

  async checkNow() {
    if (this._checking) {
      this._pendingCheck = true;
      await this._checkPromise;
      return this.snapshot;
    }

    const generation = this._generation;
    this._checking = true;
    this._checkPromise = (async () => {
      do {
        this._pendingCheck = false;
        await this._evaluate(generation);
      } while (this._pendingCheck && generation === this._generation);
    })();
    try {
      await this._checkPromise;
    } finally {
      this._checking = false;
      this._checkPromise = null;
    }
    return this.snapshot;
  }

  async processesChanged(changedNames = [], fullSnapshot = false) {
    if (!fullSnapshot) {
      const targets = new Set(this._snapshot.processes.map(processKey));
      const relevant = normalizeProcesses(changedNames).some((name) => targets.has(processKey(name)));
      if (!relevant) {
        return this.snapshot;
      }
    }
    return this.checkNow();
  }

  observerUnavailable(error) {
    const message = error instanceof Error ? error.message : String(error ?? '进程事件服务不可用。');
    if (!this._observerAvailable && this._snapshot.reason === 'process-observer-unavailable') {
      if (message !== this._snapshot.error) {
        this._snapshot.error = message;
        this._snapshot.checkedAt = this._now();
        this._emit();
      }
      return this.snapshot;
    }
    this._observerAvailable = false;
    if (this._snapshot.deadline > 0) {
      this._suspendedRemainingMs = Math.max(100, this._snapshot.deadline - this._now());
      this._snapshot.remainingMs = this._suspendedRemainingMs;
    }
    this._clearDeadline();
    if (this._isRunningState()) {
      this._reasonBeforeUnavailable = this._snapshot.reason;
      this._snapshot.reason = 'process-observer-unavailable';
    }
    this._snapshot.observerReady = false;
    this._snapshot.error = message;
    this._snapshot.checkedAt = this._now();
    this._emit();
    return this.snapshot;
  }

  async observerAvailable() {
    const recovered = !this._observerAvailable;
    this._observerAvailable = true;
    this._snapshot.observerReady = true;
    this._snapshot.error = '';
    if (recovered && this._isRunningState()) {
      const now = this._now();
      if (this._suspendedRemainingMs > 0 &&
        [STATES.WAITING, STATES.GRACE].includes(this._snapshot.state)) {
        this._snapshot.deadline = now + this._suspendedRemainingMs;
        this._snapshot.remainingMs = this._suspendedRemainingMs;
      }
      this._snapshot.reason = this._reasonBeforeUnavailable || this._snapshot.reason;
      this._snapshot.checkedAt = now;
      this._suspendedRemainingMs = 0;
      this._reasonBeforeUnavailable = '';
      this._emit();
      await this.checkNow();
    }
    return this.snapshot;
  }

  _emptySnapshot() {
    return {
      state: STATES.IDLE,
      gameId: '',
      gameName: '',
      processes: [],
      activeProcess: '',
      reason: 'idle',
      startedAt: 0,
      deadline: 0,
      remainingMs: 0,
      elapsedMs: 0,
      checkedAt: 0,
      graceMs: 0,
      startupTimeoutMs: 0,
      observerReady: this._observerAvailable,
      error: '',
    };
  }

  _isRunningState() {
    return [STATES.WAITING, STATES.ACTIVE, STATES.GRACE].includes(this._snapshot.state);
  }

  _clearDeadline() {
    if (this._timer) {
      this._clearTimeout(this._timer);
      this._timer = null;
    }
    this._timerDeadline = 0;
  }

  _scheduleDeadline(generation) {
    if (generation !== this._generation || !this._observerAvailable ||
      ![STATES.WAITING, STATES.GRACE].includes(this._snapshot.state) ||
      this._snapshot.deadline <= 0) {
      return;
    }
    if (this._timer && this._timerDeadline === this._snapshot.deadline) {
      return;
    }
    this._clearDeadline();
    const deadline = this._snapshot.deadline;
    const delay = Math.max(0, deadline - this._now());
    this._timerDeadline = deadline;
    this._timer = this._setTimeout(() => {
      this._timer = null;
      this._timerDeadline = 0;
      if (generation === this._generation && deadline === this._snapshot.deadline) {
        void this.checkNow();
      }
    }, delay);
    this._timer?.unref?.();
  }

  async _evaluate(generation) {
    if (generation !== this._generation || !this._observerAvailable || !this._isRunningState()) {
      return;
    }

    try {
      const match = await this._findRunningProcess();
      if (generation !== this._generation) {
        return;
      }

      const now = this._now();
      this._snapshot.checkedAt = now;
      this._snapshot.elapsedMs = Math.max(0, now - this._snapshot.startedAt);
      this._snapshot.error = '';

      if (match) {
        this._snapshot.state = STATES.ACTIVE;
        this._snapshot.activeProcess = match;
        this._snapshot.deadline = 0;
        this._snapshot.remainingMs = 0;
        this._snapshot.reason = 'process-running';
        this._clearDeadline();
        this._emit();
        return;
      }

      this._snapshot.activeProcess = '';
      if (this._snapshot.state === STATES.WAITING) {
        this._snapshot.remainingMs = Math.max(0, this._snapshot.deadline - now);
        if (now >= this._snapshot.deadline) {
          await this._pauseOnce(generation, 'startup-timeout');
        } else {
          this._emit();
          this._scheduleDeadline(generation);
        }
        return;
      }

      if (this._snapshot.state === STATES.ACTIVE) {
        this._snapshot.state = STATES.GRACE;
        this._snapshot.reason = 'process-handoff';
        this._snapshot.deadline = now + this._snapshot.graceMs;
        this._snapshot.remainingMs = this._snapshot.graceMs;
        this._emit();
        this._scheduleDeadline(generation);
        return;
      }

      this._snapshot.remainingMs = Math.max(0, this._snapshot.deadline - now);
      if (now >= this._snapshot.deadline) {
        const finalMatch = await this._findRunningProcess();
        if (generation !== this._generation) {
          return;
        }

        if (finalMatch) {
          this._snapshot.state = STATES.ACTIVE;
          this._snapshot.activeProcess = finalMatch;
          this._snapshot.deadline = 0;
          this._snapshot.remainingMs = 0;
          this._snapshot.reason = 'process-running';
          this._clearDeadline();
          this._emit();
        } else {
          await this._pauseOnce(generation, 'processes-exited');
        }
      } else {
        this._emit();
        this._scheduleDeadline(generation);
      }
    } catch (error) {
      if (generation === this._generation) {
        this.observerUnavailable(error);
      }
    }
  }

  async _findRunningProcess() {
    let firstError = null;

    for (const processName of this._snapshot.processes) {
      try {
        const running = await this._isRunning(processName);
        if (running) {
          return processName;
        }
      } catch (error) {
        firstError ??= error;
      }
    }

    if (firstError) {
      throw firstError;
    }

    return '';
  }

  async _pauseOnce(generation, reason) {
    if (generation !== this._generation || this._snapshot.state === STATES.PAUSING) {
      return;
    }

    this._clearDeadline();
    this._snapshot.state = STATES.PAUSING;
    this._snapshot.reason = reason;
    this._snapshot.remainingMs = 0;
    this._emit();

    try {
      await this._pause(reason);
      if (generation === this._generation) {
        this._snapshot.state = STATES.PAUSED;
        this._snapshot.reason = reason;
        this._snapshot.checkedAt = this._now();
        this._emit();
      }
    } catch (error) {
      if (generation === this._generation) {
        const now = this._now();
        this._snapshot.state = STATES.GRACE;
        this._snapshot.reason = 'pause-failed';
        this._snapshot.error = error instanceof Error ? error.message : String(error);
        this._snapshot.deadline = now + this._pauseRetryMs;
        this._snapshot.remainingMs = this._pauseRetryMs;
        this._snapshot.checkedAt = now;
        this._emit();
        this._scheduleDeadline(generation);
      }
    }
  }

  _emit() {
    this._onState(this.snapshot);
  }
}

function processKey(value) {
  const name = String(value ?? '').toLocaleLowerCase('en-US');
  return name && !name.endsWith('.exe') ? `${name}.exe` : name;
}

function clampDuration(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 100) {
    return fallback;
  }

  return Math.min(numeric, 24 * 60 * 60 * 1000);
}

module.exports = {
  ProcessMonitor,
  STATES,
  normalizeProcesses,
  resolveProcesses,
};

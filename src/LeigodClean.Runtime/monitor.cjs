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
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    pollIntervalMs = 1000,
    missThreshold = 2,
    pauseRetryMs = 30000,
  }) {
    if (typeof isRunning !== 'function' || typeof pause !== 'function') {
      throw new TypeError('ProcessMonitor requires isRunning and pause functions.');
    }

    this._isRunning = isRunning;
    this._pause = pause;
    this._onState = onState;
    this._now = now;
    this._setInterval = setIntervalFn;
    this._clearInterval = clearIntervalFn;
    this._pollIntervalMs = Math.max(250, Number(pollIntervalMs) || 1000);
    this._missThreshold = Math.max(1, Number(missThreshold) || 2);
    this._pauseRetryMs = Math.min(5 * 60 * 1000, Math.max(1000, Number(pauseRetryMs) || 30000));

    this._generation = 0;
    this._timer = null;
    this._checking = false;
    this._snapshot = this._emptySnapshot();
  }

  get snapshot() {
    return { ...this._snapshot, processes: [...this._snapshot.processes] };
  }

  async start(processes, options = {}) {
    const normalized = normalizeProcesses(processes);
    this._resetTimer();
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
      misses: 0,
      error: '',
    };
    this._emit();

    await this._tick(generation);
    this._ensureTimer(generation);

    return this.snapshot;
  }

  stop(reason = 'stopped') {
    this._resetTimer();
    this._generation += 1;
    this._checking = false;
    this._snapshot = {
      ...this._emptySnapshot(),
      state: STATES.IDLE,
      reason,
      checkedAt: this._now(),
    };
    this._emit();
    return this.snapshot;
  }

  async checkNow() {
    await this._tick(this._generation);
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
      misses: 0,
      error: '',
    };
  }

  _isRunningState() {
    return [STATES.WAITING, STATES.ACTIVE, STATES.GRACE].includes(this._snapshot.state);
  }

  _resetTimer() {
    if (this._timer) {
      this._clearInterval(this._timer);
      this._timer = null;
    }
  }

  _ensureTimer(generation) {
    if (generation === this._generation && !this._timer && this._isRunningState()) {
      this._timer = this._setInterval(() => {
        void this._tick(generation);
      }, this._pollIntervalMs);
    }
  }

  async _tick(generation) {
    if (generation !== this._generation || this._checking || !this._isRunningState()) {
      return;
    }

    this._checking = true;
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
        this._snapshot.misses = 0;
        this._snapshot.reason = 'process-running';
        this._emit();
        return;
      }

      this._snapshot.activeProcess = '';
      if (this._snapshot.state === STATES.WAITING) {
        this._snapshot.remainingMs = Math.max(0, this._snapshot.deadline - now);
        this._emit();
        if (now >= this._snapshot.deadline) {
          await this._pauseOnce(generation, 'startup-timeout');
        }
        return;
      }

      if (this._snapshot.state === STATES.ACTIVE) {
        this._snapshot.misses += 1;
        if (this._snapshot.misses >= this._missThreshold) {
          this._snapshot.state = STATES.GRACE;
          this._snapshot.reason = 'process-handoff';
          this._snapshot.deadline = now + this._snapshot.graceMs;
          this._snapshot.remainingMs = this._snapshot.graceMs;
        }
        this._emit();
        return;
      }

      this._snapshot.remainingMs = Math.max(0, this._snapshot.deadline - now);
      this._emit();
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
          this._snapshot.misses = 0;
          this._snapshot.reason = 'process-running';
          this._emit();
        } else {
          await this._pauseOnce(generation, 'processes-exited');
        }
      }
    } catch (error) {
      if (generation === this._generation) {
        this._snapshot.error = error instanceof Error ? error.message : String(error);
        this._snapshot.checkedAt = this._now();
        this._emit();
      }
    } finally {
      this._checking = false;
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

    this._resetTimer();
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
        this._ensureTimer(generation);
      }
    }
  }

  _emit() {
    this._onState(this.snapshot);
  }
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

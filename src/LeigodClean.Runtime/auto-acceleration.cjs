'use strict';

const DEFAULT_RETRY_MS = 30000;

class AutoEvaluationQueue {
  constructor({
    getOrder,
    evaluate,
    canContinue = () => true,
    onError = () => {},
  }) {
    if (typeof getOrder !== 'function' || typeof evaluate !== 'function') {
      throw new TypeError('AutoEvaluationQueue requires getOrder and evaluate functions.');
    }
    this._getOrder = getOrder;
    this._evaluate = evaluate;
    this._canContinue = canContinue;
    this._onError = onError;
    this._routine = new Set();
    this._routineInFlight = new Set();
    this._triggers = [];
    this._drainPromise = null;
    this._generation = 0;
  }

  enqueue(gameIds, { allowSwitch = false } = {}) {
    const values = uniqueGameIds(gameIds);
    if (values.length === 0) {
      return this._drainPromise;
    }
    if (allowSwitch) {
      // Keep process-start events separate: each real launch may switch once, while
      // aliases shared by multiple catalog entries must never cause a switch loop.
      this._triggers.push(values);
    } else {
      for (const gameId of values) {
        if (!this._routineInFlight.has(gameId)) {
          this._routine.add(gameId);
        }
      }
    }
    this._ensureDrain();
    return this._drainPromise;
  }

  clear() {
    this._generation += 1;
    this._routine.clear();
    this._routineInFlight.clear();
    this._triggers.length = 0;
  }

  get pending() {
    return this._routine.size + this._triggers.reduce((total, batch) => total + batch.length, 0);
  }

  _ensureDrain() {
    if (this._drainPromise) {
      return;
    }
    this._drainPromise = this._drain()
      .catch((error) => this._onError(error))
      .finally(() => {
        this._drainPromise = null;
        if (this.pending > 0 && this._canContinue()) {
          this._ensureDrain();
        }
      });
  }

  async _drain() {
    while (this.pending > 0 && this._canContinue()) {
      const generation = this._generation;
      const trigger = this._triggers.shift();
      const allowSwitch = Array.isArray(trigger);
      const queued = allowSwitch ? new Set(trigger) : new Set(this._routine);
      if (!allowSwitch) {
        this._routine.clear();
        this._routineInFlight = queued;
      }
      const ordered = uniqueGameIds(this._getOrder()).filter((gameId) => queued.has(gameId));
      let actionTaken = false;
      for (const gameId of ordered) {
        if (generation !== this._generation || !this._canContinue()) {
          break;
        }
        const started = await this._evaluate(gameId, allowSwitch && !actionTaken);
        actionTaken = started === true || actionTaken;
        if (allowSwitch && actionTaken) {
          break;
        }
      }
      if (!allowSwitch && generation === this._generation) {
        this._routineInFlight.clear();
      }
    }
  }
}

function uniqueGameIds(values) {
  const result = [];
  const seen = new Set();
  for (const value of values ?? []) {
    const gameId = gameIdOf(value);
    if (gameId && !seen.has(gameId)) {
      seen.add(gameId);
      result.push(gameId);
    }
  }
  return result;
}

function selectAutoEventGames(nameGameIds, locationGameIds, context = {}) {
  const byName = uniqueGameIds(nameGameIds);
  const precise = uniqueGameIds(locationGameIds);
  const candidates = precise.length > 0 ? precise : byName;
  const activeGameId = gameIdOf(context.activeGameId);
  const activeHandoff = context.accelerating === true && activeGameId &&
    (byName.includes(activeGameId) || precise.includes(activeGameId));
  return {
    gameIds: activeHandoff ? [activeGameId] : candidates,
    activeHandoff: Boolean(activeHandoff),
  };
}

function gameIdOf(value) {
  const candidate = value && typeof value === 'object'
    ? (value.id ?? value.gameId ?? value.game_id)
    : value;
  const id = Number(candidate);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : '';
}

function resolveAutoGameIds(settings = {}, discoveredGameIds = []) {
  const result = [];
  const seen = new Set();
  const append = (values) => {
    for (const value of values) {
      const id = gameIdOf(value);
      if (id && !seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
  };

  const dedicated = settings?.autoAccelerateGames &&
    typeof settings.autoAccelerateGames === 'object'
    ? Object.entries(settings.autoAccelerateGames)
      .filter(([, enabled]) => enabled === true)
      .map(([gameId]) => gameId)
    : [];
  append(dedicated);

  if (settings?.autoAccelerationEnabled === true) {
    const selections = settings?.gameSelections && typeof settings.gameSelections === 'object'
      ? Object.keys(settings.gameSelections)
      : [];
    append(selections);
    append(Array.isArray(discoveredGameIds) ? discoveredGameIds : []);
  }

  return result.slice(0, 500);
}

function defaultAutoSelection(game) {
  const area = Array.isArray(game?.areas)
    ? game.areas.find((item) => Number.isSafeInteger(Number(item?.id)) && Number(item.id) >= 0)
    : null;
  if (!area) {
    return null;
  }
  const subArea = Array.isArray(area.subAreas)
    ? area.subAreas.find((item) => Number.isSafeInteger(Number(item?.id)) && Number(item.id) >= 0)
    : null;
  return {
    areaId: Number(area.id),
    subAreaId: subArea ? Number(subArea.id) : -1,
    lineId: -1,
    assignId: -1,
  };
}

function evaluateAutoWatchState(state, input, now = Date.now()) {
  const next = {
    latched: state?.latched === true,
    retryAt: Math.max(0, Number(state?.retryAt) || 0),
  };

  if (!input.running) {
    next.latched = false;
    next.retryAt = 0;
    return { state: next, shouldStart: false };
  }

  if (input.accelerating && String(input.activeGameId || '') === String(input.gameId || '')) {
    next.latched = true;
  }

  return {
    state: next,
    shouldStart: !next.latched && now >= next.retryAt && input.loggedIn &&
      (!input.accelerating || input.allowSwitch === true),
  };
}

function completeAutoWatchAttempt(state, succeeded, now = Date.now(), retryMs = DEFAULT_RETRY_MS) {
  return {
    latched: succeeded === true,
    retryAt: succeeded === true ? 0 : now + Math.max(1000, Number(retryMs) || DEFAULT_RETRY_MS),
  };
}

module.exports = {
  AutoEvaluationQueue,
  completeAutoWatchAttempt,
  defaultAutoSelection,
  DEFAULT_RETRY_MS,
  evaluateAutoWatchState,
  resolveAutoGameIds,
  selectAutoEventGames,
};

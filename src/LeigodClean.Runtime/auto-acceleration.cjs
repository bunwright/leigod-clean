'use strict';

const DEFAULT_RETRY_MS = 30000;

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
    shouldStart: !next.latched && now >= next.retryAt && input.loggedIn && !input.accelerating,
  };
}

function completeAutoWatchAttempt(state, succeeded, now = Date.now(), retryMs = DEFAULT_RETRY_MS) {
  return {
    latched: succeeded === true,
    retryAt: succeeded === true ? 0 : now + Math.max(1000, Number(retryMs) || DEFAULT_RETRY_MS),
  };
}

module.exports = {
  completeAutoWatchAttempt,
  defaultAutoSelection,
  DEFAULT_RETRY_MS,
  evaluateAutoWatchState,
  resolveAutoGameIds,
};

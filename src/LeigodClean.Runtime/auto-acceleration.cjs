'use strict';

const DEFAULT_RETRY_MS = 30000;

function evaluateAutoWatchState(state, input, now = Date.now()) {
  const next = {
    latched: state?.latched === true,
    misses: Math.max(0, Number(state?.misses) || 0),
    retryAt: Math.max(0, Number(state?.retryAt) || 0),
  };

  if (!input.running) {
    next.misses += 1;
    if (next.misses >= 2) {
      next.latched = false;
      next.retryAt = 0;
    }
    return { state: next, shouldStart: false };
  }

  next.misses = 0;
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
    misses: 0,
    retryAt: succeeded === true ? 0 : now + Math.max(1000, Number(retryMs) || DEFAULT_RETRY_MS),
  };
}

module.exports = {
  completeAutoWatchAttempt,
  DEFAULT_RETRY_MS,
  evaluateAutoWatchState,
};

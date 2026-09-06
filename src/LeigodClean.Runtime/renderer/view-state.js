'use strict';

(function exposeViewState(root, factory) {
  const viewState = Object.freeze(factory());
  if (typeof module === 'object' && module.exports) {
    module.exports = viewState;
    return;
  }
  root.leigodCleanViewState = viewState;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  function idOf(value) {
    const id = Number(value);
    return Number.isFinite(id) && id > 0 ? String(id) : '';
  }

  function isActiveStatus(status) {
    return status === 'loading' || status === 'speeding';
  }

  function accelerationContext(client = {}, selectedGameId = '') {
    const status = String(client?.accStatus ?? 'normal');
    const activeGameId = isActiveStatus(status) ? idOf(client?.gameId) : '';
    const selectedId = idOf(selectedGameId);
    const selectedIsActive = Boolean(activeGameId && selectedId === activeGameId);
    return {
      status,
      activeGameId,
      selectedGameId: selectedId,
      selectedIsActive,
      anotherIsActive: Boolean(activeGameId && selectedId && selectedId !== activeGameId),
      accelerating: selectedIsActive && status === 'speeding',
      loading: selectedIsActive && status === 'loading',
      canStop: selectedIsActive && status === 'speeding',
    };
  }

  function shouldDisplayMonitor(client, monitor = {}, selectedGameId = '') {
    const context = accelerationContext(client, selectedGameId);
    if (context.selectedIsActive) {
      return true;
    }
    if (context.activeGameId) {
      return false;
    }
    return Boolean(
      context.selectedGameId && idOf(monitor?.gameId) === context.selectedGameId,
    );
  }

  function promoteGame(games, gameId) {
    if (!Array.isArray(games)) {
      return [];
    }
    const target = idOf(gameId);
    const index = target
      ? games.findIndex((game) => idOf(game?.id) === target)
      : -1;
    if (index <= 0) {
      return games;
    }
    return [games[index], ...games.slice(0, index), ...games.slice(index + 1)];
  }

  return {
    accelerationContext,
    promoteGame,
    shouldDisplayMonitor,
  };
});

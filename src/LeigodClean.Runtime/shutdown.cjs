'use strict';

function createExitConfirmation({
  confirm,
  exit,
  onError = () => {},
}) {
  if (typeof confirm !== 'function' || typeof exit !== 'function') {
    throw new TypeError('Exit confirmation and exit operations are required.');
  }

  let pending = null;

  function request() {
    if (pending) {
      return pending;
    }
    pending = Promise.resolve()
      .then(confirm)
      .then(async (confirmed) => {
        if (confirmed !== true) {
          return false;
        }
        await exit();
        return true;
      })
      .catch((error) => {
        try {
          onError(error);
        } catch {
          // A confirmation failure must leave the application open.
        }
        return false;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  return Object.freeze({
    request,
    get pending() {
      return pending !== null;
    },
  });
}

function createShutdownCoordinator({
  conceal,
  prepare,
  dispose,
  exit,
  onError = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
  timeoutMs = 5000,
}) {
  for (const [name, operation] of Object.entries({ conceal, prepare, dispose, exit })) {
    if (typeof operation !== 'function') {
      throw new TypeError(`Shutdown ${name} operation is required.`);
    }
  }

  let phase = 'idle';
  let completion = null;
  let forceTimer = null;

  function report(stage, error) {
    try {
      onError(error, stage);
    } catch {
      // Shutdown must continue even when diagnostics are unavailable.
    }
  }

  function finish() {
    if (phase === 'finished') {
      return false;
    }
    phase = 'finished';
    if (forceTimer !== null) {
      try {
        cancel(forceTimer);
      } catch (error) {
        report('cancel-timeout', error);
      }
      forceTimer = null;
    }
    try {
      dispose();
    } catch (error) {
      report('dispose', error);
    }
    try {
      exit(0);
    } catch (error) {
      report('exit', error);
    }
    return true;
  }

  function request() {
    if (completion) {
      return completion;
    }
    phase = 'closing';
    try {
      conceal();
    } catch (error) {
      report('conceal', error);
    }
    try {
      forceTimer = schedule(finish, Math.max(0, Number(timeoutMs) || 0));
    } catch (error) {
      report('schedule-timeout', error);
    }
    completion = Promise.resolve()
      .then(prepare)
      .catch((error) => report('prepare', error))
      .finally(finish);
    return completion;
  }

  return Object.freeze({
    request,
    finish,
    get phase() {
      return phase;
    },
  });
}

module.exports = { createExitConfirmation, createShutdownCoordinator };

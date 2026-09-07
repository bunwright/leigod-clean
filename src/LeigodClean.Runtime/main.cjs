'use strict';

module.exports = function startLeigodClean(officialRequire) {
  const singletonKey = Symbol.for('dev.leigodclean.runtime');
  if (globalThis[singletonKey]) {
    return;
  }
  globalThis[singletonKey] = true;

  const electron = officialRequire('electron');
  const {
    app,
    BrowserWindow,
    clipboard,
    dialog,
    ipcMain,
    Menu,
    nativeImage,
    Notification,
    shell,
    Tray,
  } = electron;
  const fs = require('node:fs');
  const path = require('node:path');
  const {
    completeAutoWatchAttempt,
    defaultAutoSelection,
    evaluateAutoWatchState,
    resolveAutoGameIds,
  } = require('./auto-acceleration.cjs');
  const { OfficialBridge } = require('./official-bridge.cjs');
  const { normalizeProcessName, ProcessEventSource } = require('./process-events.cjs');
  const {
    ProcessMonitor,
    STATES,
    normalizeProcesses,
    resolveProcesses: resolveProcessCatalog,
  } = require('./monitor.cjs');

  const runtimeRoot = __dirname;
  const localAppData = String(process.env.LOCALAPPDATA ?? '').trim();
  if (!localAppData) {
    throw new Error('Windows LOCALAPPDATA is unavailable.');
  }
  const dataRoot = path.join(localAppData, 'LeigodClean');
  const logPath = path.join(dataRoot, 'runtime.log');
  const settingsPath = path.join(dataRoot, 'settings.json');
  const launcherPathFile = path.join(runtimeRoot, 'launcher.path');
  const product = readJson(path.join(runtimeRoot, 'product.json'), {
    name: 'LeigodClean',
    version: 'unknown',
    versionDate: '',
    description: '面向 Windows 的简洁雷神加速控制界面。',
  });
  const startedAt = new Date().toISOString();
  const officialClientVersion = readText(
    path.join(path.dirname(process.resourcesPath), 'version_f.txt'),
    'unknown',
  );
  const startHidden = process.env.LEIGOD_CLEAN_START_HIDDEN === '1';
  const defaults = Object.freeze({
    autoAccelerationEnabled: false,
    autoPauseEnabled: true,
    launchAtLogin: false,
    minimizeToTray: true,
    pauseOnClose: true,
    notificationsEnabled: true,
    startupTimeoutMinutes: 15,
    graceMinutes: 10,
    autoAccelerateGames: {},
    gameSelections: {},
    processOverrides: {},
  });
  const community = readJson(path.join(runtimeRoot, 'community-processes.json'), {
    excludedGameIds: [],
    games: {},
  });

  let settings = loadSettings();
  let officialWindow = null;
  let officialWindowScore = -1;
  let cleanWindow = null;
  let tray = null;
  let appIcon = null;
  let trayMenuSignature = '';
  let officialVisible = false;
  let creatingCleanWindow = false;
  let closing = false;
  let stateRefreshing = false;
  let officialStateWatchGeneration = 0;
  let officialStateWatchWindowId = 0;
  let officialStateWatchRetryTimer = null;
  let bridgeFallbackTimer = null;
  let pendingStartUntil = 0;
  let monitoredGameId = '';
  let autoPauseInProgress = false;
  let autoStartBusy = false;
  let autoCandidateIds = [];
  let autoCandidatesLoadedAt = 0;
  let autoIndexGeneration = 0;
  let autoIndexPromise = null;
  let autoEvaluationPromise = null;
  const autoGameCache = new Map();
  const autoWatchStates = new Map();
  const autoProcessIndex = new Map();
  const pendingAutoGameIds = new Set();
  const autoRetryTimers = new Map();
  let lastOfficialState = {
    ready: false,
    isLogin: false,
    accStatus: 'normal',
    gameId: 0,
  };
  const normalTitleBarOverlay = Object.freeze({
    color: '#F7F7F8',
    symbolColor: '#3A3A3D',
    height: 62,
  });
  const modalTitleBarOverlay = Object.freeze({
    color: '#C4C4C6',
    symbolColor: '#77777C',
    height: 62,
  });

  prepareLog();
  log(`LeigodClean runtime starting; client=${officialClientVersion}`);

  let processEvents = null;
  try {
    const launcherPath = fs.readFileSync(launcherPathFile, 'utf8').trim();
    if (!launcherPath || !fs.existsSync(launcherPath)) {
      throw new Error('无法定位 LeigodClean 进程事件服务。');
    }
    processEvents = new ProcessEventSource({ launcherPath, log });
  } catch (error) {
    log(`Process event service unavailable: ${messageOf(error)}`);
  }

  const bridge = new OfficialBridge(() => officialWindow, log);
  const monitor = new ProcessMonitor({
    isRunning: async (processName) => {
      if (!processEvents) {
        throw new Error('进程事件服务不可用。');
      }
      return processEvents.isRunning(processName);
    },
    pause: async (reason) => performPause(reason),
    onState: (snapshot) => {
      log(`Monitor state=${snapshot.state} reason=${snapshot.reason} game=${snapshot.gameId}`);
      sendState();
      updateTrayMenu();
    },
  });
  if (processEvents) {
    monitor.observerUnavailable('进程事件服务正在启动。');
    processEvents.subscribe(handleProcessEvent);
  } else {
    monitor.observerUnavailable('进程事件服务不可用。');
  }

  patchOfficialIpc();
  observeWindows();

  app.whenReady().then(() => {
    registerCleanIpc();
    try {
      createTray();
    } catch (error) {
      log(`Tray initialization failed: ${messageOf(error)}`);
    }
    createCleanWindow();
    processEvents?.start();
    try {
      configureLoginItem(settings.launchAtLogin);
    } catch (error) {
      log(`Login item synchronization failed: ${messageOf(error)}`);
    }
  }).catch((error) => {
    log(`Clean window startup failed: ${error?.stack ?? messageOf(error)}`);
    officialVisible = true;
    showOfficialWindow();
    dialog.showErrorBox('LeigodClean', messageOf(error));
  });

  try {
    officialRequire('bytenode');
    officialRequire('./main.jsc');
  } catch (error) {
    log(`Official client failed to start: ${error?.stack ?? messageOf(error)}`);
    dialog.showErrorBox('LeigodClean', `官方客户端启动失败：${messageOf(error)}`);
  }

  function patchOfficialIpc() {
    const originalHandle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, listener) => {
      if (channel === 'leigod-simplify-start-acc') {
        return originalHandle(channel, async (event, ...args) => {
          const result = await listener(event, ...args);
          const code = Number(result?.result?.code ?? result?.code ?? -1);
          if (code === 0 || code === 200) {
            const gameId = args[0]?.game_id;
            setTimeout(() => void attachMonitor(gameId), 0);
          }
          return result;
        });
      }

      if (channel === 'leigod-simplify-stop-acc') {
        return originalHandle(channel, async (event, ...args) => {
          const result = await listener(event, ...args);
          if (!autoPauseInProgress) {
            monitoredGameId = '';
            monitor.stop('acceleration-stopped');
          }
          return result;
        });
      }

      if (channel === 'leigod-simplify-pause-user-time') {
        return originalHandle(channel, async (event, ...args) => {
          const result = await listener(event, ...args);
          if (!autoPauseInProgress) {
            monitoredGameId = '';
            monitor.stop('time-paused');
          }
          return result;
        });
      }

      return originalHandle(channel, listener);
    };
  }

  function observeWindows() {
    app.on('browser-window-created', (_event, window) => {
      if (creatingCleanWindow || window.getTitle() === 'LeigodClean') {
        return;
      }

      suppressOfficialWindow(window);
      window.webContents.on('did-finish-load', () => {
        const url = window.webContents.getURL();
        const bounds = window.getBounds();
        const recognized = url.includes('renderer.asar/index.html');
        const score = (recognized ? 1_000_000_000 : 0) + (bounds.width * bounds.height);
        captureOfficialWindow(window, score);
      });
    });
  }

  function suppressOfficialWindow(window) {
    if (window.isDestroyed()) {
      return;
    }
    if (!officialVisible) {
      window.hide();
      window.setSkipTaskbar(true);
    } else {
      window.setSkipTaskbar(false);
    }
    window.on('show', () => {
      if (!officialVisible && !window.isDestroyed()) {
        setImmediate(() => {
          if (!officialVisible && !window.isDestroyed()) {
            window.hide();
            window.setSkipTaskbar(true);
          }
        });
      }
    });
  }

  function captureOfficialWindow(window, score) {
    if (window === cleanWindow || window.isDestroyed()) {
      return;
    }
    if (officialWindow && !officialWindow.isDestroyed() &&
      officialWindow !== window && score <= officialWindowScore) {
      return;
    }

    if (officialWindow !== window) {
      if (officialWindow && !officialWindow.isDestroyed()) {
        bridge.invalidate(officialWindow);
      }
      officialWindow = window;
      officialWindowScore = score;
      log(`Official window captured id=${window.id}`);
      window.on('closed', () => {
        if (officialWindow === window) {
          bridge.invalidate(window);
          officialWindow = null;
          officialWindowScore = -1;
          stopOfficialStateWatch();
          lastOfficialState = { ...lastOfficialState, ready: false };
          sendState();
        }
      });
    } else {
      officialWindowScore = Math.max(officialWindowScore, score);
      bridge.invalidate(window);
    }
    void bridge.install()
      .then(() => startOfficialStateWatch(window))
      .catch((error) => log(`Official bridge install deferred: ${messageOf(error)}`));
    scheduleCompatibilityFallback();

    if (!officialVisible && cleanWindow && !cleanWindow.isDestroyed() && cleanWindow.isVisible()) {
      hideOfficialWindow();
    }
  }

  function scheduleCompatibilityFallback() {
    if (bridgeFallbackTimer) {
      clearTimeout(bridgeFallbackTimer);
    }
    bridgeFallbackTimer = setTimeout(() => {
      bridgeFallbackTimer = null;
      if (!lastOfficialState.ready && officialWindow && !officialWindow.isDestroyed()) {
        log('Official bridge did not become ready; showing the official interface');
        showOfficialWindow();
      }
    }, 20_000);
  }

  function cancelCompatibilityFallback() {
    if (!bridgeFallbackTimer) {
      return;
    }
    clearTimeout(bridgeFallbackTimer);
    bridgeFallbackTimer = null;
  }

  function createCleanWindow() {
    creatingCleanWindow = true;
    try {
      cleanWindow = new BrowserWindow({
        title: 'LeigodClean',
        icon: appIcon,
        width: 1120,
        height: 740,
        minWidth: 920,
        minHeight: 620,
        center: true,
        show: false,
        frame: true,
        titleBarStyle: 'hidden',
        titleBarOverlay: { ...normalTitleBarOverlay },
        backgroundColor: '#F5F5F7',
        roundedCorners: true,
        thickFrame: true,
        webPreferences: {
          preload: path.join(runtimeRoot, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          devTools: process.env.LEIGOD_CLEAN_DEVTOOLS === '1',
        },
      });
    } finally {
      creatingCleanWindow = false;
    }

    cleanWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    cleanWindow.webContents.on('will-navigate', (event, url) => {
      if (url !== cleanWindow.webContents.getURL()) {
        event.preventDefault();
      }
    });
    cleanWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    cleanWindow.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame) {
        return;
      }
      log(`Clean renderer failed to load: ${code} ${description}`);
      officialVisible = true;
      showOfficialWindow();
    });
    cleanWindow.webContents.on('render-process-gone', (_event, details) => {
      if (closing) {
        return;
      }
      log(`Clean renderer exited unexpectedly: ${details.reason}`);
      officialVisible = true;
      showOfficialWindow();
    });
    cleanWindow.once('ready-to-show', () => {
      if (!startHidden || !tray) {
        cleanWindow?.show();
      }
      if (!officialVisible) {
        hideOfficialWindow();
      }
      sendState();
    });
    cleanWindow.on('minimize', (event) => {
      if (settings.minimizeToTray && tray) {
        event.preventDefault();
        cleanWindow?.hide();
      }
    });
    cleanWindow.on('close', (event) => {
      if (closing) {
        return;
      }
      event.preventDefault();
      closing = true;
      void closeApplication();
    });
    cleanWindow.on('closed', () => {
      cleanWindow = null;
    });
    void cleanWindow.loadFile(path.join(runtimeRoot, 'renderer', 'index.html'));
  }

  function setCleanModalOpen(open) {
    if (!cleanWindow || cleanWindow.isDestroyed()) {
      return false;
    }
    if (typeof cleanWindow.setTitleBarOverlay === 'function') {
      cleanWindow.setTitleBarOverlay({
        ...(open ? modalTitleBarOverlay : normalTitleBarOverlay),
      });
    }
    return true;
  }

  function createTray() {
    if (tray) {
      return;
    }
    appIcon = nativeImage.createFromPath(path.join(runtimeRoot, 'assets', 'leigodclean.png'));
    if (appIcon.isEmpty()) {
      appIcon = nativeImage.createFromPath(process.execPath);
    }
    tray = new Tray(appIcon.resize({ width: 20, height: 20 }));
    tray.setToolTip('LeigodClean');
    tray.on('click', showCleanWindow);
    updateTrayMenu(true);
  }

  function updateTrayMenu(force = false) {
    if (!tray) {
      return;
    }
    const signature = [
      lastOfficialState.isLogin,
      lastOfficialState.accStatus,
      lastOfficialState.timeStatus,
      monitor.snapshot.state,
    ].join(':');
    if (!force && signature === trayMenuSignature) {
      return;
    }
    trayMenuSignature = signature;
    const canPause = Boolean(lastOfficialState.isLogin &&
      (lastOfficialState.accStatus !== 'normal' || lastOfficialState.timeStatus !== 'pause'));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 LeigodClean', click: showCleanWindow },
      {
        label: '停止加速并暂停时长',
        enabled: canPause,
        click: () => void pauseFromTray(),
      },
      { label: '打开官方客户端界面', click: showOfficialWindow },
      { type: 'separator' },
      { label: '退出', click: () => cleanWindow?.close() },
    ]));
  }

  function showCleanWindow() {
    officialVisible = false;
    hideOfficialWindow();
    if (!cleanWindow || cleanWindow.isDestroyed()) {
      return;
    }
    if (cleanWindow.isMinimized()) {
      cleanWindow.restore();
    }
    cleanWindow.show();
    cleanWindow.focus();
  }

  async function pauseFromTray() {
    try {
      monitoredGameId = '';
      monitor.stop('manual-pause');
      await performPause('manual-pause');
    } catch (error) {
      log(`Tray pause failed: ${messageOf(error)}`);
      if (Notification.isSupported()) {
        new Notification({ title: 'LeigodClean', body: messageOf(error), icon: appIcon }).show();
      }
    }
  }

  function configureLoginItem(enabled) {
    let launcherPath = '';
    try {
      launcherPath = fs.readFileSync(launcherPathFile, 'utf8').trim();
    } catch {
      // The launcher writes this file before starting the official client.
    }
    if (!launcherPath || (enabled && !fs.existsSync(launcherPath))) {
      if (enabled) {
        const error = new Error('无法定位 LeigodClean.exe，暂不能设置开机启动。');
        error.code = 'LAUNCHER_PATH_MISSING';
        throw error;
      }
      return;
    }
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: launcherPath,
      args: ['--background'],
      name: 'LeigodClean',
    });
  }

  function registerCleanIpc() {
    ipcMain.handle('leigod-clean:invoke', async (event, method, payload) => {
      if (!cleanWindow || event.sender !== cleanWindow.webContents) {
        return failure('IPC_SENDER_REJECTED', '请求来源无效。');
      }

      try {
        const result = await invokeCleanMethod(String(method ?? ''), payload ?? {});
        return { ok: true, data: result };
      } catch (error) {
        log(`IPC ${method} failed: ${messageOf(error)}`);
        return failure(error?.code ?? 'OPERATION_FAILED', messageOf(error));
      }
    });
  }

  async function invokeCleanMethod(method, payload) {
    switch (method) {
      case 'initialize':
        await refreshOfficialState();
        return combinedState();
      case 'searchGames':
        return bridge.call('searchGames', {
          query: String(payload.query ?? '').slice(0, 100),
          limit: Math.min(100, Math.max(1, Number(payload.limit) || 60)),
        });
      case 'getGame': {
        const gameId = numericId(payload.gameId);
        const game = await bridge.call('getGame', { gameId });
        return { ...game, processes: resolveProcesses(gameId, game.processes) };
      }
      case 'getLines':
        return bridge.call('getLines', {
          gameId: numericId(payload.gameId),
          areaId: numericId(payload.areaId),
          subAreaId: optionalNumericId(payload.subAreaId),
          refresh: Boolean(payload.refresh),
        });
      case 'start': {
        pendingStartUntil = Date.now() + 30000;
        const result = await bridge.call('start', {
          gameId: numericId(payload.gameId),
          areaId: numericId(payload.areaId),
          subAreaId: optionalNumericId(payload.subAreaId),
          lineKey: String(payload.lineKey ?? '').slice(0, 240),
        });
        if (result?.needsAttention) {
          showOfficialWindow();
        }
        if (result?.state) {
          acceptOfficialState(result.state);
        }
        return combinedState();
      }
      case 'stopAcceleration': {
        monitoredGameId = '';
        monitor.stop('manual-stop');
        const next = await bridge.call('stop');
        acceptOfficialState(next);
        return combinedState();
      }
      case 'pauseTime':
        monitoredGameId = '';
        monitor.stop('manual-pause');
        return performPause('manual-pause');
      case 'resumeTime': {
        const next = await bridge.call('resume');
        acceptOfficialState(next);
        return combinedState();
      }
      case 'showOfficial':
        showOfficialWindow();
        return combinedState();
      case 'hideOfficial':
        hideOfficialWindow();
        cleanWindow?.show();
        cleanWindow?.focus();
        return combinedState();
      case 'getSettings':
        return publicSettings();
      case 'updateSettings':
        {
          const nextSettings = validateSettings(payload);
          if (nextSettings.launchAtLogin !== settings.launchAtLogin) {
            configureLoginItem(nextSettings.launchAtLogin);
          }
          settings = nextSettings;
        }
        saveSettings();
        resetAutoAccelerationIndex(true);
        void refreshAutoAccelerationIndex({ forceCandidates: true, evaluate: true });
        if (!settings.autoPauseEnabled) {
          monitor.stop('automatic-pause-disabled');
        } else if (lastOfficialState.gameId && lastOfficialState.accStatus !== 'normal') {
          await attachMonitor(lastOfficialState.gameId, true);
        } else if (monitoredGameId && monitor.snapshot.state === STATES.MISSING) {
          await attachMonitor(monitoredGameId, true);
        }
        return publicSettings();
      case 'setGameAutoAcceleration': {
        const gameId = String(numericId(payload.gameId));
        const enabled = Boolean(payload.enabled);
        if (enabled && !settings.gameSelections[gameId]) {
          const error = new Error('请先为该游戏选择区服与线路。');
          error.code = 'SELECTION_REQUIRED';
          throw error;
        }
        const games = { ...settings.autoAccelerateGames };
        if (enabled) {
          games[gameId] = true;
        } else {
          delete games[gameId];
        }
        settings.autoAccelerateGames = games;
        autoGameCache.delete(gameId);
        autoWatchStates.delete(gameId);
        saveSettings();
        void refreshAutoAccelerationIndex({ evaluate: true });
        return publicSettings();
      }
      case 'rememberSelection': {
        const gameId = String(numericId(payload.gameId));
        const selection = normalizeGameSelection(payload);
        settings.gameSelections = { ...settings.gameSelections, [gameId]: selection };
        saveSettings();
        if (settings.autoAccelerationEnabled) {
          autoWatchStates.delete(gameId);
          void refreshAutoAccelerationIndex({ evaluate: true });
        }
        return selection;
      }
      case 'setModalOpen':
        return setCleanModalOpen(Boolean(payload.open));
      case 'openLogs':
        shell.showItemInFolder(logPath);
        return true;
      case 'copyDiagnostics': {
        const diagnostics = await buildDiagnostics();
        clipboard.writeText(JSON.stringify(diagnostics, null, 2));
        return true;
      }
      default: {
        const error = new Error('不支持的操作。');
        error.code = 'METHOD_NOT_ALLOWED';
        throw error;
      }
    }
  }

  async function refreshOfficialState() {
    if (stateRefreshing || !officialWindow || officialWindow.isDestroyed()) {
      return;
    }
    stateRefreshing = true;
    try {
      acceptOfficialState(await bridge.call('state'));
    } catch (error) {
      acceptOfficialState({
        ...lastOfficialState,
        ready: false,
        error: messageOf(error),
      });
    } finally {
      stateRefreshing = false;
    }
  }

  function startOfficialStateWatch(window) {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    if (officialStateWatchWindowId === window.webContents.id &&
      officialStateWatchGeneration > 0) {
      return;
    }
    stopOfficialStateWatch();
    officialStateWatchWindowId = window.webContents.id;
    const generation = ++officialStateWatchGeneration;
    void watchOfficialState(window, generation, 0);
  }

  function stopOfficialStateWatch() {
    officialStateWatchGeneration += 1;
    officialStateWatchWindowId = 0;
    if (officialStateWatchRetryTimer) {
      clearTimeout(officialStateWatchRetryTimer);
      officialStateWatchRetryTimer = null;
    }
  }

  async function watchOfficialState(window, generation, afterRevision) {
    if (generation !== officialStateWatchGeneration || window !== officialWindow ||
      window.isDestroyed() || window.webContents.isDestroyed() || closing) {
      return;
    }
    try {
      const update = await bridge.call('watchState', { afterRevision, timeoutMs: 60000 });
      if (generation !== officialStateWatchGeneration || window !== officialWindow || closing) {
        return;
      }
      acceptOfficialState(update?.state);
      if (update?.heartbeat && settings.autoAccelerationEnabled &&
        Date.now() - autoCandidatesLoadedAt >= 5 * 60 * 1000) {
        void refreshAutoAccelerationIndex({ forceCandidates: true, evaluate: true });
      }
      const revision = Number.isSafeInteger(Number(update?.revision))
        ? Number(update.revision)
        : afterRevision;
      setImmediate(() => void watchOfficialState(window, generation, revision));
    } catch (error) {
      if (generation !== officialStateWatchGeneration || window !== officialWindow || closing) {
        return;
      }
      const message = messageOf(error);
      log(`Official state subscription interrupted: ${message}`);
      acceptOfficialState({ ...lastOfficialState, ready: false, error: message });
      officialStateWatchRetryTimer = setTimeout(() => {
        officialStateWatchRetryTimer = null;
        void watchOfficialState(window, generation, afterRevision);
      }, 2000);
      officialStateWatchRetryTimer?.unref?.();
    }
  }

  function handleProcessEvent(event) {
    if (!processEvents) {
      return;
    }
    if (event.type === 'health') {
      if (!event.ready) {
        monitor.observerUnavailable(event.error || '进程事件服务正在重新连接。');
        log(`Process event service state=${event.status}${event.error ? ` error=${event.error}` : ''}`);
      }
      sendState();
      return;
    }
    if (event.type !== 'change' || !processEvents.snapshot.ready) {
      return;
    }

    const fullSnapshot = event.kind === 'snapshot';
    const monitorWasUnavailable = !monitor.snapshot.observerReady;
    void monitor.observerAvailable()
      .then(() => monitorWasUnavailable
        ? monitor.snapshot
        : monitor.processesChanged(event.names, fullSnapshot));
    handleAutomaticProcessChange(event.names, fullSnapshot, event.kind, event.initial);
    sendState();
  }

  function handleAutomaticProcessChange(names, fullSnapshot, kind, initial) {
    if (!processEvents?.snapshot.ready) {
      return;
    }
    if (fullSnapshot && (initial || autoProcessIndex.size === 0)) {
      void refreshAutoAccelerationIndex({ evaluate: true });
      return;
    }

    const gameIds = new Set();
    const changedProcesses = normalizeProcesses(names);
    for (const processName of changedProcesses) {
      for (const gameId of autoProcessIndex.get(processKey(processName)) ?? []) {
        gameIds.add(gameId);
      }
    }
    queueAutoEvaluation(gameIds);

    if ((kind === 'started' || fullSnapshot) && changedProcesses.length > 0 &&
      settings.autoAccelerationEnabled && gameIds.size === 0 &&
      Date.now() - autoCandidatesLoadedAt >= 30000) {
      void refreshAutoAccelerationIndex({ forceCandidates: true, evaluate: true });
    }
  }

  function resetAutoAccelerationIndex(clearCandidates = false) {
    autoIndexGeneration += 1;
    autoIndexPromise = null;
    autoProcessIndex.clear();
    pendingAutoGameIds.clear();
    autoGameCache.clear();
    autoWatchStates.clear();
    for (const timer of autoRetryTimers.values()) {
      clearTimeout(timer);
    }
    autoRetryTimers.clear();
    if (clearCandidates) {
      autoCandidateIds = [];
      autoCandidatesLoadedAt = 0;
    }
  }

  async function refreshAutoAccelerationIndex({ forceCandidates = false, evaluate = false } = {}) {
    const dedicatedGameIds = resolveAutoGameIds(settings);
    const hasGlobalTargets = settings.autoAccelerationEnabled === true;
    if ((!hasGlobalTargets && dedicatedGameIds.length === 0) || !lastOfficialState.ready) {
      if (!hasGlobalTargets && dedicatedGameIds.length === 0) {
        resetAutoAccelerationIndex(true);
      }
      return;
    }
    if (autoIndexPromise) {
      const pendingIndex = autoIndexPromise;
      const pendingGeneration = autoIndexGeneration;
      await pendingIndex;
      if (evaluate && pendingGeneration === autoIndexGeneration) {
        queueAutoEvaluation(resolveAutoGameIds(settings, autoCandidateIds));
      }
      return;
    }

    const generation = ++autoIndexGeneration;
    const buildPromise = (async () => {
      if (hasGlobalTargets && (forceCandidates || autoCandidatesLoadedAt === 0)) {
        try {
          const discovered = await bridge.call('autoCandidates');
          if (generation !== autoIndexGeneration) {
            return;
          }
          autoCandidateIds = Array.isArray(discovered) ? discovered : [];
          autoCandidatesLoadedAt = Date.now();
        } catch (error) {
          if (generation === autoIndexGeneration) {
            autoCandidatesLoadedAt = 0;
            log(`Global automatic acceleration discovery failed: ${messageOf(error)}`);
          }
        }
      }

      const gameIds = resolveAutoGameIds(settings, autoCandidateIds);
      const entries = [];
      for (const gameId of gameIds) {
        try {
          entries.push([gameId, await getAutoGame(gameId)]);
        } catch (error) {
          log(`Automatic acceleration index skipped game ${gameId}: ${messageOf(error)}`);
        }
        if (generation !== autoIndexGeneration) {
          return;
        }
      }

      autoProcessIndex.clear();
      const retainedIds = new Set(entries.map(([gameId]) => gameId));
      for (const [gameId, game] of entries) {
        for (const processName of game.processes) {
          const key = processKey(processName);
          if (!key) {
            continue;
          }
          if (!autoProcessIndex.has(key)) {
            autoProcessIndex.set(key, new Set());
          }
          autoProcessIndex.get(key).add(gameId);
        }
      }
      for (const gameId of autoWatchStates.keys()) {
        if (!retainedIds.has(gameId)) {
          autoWatchStates.delete(gameId);
          clearAutoRetry(gameId);
        }
      }
      if (evaluate) {
        queueAutoEvaluation(gameIds);
      }
    })();
    autoIndexPromise = buildPromise;
    try {
      await buildPromise;
    } finally {
      if (generation === autoIndexGeneration && autoIndexPromise === buildPromise) {
        autoIndexPromise = null;
      }
    }
  }

  function queueAutoEvaluation(gameIds) {
    for (const value of gameIds ?? []) {
      const gameId = String(value ?? '');
      if (gameId) {
        pendingAutoGameIds.add(gameId);
      }
    }
    if (pendingAutoGameIds.size === 0) {
      return;
    }
    if (!autoEvaluationPromise) {
      autoEvaluationPromise = drainAutoEvaluations().finally(() => {
        autoEvaluationPromise = null;
        if (pendingAutoGameIds.size > 0) {
          queueAutoEvaluation([]);
        }
      });
    }
  }

  async function drainAutoEvaluations() {
    while (pendingAutoGameIds.size > 0 && !closing) {
      const order = resolveAutoGameIds(settings, autoCandidateIds);
      const batch = order.filter((gameId) => pendingAutoGameIds.delete(gameId));
      for (const gameId of batch) {
        await evaluateAutoGame(gameId);
      }
      for (const stale of pendingAutoGameIds) {
        if (!order.includes(stale)) {
          pendingAutoGameIds.delete(stale);
        }
      }
    }
  }

  async function evaluateAutoGame(gameId) {
    const game = autoGameCache.get(gameId);
    if (!game || !processEvents?.snapshot.ready ||
      !resolveAutoGameIds(settings, autoCandidateIds).includes(gameId)) {
      return;
    }
    try {
      const running = game.processes.some((processName) => processEvents.isRunning(processName));
      let watchState = autoWatchStates.get(gameId);
      const evaluation = evaluateAutoWatchState(watchState, {
        running,
        loggedIn: lastOfficialState.isLogin,
        accelerating: lastOfficialState.accStatus !== 'normal',
        activeGameId: lastOfficialState.gameId,
        gameId,
      });
      watchState = evaluation.state;
      autoWatchStates.set(gameId, watchState);
      if (!running) {
        clearAutoRetry(gameId);
        return;
      }
      if (evaluation.shouldStart && !autoStartBusy) {
        clearAutoRetry(gameId);
        const started = await triggerAutoAcceleration(gameId, game);
        watchState = completeAutoWatchAttempt(watchState, started);
        autoWatchStates.set(gameId, watchState);
      }
      scheduleAutoRetry(gameId, watchState);
    } catch (error) {
      log(`Automatic acceleration event failed for game ${gameId}: ${messageOf(error)}`);
    }
  }

  function scheduleAutoRetry(gameId, watchState) {
    clearAutoRetry(gameId);
    const retryAt = Number(watchState?.retryAt) || 0;
    if (retryAt <= Date.now()) {
      return;
    }
    const timer = setTimeout(() => {
      autoRetryTimers.delete(gameId);
      queueAutoEvaluation([gameId]);
    }, retryAt - Date.now());
    timer?.unref?.();
    autoRetryTimers.set(gameId, timer);
  }

  function clearAutoRetry(gameId) {
    const timer = autoRetryTimers.get(gameId);
    if (timer) {
      clearTimeout(timer);
      autoRetryTimers.delete(gameId);
    }
  }

  async function getAutoGame(gameId) {
    if (autoGameCache.has(gameId)) {
      return autoGameCache.get(gameId);
    }
    const game = await bridge.call('getGame', { gameId: numericId(gameId) });
    const resolved = {
      title: game.title,
      processes: resolveProcesses(gameId, game.processes),
      areas: Array.isArray(game.areas) ? game.areas : [],
    };
    autoGameCache.set(gameId, resolved);
    return resolved;
  }

  async function triggerAutoAcceleration(gameId, game) {
    const selection = settings.gameSelections[gameId] ?? defaultAutoSelection(game);
    if (!selection) {
      log(`Automatic acceleration skipped for game ${gameId}: no playable area`);
      return false;
    }
    autoStartBusy = true;
    pendingStartUntil = Date.now() + 30000;
    try {
      log(`Automatic acceleration triggered for game ${gameId}`);
      const result = await bridge.call('autoStart', { gameId: numericId(gameId), ...selection });
      if (result?.selection) {
        settings.gameSelections = {
          ...settings.gameSelections,
          [gameId]: normalizeGameSelection(result.selection),
        };
        saveSettings();
      }
      if (result?.state) {
        acceptOfficialState(result.state);
      }
      if (result?.needsAttention) {
        showOfficialWindow();
      } else if (settings.notificationsEnabled && Notification.isSupported()) {
        new Notification({
          title: 'LeigodClean',
          body: `已检测到 ${game.title}，正在自动加速。`,
          icon: appIcon,
          silent: true,
        }).show();
      }
      return true;
    } catch (error) {
      log(`Automatic acceleration failed for game ${gameId}: ${messageOf(error)}`);
      if (settings.notificationsEnabled && Notification.isSupported()) {
        new Notification({
          title: 'LeigodClean 自动加速失败',
          body: messageOf(error),
          icon: appIcon,
        }).show();
      }
      return false;
    } finally {
      autoStartBusy = false;
      sendState();
    }
  }

  async function attachMonitor(gameId, force = false) {
    const id = String(gameId ?? '');
    if (!id || (!force && monitoredGameId === id && monitor.snapshot.state !== STATES.IDLE)) {
      return;
    }
    monitoredGameId = id;

    try {
      if (!settings.autoPauseEnabled) {
        monitor.stop('automatic-pause-disabled');
        return;
      }
      const game = await bridge.call('getGame', { gameId: numericId(id) });
      if (game.isFree || community.excludedGameIds.map(String).includes(id)) {
        monitor.stop('monitor-not-required');
        return;
      }
      const processes = resolveProcesses(id, game.processes);
      await monitor.start(processes, {
        gameId: id,
        gameName: game.title,
        startupTimeoutMs: settings.startupTimeoutMinutes * 60 * 1000,
        graceMs: settings.graceMinutes * 60 * 1000,
      });
    } catch (error) {
      log(`Monitor attach failed for game ${id}: ${messageOf(error)}`);
      await monitor.start([], { gameId: id });
    }
  }

  function resolveProcesses(gameId, officialProcesses) {
    return resolveProcessCatalog(
      gameId,
      officialProcesses,
      settings.processOverrides,
      community.games,
    );
  }

  async function performPause(reason) {
    autoPauseInProgress = true;
    try {
      const result = await bridge.call('pause');
      acceptOfficialState(result);
      monitoredGameId = '';
      if (reason !== 'manual-pause' && settings.notificationsEnabled && Notification.isSupported()) {
        new Notification({
          title: 'LeigodClean',
          body: '未检测到游戏进程，已暂停加速时长。',
          icon: appIcon,
          silent: false,
        }).show();
      }
      return combinedState();
    } finally {
      autoPauseInProgress = false;
    }
  }

  function showOfficialWindow() {
    if (!officialWindow || officialWindow.isDestroyed()) {
      return;
    }
    officialVisible = true;
    officialWindow.setSkipTaskbar(false);
    officialWindow.show();
    officialWindow.focus();
    sendState();
  }

  function hideOfficialWindow() {
    if (!officialWindow || officialWindow.isDestroyed()) {
      return;
    }
    officialVisible = false;
    officialWindow.hide();
    officialWindow.setSkipTaskbar(true);
    sendState();
  }

  async function closeApplication() {
    const forceCloseTimer = setTimeout(() => finishClose(), 5000);
    try {
      monitoredGameId = '';
      monitor.stop('application-close');
      if (settings.pauseOnClose && lastOfficialState.isLogin &&
        (lastOfficialState.accStatus !== 'normal' || lastOfficialState.timeStatus !== 'pause')) {
        await performPause('application-close');
      }
    } catch (error) {
      log(`Pause during close failed: ${messageOf(error)}`);
    } finally {
      clearTimeout(forceCloseTimer);
      finishClose();
    }
  }

  function finishClose() {
    stopOfficialStateWatch();
    processEvents?.stop();
    for (const timer of autoRetryTimers.values()) {
      clearTimeout(timer);
    }
    autoRetryTimers.clear();
    cancelCompatibilityFallback();
    if (officialWindow && !officialWindow.isDestroyed()) {
      officialWindow.destroy();
    }
    if (cleanWindow && !cleanWindow.isDestroyed()) {
      cleanWindow.destroy();
    }
    tray?.destroy();
    tray = null;
    app.quit();
  }

  function combinedState() {
    return {
      application: {
        name: String(product.name ?? 'LeigodClean'),
        version: String(product.version ?? 'unknown'),
        versionDate: String(product.versionDate ?? ''),
        description: String(product.description ?? ''),
        startedAt,
        platform: `${process.platform} ${process.arch}`,
        electron: String(process.versions.electron ?? ''),
      },
      client: {
        ...lastOfficialState,
        connected: Boolean(officialWindow && !officialWindow.isDestroyed()),
        clientVersion: officialClientVersion,
        officialVisible,
      },
      monitor: monitor.snapshot,
      processEvents: processEvents?.snapshot ?? {
        status: 'unavailable',
        ready: false,
        error: '进程事件服务不可用。',
        processCount: 0,
        lastEventAt: 0,
        restartCount: 0,
        generation: 0,
      },
      settings: publicSettings(),
    };
  }

  function acceptOfficialState(next) {
    if (!next || typeof next !== 'object') {
      return;
    }
    const previous = lastOfficialState;
    lastOfficialState = { ...next, ready: Boolean(next.ready) };
    if (lastOfficialState.ready) {
      cancelCompatibilityFallback();
    }

    const gameId = String(lastOfficialState.gameId || '');
    if (gameId && lastOfficialState.accStatus !== 'normal' && monitoredGameId !== gameId) {
      void attachMonitor(gameId);
    } else if (monitoredGameId && lastOfficialState.accStatus === 'normal' &&
      !autoPauseInProgress && monitor.snapshot.state !== STATES.PAUSED) {
      monitoredGameId = '';
      monitor.stop('acceleration-ended');
    }

    if (lastOfficialState.needsAttention && Date.now() < pendingStartUntil) {
      pendingStartUntil = 0;
      showOfficialWindow();
    }

    if (lastOfficialState.ready && !previous.ready) {
      void refreshAutoAccelerationIndex({ forceCandidates: true, evaluate: true });
    } else if (lastOfficialState.ready && settings.autoAccelerationEnabled && gameId &&
      !autoCandidateIds.map(String).includes(gameId)) {
      autoCandidateIds = [gameId, ...autoCandidateIds];
      void refreshAutoAccelerationIndex({ evaluate: true });
    }
    if (lastOfficialState.ready &&
      ((!previous.isLogin && lastOfficialState.isLogin) ||
        (previous.accStatus !== 'normal' && lastOfficialState.accStatus === 'normal') ||
        String(previous.gameId || '') !== gameId)) {
      queueAutoEvaluation(resolveAutoGameIds(settings, autoCandidateIds));
    }

    if (JSON.stringify(previous) !== JSON.stringify(lastOfficialState)) {
      sendState();
    }
  }

  function sendState() {
    updateTrayMenu();
    if (!cleanWindow || cleanWindow.isDestroyed() || cleanWindow.webContents.isDestroyed()) {
      return;
    }
    cleanWindow.webContents.send('leigod-clean:state', combinedState());
  }

  async function buildDiagnostics() {
    let official = null;
    try {
      official = await bridge.call('diagnostics');
    } catch (error) {
      official = { error: messageOf(error) };
    }
    return {
      generatedAt: new Date().toISOString(),
      runtimeVersion: 3,
      application: product,
      startedAt,
      officialClientVersion,
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      official,
      state: combinedState(),
    };
  }

  function publicSettings() {
    return {
      autoAccelerationEnabled: settings.autoAccelerationEnabled,
      autoPauseEnabled: settings.autoPauseEnabled,
      launchAtLogin: settings.launchAtLogin,
      minimizeToTray: settings.minimizeToTray,
      pauseOnClose: settings.pauseOnClose,
      notificationsEnabled: settings.notificationsEnabled,
      startupTimeoutMinutes: settings.startupTimeoutMinutes,
      graceMinutes: settings.graceMinutes,
      autoAccelerateGames: { ...settings.autoAccelerateGames },
      gameSelections: cloneJson(settings.gameSelections),
      processOverrides: { ...settings.processOverrides },
    };
  }

  function loadSettings() {
    return validateSettings(readJson(settingsPath, defaults));
  }

  function validateSettings(value) {
    const startup = clampNumber(value?.startupTimeoutMinutes, 1, 60, defaults.startupTimeoutMinutes);
    const grace = clampNumber(value?.graceMinutes, 0.25, 60, defaults.graceMinutes);
    const sourceOverrides = value?.processOverrides && typeof value.processOverrides === 'object'
      ? value.processOverrides
      : {};
    const processOverrides = {};
    for (const [gameId, processes] of Object.entries(sourceOverrides).slice(0, 500)) {
      if (!/^\d{1,12}$/u.test(gameId)) {
        continue;
      }
      const normalized = normalizeProcesses(processes);
      if (normalized.length > 0) {
        processOverrides[gameId] = normalized.slice(0, 30);
      }
    }
    const sourceSelections = value?.gameSelections && typeof value.gameSelections === 'object'
      ? value.gameSelections
      : {};
    const gameSelections = {};
    for (const [gameId, selection] of Object.entries(sourceSelections).slice(0, 500)) {
      if (!/^\d{1,12}$/u.test(gameId)) {
        continue;
      }
      try {
        gameSelections[gameId] = normalizeGameSelection(selection);
      } catch {
        // Ignore stale or malformed preferences.
      }
    }
    const sourceAutoGames = value?.autoAccelerateGames && typeof value.autoAccelerateGames === 'object'
      ? value.autoAccelerateGames
      : {};
    const autoAccelerateGames = {};
    for (const [gameId, enabled] of Object.entries(sourceAutoGames).slice(0, 500)) {
      if (enabled === true && /^\d{1,12}$/u.test(gameId) && gameSelections[gameId]) {
        autoAccelerateGames[gameId] = true;
      }
    }
    return {
      autoAccelerationEnabled: value?.autoAccelerationEnabled === true,
      autoPauseEnabled: value?.autoPauseEnabled !== false,
      launchAtLogin: value?.launchAtLogin === true,
      minimizeToTray: value?.minimizeToTray !== false,
      pauseOnClose: value?.pauseOnClose !== false,
      notificationsEnabled: value?.notificationsEnabled !== false,
      startupTimeoutMinutes: startup,
      graceMinutes: grace,
      autoAccelerateGames,
      gameSelections,
      processOverrides,
    };
  }

  function normalizeGameSelection(value) {
    const areaId = numericId(value?.areaId);
    const subAreaId = optionalNumericId(value?.subAreaId);
    const lineId = numericId(value?.lineId);
    const assignId = numericId(value?.assignId);
    return {
      areaId,
      subAreaId,
      lineId,
      assignId,
      lineTitle: String(value?.lineTitle ?? '').slice(0, 100),
      lineMode: String(value?.lineMode ?? '').slice(0, 60),
    };
  }

  function saveSettings() {
    fs.mkdirSync(dataRoot, { recursive: true });
    const temporary = `${settingsPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, settingsPath);
  }

  function readJson(filePath, fallback) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return cloneJson(fallback);
    }
  }

  function readText(filePath, fallback) {
    try {
      return fs.readFileSync(filePath, 'utf8').trim() || fallback;
    } catch {
      return fallback;
    }
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function prepareLog() {
    fs.mkdirSync(dataRoot, { recursive: true });
    try {
      if (fs.statSync(logPath).size > 2 * 1024 * 1024) {
        fs.renameSync(logPath, `${logPath}.old`);
      }
    } catch {
      // A missing or locked log is handled by the next write.
    }
  }

  function log(message) {
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, 'utf8');
    } catch {
      // Logging must never interrupt the official client.
    }
  }

  function numericId(value) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
      const error = new Error('标识参数无效。');
      error.code = 'INVALID_ID';
      throw error;
    }
    return number;
  }

  function optionalNumericId(value) {
    if (value === null || value === undefined || value === '') {
      return -1;
    }
    if (Number(value) === -1) {
      return -1;
    }
    return numericId(value);
  }

  function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(maximum, Math.max(minimum, number));
  }

  function messageOf(error) {
    return error instanceof Error ? error.message : String(error ?? '未知错误');
  }

  function processKey(value) {
    return normalizeProcessName(value).toLocaleLowerCase('en-US');
  }

  function failure(code, message) {
    return { ok: false, error: { code: String(code), message: String(message) } };
  }
};

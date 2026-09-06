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
    evaluateAutoWatchState,
  } = require('./auto-acceleration.cjs');
  const { OfficialBridge } = require('./official-bridge.cjs');
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
  let polling = false;
  let pollTimer = null;
  let bridgeFallbackTimer = null;
  let pendingStartUntil = 0;
  let monitoredGameId = '';
  let autoPauseInProgress = false;
  let autoStartBusy = false;
  let autoWatcherPolling = false;
  const autoGameCache = new Map();
  const autoWatchStates = new Map();
  let lastOfficialState = {
    ready: false,
    isLogin: false,
    accStatus: 'normal',
    gameId: 0,
  };

  prepareLog();
  log(`LeigodClean runtime starting; client=${officialClientVersion}`);

  let win32Addon = null;
  try {
    win32Addon = officialRequire('@leigod-rs/win32-node-addon');
  } catch (error) {
    log(`Native process API unavailable: ${messageOf(error)}`);
  }

  const bridge = new OfficialBridge(() => officialWindow, log);
  const monitor = new ProcessMonitor({
    isRunning: async (processName) => {
      if (!win32Addon?.isProcessRunning) {
        throw new Error('官方进程检测组件不可用。');
      }
      return Boolean(win32Addon.isProcessRunning(processName, ''));
    },
    pause: async (reason) => performPause(reason),
    onState: (snapshot) => {
      log(`Monitor state=${snapshot.state} reason=${snapshot.reason} game=${snapshot.gameId}`);
      sendState();
      updateTrayMenu();
    },
    pollIntervalMs: 1000,
    missThreshold: 2,
  });

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
    startPolling();
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
          lastOfficialState = { ...lastOfficialState, ready: false };
          sendState();
        }
      });
    } else {
      officialWindowScore = Math.max(officialWindowScore, score);
      bridge.invalidate(window);
    }
    void bridge.install()
      .then(() => pollOfficialState())
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
        titleBarOverlay: {
          color: '#F7F7F8',
          symbolColor: '#3A3A3D',
          height: 62,
        },
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
        await pollOfficialState();
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
        return result;
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
        autoGameCache.clear();
        if (!settings.autoAccelerationEnabled) {
          autoWatchStates.clear();
        } else {
          void pollAutoAcceleration();
        }
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
        if (enabled) {
          void pollAutoAcceleration();
        }
        return publicSettings();
      }
      case 'rememberSelection': {
        const gameId = String(numericId(payload.gameId));
        const selection = normalizeGameSelection(payload);
        settings.gameSelections = { ...settings.gameSelections, [gameId]: selection };
        saveSettings();
        return selection;
      }
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

  function startPolling() {
    if (pollTimer) {
      return;
    }
    pollTimer = setInterval(() => void pollOfficialState(), 1000);
    void pollOfficialState();
  }

  async function pollOfficialState() {
    if (polling || !officialWindow || officialWindow.isDestroyed()) {
      sendState();
      return;
    }
    polling = true;
    try {
      const next = await bridge.call('state');
      lastOfficialState = { ...next, ready: Boolean(next.ready) };
      if (lastOfficialState.ready) {
        cancelCompatibilityFallback();
      }

      const gameId = String(next.gameId || '');
      if (gameId && next.accStatus !== 'normal' && monitoredGameId !== gameId) {
        void attachMonitor(gameId);
      } else if (monitoredGameId && next.accStatus === 'normal' && !autoPauseInProgress &&
        monitor.snapshot.state !== STATES.PAUSED) {
        monitoredGameId = '';
        monitor.stop('acceleration-ended');
      }

      if (next.needsAttention && Date.now() < pendingStartUntil) {
        pendingStartUntil = 0;
        showOfficialWindow();
      }
      void pollAutoAcceleration();
    } catch (error) {
      lastOfficialState = {
        ...lastOfficialState,
        ready: false,
        error: messageOf(error),
      };
    } finally {
      polling = false;
      sendState();
    }
  }

  async function pollAutoAcceleration() {
    if (autoWatcherPolling || autoStartBusy || !settings.autoAccelerationEnabled ||
      !lastOfficialState.ready || !win32Addon?.isProcessRunning) {
      return;
    }
    autoWatcherPolling = true;
    try {
      const gameIds = Object.entries(settings.autoAccelerateGames)
        .filter(([, enabled]) => enabled === true)
        .map(([gameId]) => gameId);
      for (const gameId of gameIds) {
        try {
          const game = await getAutoGame(gameId);
          let watchState = autoWatchStates.get(gameId);
          const running = game.processes.some((processName) =>
            Boolean(win32Addon.isProcessRunning(processName, '')));
          const evaluation = evaluateAutoWatchState(watchState, {
            running,
            loggedIn: lastOfficialState.isLogin,
            accelerating: lastOfficialState.accStatus !== 'normal',
            activeGameId: lastOfficialState.gameId,
            gameId,
          });
          watchState = evaluation.state;
          autoWatchStates.set(gameId, watchState);
          if (evaluation.shouldStart) {
            const started = await triggerAutoAcceleration(gameId, game.title);
            autoWatchStates.set(gameId, completeAutoWatchAttempt(watchState, started));
            break;
          }
        } catch (error) {
          log(`Automatic acceleration check failed for game ${gameId}: ${messageOf(error)}`);
        }
      }
    } catch (error) {
      log(`Automatic acceleration check failed: ${messageOf(error)}`);
    } finally {
      autoWatcherPolling = false;
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
    };
    autoGameCache.set(gameId, resolved);
    return resolved;
  }

  async function triggerAutoAcceleration(gameId, gameTitle) {
    const selection = settings.gameSelections[gameId];
    if (!selection) {
      log(`Automatic acceleration skipped for game ${gameId}: selection missing`);
      return;
    }
    autoStartBusy = true;
    pendingStartUntil = Date.now() + 30000;
    try {
      log(`Automatic acceleration triggered for game ${gameId}`);
      const result = await bridge.call('autoStart', { gameId: numericId(gameId), ...selection });
      if (result?.needsAttention) {
        showOfficialWindow();
      } else if (settings.notificationsEnabled && Notification.isSupported()) {
        new Notification({
          title: 'LeigodClean',
          body: `已检测到 ${gameTitle}，正在自动加速。`,
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
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
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
      settings: publicSettings(),
    };
  }

  function acceptOfficialState(next) {
    if (!next || typeof next !== 'object') {
      return;
    }
    lastOfficialState = { ...next, ready: Boolean(next.ready) };
    sendState();
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
      runtimeVersion: 2,
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

  function failure(code, message) {
    return { ok: false, error: { code: String(code), message: String(message) } };
  }
};

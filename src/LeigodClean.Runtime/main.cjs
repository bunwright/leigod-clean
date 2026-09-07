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
    AutoEvaluationQueue,
    completeAutoWatchAttempt,
    defaultAutoSelection,
    evaluateAutoWatchState,
    resolveAutoGameIds,
    selectAutoEventGames,
  } = require('./auto-acceleration.cjs');
  const {
    discoverInstalledGames,
    executableLocation,
    executableMatchesLocations,
  } = require('./local-games.cjs');
  const { installOfficialShellIsolation } = require('./official-tray.cjs');
  const { OfficialBridge } = require('./official-bridge.cjs');
  const { normalizeProcessName, ProcessEventSource } = require('./process-events.cjs');
  const { createExitConfirmation, createShutdownCoordinator } = require('./shutdown.cjs');
  const {
    buildTrayMenuTemplate,
    createTrayStatusIcons,
    isAccelerationActive,
  } = require('./tray.cjs');
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
    recentGameIds: [],
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
  let trayIcons = null;
  let trayStatusSignature = '';
  let trayRecentGames = [];
  let trayRecentGamesPromise = null;
  let trayDurationClock = { gameId: '', source: 0, base: 0, anchoredAt: 0 };
  const trayGameTitles = new Map();
  let officialVisible = false;
  let creatingCleanWindow = false;
  let closing = false;
  let stateRefreshing = false;
  let officialStateWatchGeneration = 0;
  let officialStateWatchWindowId = 0;
  let officialStateWatchRetryTimer = null;
  let pendingStartUntil = 0;
  let monitoredGameId = '';
  let autoPauseInProgress = false;
  let autoStartBusy = false;
  let autoCandidateIds = [];
  let autoCandidatesLoadedAt = 0;
  let autoIndexGeneration = 0;
  let autoIndexPromise = null;
  const autoGameCache = new Map();
  const autoWatchStates = new Map();
  const autoProcessIndex = new Map();
  const autoGameLocations = new Map();
  const autoLocalProcesses = new Map();
  const autoUnresolvedGameIds = new Set();
  const autoRetryTimers = new Map();
  const pendingAutoStartEvents = [];
  let autoIndexRefreshTimer = null;
  const autoEvaluationQueue = new AutoEvaluationQueue({
    getOrder: () => resolveAutoGameIds(settings, autoCandidateIds),
    evaluate: (gameId, allowSwitch) => evaluateAutoGame(gameId, allowSwitch),
    canContinue: () => !closing,
    onError: (error) => log(`Automatic acceleration queue failed: ${messageOf(error)}`),
  });
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

  appIcon = loadApplicationIcon();
  if (process.platform === 'win32' && typeof app.setAppUserModelId === 'function') {
    app.setAppUserModelId('io.github.bunwright.leigodclean');
  }

  prepareLog();
  log(`LeigodClean runtime starting; client=${officialClientVersion}`);

  let processEvents = null;
  try {
    const observerPath = path.join(runtimeRoot, 'process-observer.exe');
    if (!fs.existsSync(observerPath)) {
      throw new Error('无法定位 LeigodClean 进程事件服务。');
    }
    processEvents = new ProcessEventSource({ executablePath: observerPath, log });
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
    },
  });
  if (processEvents) {
    monitor.observerUnavailable('进程事件服务正在启动。');
    processEvents.subscribe(handleProcessEvent);
  } else {
    monitor.observerUnavailable('进程事件服务不可用。');
  }

  const shutdown = createShutdownCoordinator({
    conceal: concealApplicationShell,
    prepare: prepareApplicationClose,
    dispose: disposeApplication,
    exit: (code) => app.exit(code),
    onError: (error, stage) => log(`Shutdown ${stage} failed: ${messageOf(error)}`),
  });
  const exitConfirmation = createExitConfirmation({
    confirm: confirmApplicationExit,
    exit: () => shutdown.request(),
    onError: (error) => log(`Exit confirmation failed: ${messageOf(error)}`),
  });
  app.on('before-quit', (event) => {
    event?.preventDefault?.();
    void exitConfirmation.request();
  });

  patchOfficialIpc();
  observeWindows();

  app.whenReady().then(() => {
    log('Electron application ready');
    registerCleanIpc();
    try {
      createTray();
    } catch (error) {
      log(`Tray initialization failed: ${messageOf(error)}`);
    }
    createCleanWindow();
    log('Clean window created');
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

  let restoreOfficialShell = () => {};
  try {
    restoreOfficialShell = installOfficialShellIsolation({
      moduleLoader: require('node:module'),
      electron,
      log,
    });
    officialRequire('bytenode');
    officialRequire('./main.jsc');
  } catch (error) {
    log(`Official client failed to start: ${error?.stack ?? messageOf(error)}`);
    dialog.showErrorBox('LeigodClean', `官方客户端启动失败：${messageOf(error)}`);
  } finally {
    restoreOfficialShell();
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
        log(`Official renderer loaded id=${window.id}`);
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
    setOfficialBackgroundPolicy(window);
    if (!officialVisible) {
      window.webContents.setAudioMuted?.(true);
      window.setOpacity?.(0);
      window.hide();
      window.setSkipTaskbar(true);
    } else {
      window.webContents.setAudioMuted?.(false);
      window.setOpacity?.(1);
      window.setSkipTaskbar(false);
    }
    window.on('show', () => {
      if (!officialVisible && !window.isDestroyed()) {
        setImmediate(() => {
          if (!officialVisible && !window.isDestroyed()) {
            window.setOpacity?.(0);
            window.hide();
            window.setSkipTaskbar(true);
            setOfficialBackgroundPolicy(window);
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
      .then(() => {
        log(`Official bridge ready id=${window.id}`);
        startOfficialStateWatch(window);
      })
      .catch((error) => log(`Official bridge install deferred: ${messageOf(error)}`));
    if (!officialVisible) {
      hideOfficialWindow();
    }
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

    cleanWindow.setIcon?.(appIcon);
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
      log('Clean renderer ready to show');
      cleanWindow?.setIcon?.(appIcon);
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
      event.preventDefault();
      void exitConfirmation.request();
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
    trayIcons = createTrayStatusIcons(nativeImage, appIcon);
    tray = new Tray(trayIcons.idle);
    tray.on('click', showCleanWindow);
    tray.on('right-click', showTrayContextMenu);
    tray.setIgnoreDoubleClickEvents?.(true);
    updateTrayStatus(true);
    void refreshTrayRecentGames();
  }

  function loadApplicationIcon() {
    const candidates = [
      path.join(runtimeRoot, 'assets', 'leigodclean.png'),
      path.join(runtimeRoot, 'assets', 'leigodclean.ico'),
      process.execPath,
    ];
    for (const candidate of candidates) {
      const icon = nativeImage.createFromPath(candidate);
      if (!icon.isEmpty()) {
        return icon;
      }
    }
    throw new Error('无法加载 LeigodClean 应用图标。');
  }

  function updateTrayStatus(force = false) {
    if (!tray) {
      return;
    }
    const active = lastOfficialState.ready === true &&
      Boolean(officialWindow && !officialWindow.isDestroyed()) &&
      lastOfficialState.accStatus === 'speeding';
    const title = trayGameTitles.get(String(lastOfficialState.gameId || '')) ?? '';
    const signature = [
      active,
      title,
    ].join(':');
    if (!force && signature === trayStatusSignature) {
      return;
    }
    trayStatusSignature = signature;
    tray.setImage(active ? trayIcons.active : trayIcons.idle);
    tray.setToolTip(active
      ? `LeigodClean · ${title || '加速中'}`
      : 'LeigodClean');
  }

  function synchronizeTrayDuration(previous, next) {
    const active = isAccelerationActive(next);
    const gameId = active ? String(next.gameId || '') : '';
    const source = Math.max(0, Number(next.duration) || 0);
    const sessionChanged = gameId !== trayDurationClock.gameId ||
      String(next.accStatus || 'normal') !== String(previous.accStatus || 'normal');
    if (!gameId) {
      trayDurationClock = { gameId: '', source: 0, base: 0, anchoredAt: 0 };
      return;
    }
    if (sessionChanged || source !== trayDurationClock.source) {
      trayDurationClock = {
        gameId,
        source,
        base: source,
        anchoredAt: Date.now(),
      };
    }
  }

  function currentTrayDuration() {
    const source = Math.max(0, Number(lastOfficialState.duration) || 0);
    if (lastOfficialState.accStatus !== 'speeding' ||
      String(lastOfficialState.gameId || '') !== trayDurationClock.gameId ||
      trayDurationClock.anchoredAt <= 0) {
      return source;
    }
    return trayDurationClock.base + Math.floor(
      Math.max(0, Date.now() - trayDurationClock.anchoredAt) / 1000,
    );
  }

  function showTrayContextMenu() {
    if (!tray) {
      return;
    }
    const activeGameId = String(lastOfficialState.gameId || '');
    const template = buildTrayMenuTemplate({
      application: product,
      client: {
        ...lastOfficialState,
        duration: currentTrayDuration(),
        connected: Boolean(officialWindow && !officialWindow.isDestroyed()),
        clientVersion: officialClientVersion,
      },
      activeGameTitle: trayGameTitles.get(activeGameId),
      recentGames: trayRecentGames,
      busy: autoStartBusy || autoPauseInProgress,
      actions: {
        show: showCleanWindow,
        openSettings: showSettingsFromTray,
        pauseTime: () => void pauseFromTray(),
        resumeTime: () => void resumeFromTray(),
        startGame: (gameId) => void startGameFromTray(gameId),
        quit: quitFromTray,
      },
    });
    tray.popUpContextMenu(Menu.buildFromTemplate(template));
    void refreshTrayRecentGames();
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

  function showSettingsFromTray() {
    showCleanWindow();
    if (!cleanWindow || cleanWindow.isDestroyed() || cleanWindow.webContents.isDestroyed()) {
      return;
    }
    cleanWindow.webContents.send('leigod-clean:command', 'open-settings');
  }

  function quitFromTray() {
    void exitConfirmation.request();
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

  async function resumeFromTray() {
    try {
      const next = await bridge.call('resume');
      acceptOfficialState(next);
    } catch (error) {
      notifyTrayFailure('恢复时长失败', error);
    }
  }

  async function startGameFromTray(gameId) {
    try {
      const id = String(numericId(gameId));
      const game = await getAutoGame(id);
      rememberGameSummary(id, game.title);
      await triggerAutoAcceleration(id, game, { notify: false });
    } catch (error) {
      notifyTrayFailure('开始加速失败', error);
    }
  }

  function notifyTrayFailure(title, error) {
    log(`Tray action failed: ${messageOf(error)}`);
    if (Notification.isSupported()) {
      new Notification({
        title: `LeigodClean · ${title}`,
        body: messageOf(error),
        icon: appIcon,
      }).show();
    }
  }

  function rememberGameSummary(gameId, title) {
    const id = String(gameId || '');
    const value = String(title || '').trim();
    if (!id || !value || trayGameTitles.get(id) === value) {
      return;
    }
    trayGameTitles.set(id, value);
    trayRecentGames = trayRecentGames.map((game) =>
      String(game.id) === id ? { ...game, title: value } : game);
    updateTrayStatus(id === String(lastOfficialState.gameId || ''));
  }

  function rememberRecentGame(gameId) {
    const id = String(gameId || '');
    if (!/^\d{1,12}$/u.test(id) || Number(id) <= 0) {
      return;
    }
    const next = [id, ...settings.recentGameIds.filter((candidate) => candidate !== id)]
      .slice(0, 20);
    if (next.length === settings.recentGameIds.length &&
      next.every((candidate, index) => candidate === settings.recentGameIds[index])) {
      return;
    }
    settings.recentGameIds = next;
    saveSettings();
    void refreshTrayRecentGames();
  }

  function refreshTrayRecentGames() {
    if (!lastOfficialState.ready) {
      return Promise.resolve(trayRecentGames);
    }
    if (trayRecentGamesPromise) {
      return trayRecentGamesPromise;
    }
    trayRecentGamesPromise = (async () => {
      const officialRecent = await bridge.call('recentGames', { limit: 10 });
      const officialById = new Map();
      for (const game of Array.isArray(officialRecent) ? officialRecent : []) {
        const id = String(game?.id || '');
        const title = String(game?.title || '').trim();
        if (id && title) {
          officialById.set(id, { id, title });
          rememberGameSummary(id, title);
        }
      }
      const activeGameId = isAccelerationActive(lastOfficialState)
        ? String(lastOfficialState.gameId || '')
        : '';
      const orderedIds = [];
      const seen = new Set();
      for (const value of [
        activeGameId,
        ...settings.recentGameIds,
        ...officialById.keys(),
      ]) {
        const id = String(value || '');
        if (id && !seen.has(id)) {
          seen.add(id);
          orderedIds.push(id);
        }
      }
      const missingIds = orderedIds
        .filter((id) => !trayGameTitles.has(id))
        .slice(0, 6);
      await Promise.all(missingIds.map(async (id) => {
        try {
          const game = await bridge.call('getGame', {
            gameId: numericId(id),
            liveProcesses: false,
          });
          rememberGameSummary(id, game.title);
        } catch {
          // A stale official recent entry is omitted from the menu.
        }
      }));
      trayRecentGames = orderedIds
        .map((id) => officialById.get(id) ?? (
          trayGameTitles.has(id) ? { id, title: trayGameTitles.get(id) } : null
        ))
        .filter(Boolean)
        .slice(0, 3);
      updateTrayStatus(true);
      return trayRecentGames;
    })()
      .catch((error) => {
        log(`Tray recent games refresh failed: ${messageOf(error)}`);
        return trayRecentGames;
      })
      .finally(() => {
        trayRecentGamesPromise = null;
      });
    return trayRecentGamesPromise;
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
        log('Clean renderer initialization requested');
        await refreshOfficialState();
        log(`Clean renderer initialization completed; officialReady=${lastOfficialState.ready}`);
        return combinedState();
      case 'searchGames': {
        const games = await bridge.call('searchGames', {
          query: String(payload.query ?? '').slice(0, 100),
          limit: Math.min(100, Math.max(1, Number(payload.limit) || 60)),
        });
        for (const game of Array.isArray(games) ? games : []) {
          rememberGameSummary(game.id, game.title);
        }
        return games;
      }
      case 'getGame': {
        const gameId = numericId(payload.gameId);
        const game = await bridge.call('getGame', { gameId, liveProcesses: true });
        rememberGameSummary(gameId, game.title);
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
        rememberRecentGame(payload.gameId);
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
      log(`Official state refresh failed: ${error?.stack ?? messageOf(error)}`);
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
    log(`Official state subscription starting id=${window.webContents.id}`);
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
    handleAutomaticProcessChange(
      event.names,
      fullSnapshot,
      event.kind,
      event.initial,
      event.sequence,
      event.processes,
    );
    sendState();
  }

  function handleAutomaticProcessChange(names, fullSnapshot, kind, initial, sequence, processes) {
    if (!processEvents?.snapshot.ready) {
      return;
    }
    if (fullSnapshot && (initial || autoProcessIndex.size === 0)) {
      void refreshAutoAccelerationIndex({ evaluate: true });
      return;
    }

    const nameGameIds = new Set();
    const locationGameIds = new Set();
    const changedProcesses = normalizeProcesses(names);
    const processDetails = Array.isArray(processes) ? processes : [];
    const hasProcessChanges = changedProcesses.length > 0 || processDetails.length > 0;
    const eventProcessNames = normalizeProcesses([
      ...changedProcesses,
      ...processDetails.map((process) => process?.name),
    ]);
    for (const processName of eventProcessNames) {
      for (const gameId of autoProcessIndex.get(processKey(processName)) ?? []) {
        nameGameIds.add(gameId);
      }
    }
    for (const process of processDetails) {
      for (const [gameId, locations] of autoGameLocations) {
        if (autoGameCache.has(gameId) &&
          executableMatchesLocations(process?.path, locations)) {
          locationGameIds.add(gameId);
        }
      }
    }
    const matched = selectAutoEventGames(nameGameIds, locationGameIds, {
      accelerating: lastOfficialState.accStatus !== 'normal',
      activeGameId: lastOfficialState.gameId,
    });
    const gameIds = new Set(matched.gameIds);
    if (kind === 'started' && matched.activeHandoff) {
      // Launcher-to-game handoffs often share process aliases with regional catalog
      // entries. A process belonging to the active game must not switch variants.
      queueAutoEvaluation(matched.gameIds);
      return;
    }
    if (gameIds.size > 0) {
      if (kind === 'started') {
        log(`Automatic process start matched game(s): ${[...gameIds].join(', ')}`);
      }
      queueAutoEvaluation(gameIds, { allowSwitch: kind === 'started' });
    }

    const hasAutomaticTargets = settings.autoAccelerationEnabled ||
      Object.keys(settings.autoAccelerateGames).length > 0;
    if ((kind === 'started' || fullSnapshot) && hasProcessChanges &&
      hasAutomaticTargets && gameIds.size === 0 &&
      (autoUnresolvedGameIds.size > 0 ||
        Date.now() - autoCandidatesLoadedAt >= 5 * 60 * 1000)) {
      if (kind === 'started') {
        rememberPendingAutoStart(eventProcessNames, sequence, processDetails);
      }
      scheduleAutoIndexRefresh();
    } else if (kind === 'started' && hasProcessChanges &&
      gameIds.size === 0 && autoIndexPromise) {
      rememberPendingAutoStart(eventProcessNames, sequence, processDetails);
    }
  }

  function rememberPendingAutoStart(namesInput, sequence, processes) {
    const names = normalizeProcesses(namesInput);
    const details = (Array.isArray(processes) ? processes : [])
      .filter((process) => process && typeof process === 'object')
      .slice(0, 32)
      .map((process) => ({ path: String(process.path ?? '').slice(0, 32767) }));
    if (names.length === 0 && details.length === 0) {
      return;
    }
    pendingAutoStartEvents.push({
      names,
      processes: details,
      sequence: Number.isSafeInteger(Number(sequence)) ? Number(sequence) : 0,
      createdAt: Date.now(),
    });
    if (pendingAutoStartEvents.length > 32) {
      pendingAutoStartEvents.splice(0, pendingAutoStartEvents.length - 32);
    }
  }

  function replayPendingAutoStarts() {
    const minimumTime = Date.now() - 30000;
    const pending = pendingAutoStartEvents.splice(0);
    for (const event of pending) {
      if (event.createdAt < minimumTime) {
        continue;
      }
      const nameGameIds = new Set();
      const locationGameIds = new Set();
      for (const processName of event.names) {
        for (const gameId of autoProcessIndex.get(processKey(processName)) ?? []) {
          nameGameIds.add(gameId);
        }
      }
      for (const process of event.processes) {
        for (const [gameId, locations] of autoGameLocations) {
          if (autoGameCache.has(gameId) &&
            executableMatchesLocations(process.path, locations)) {
            locationGameIds.add(gameId);
          }
        }
      }
      const matched = selectAutoEventGames(nameGameIds, locationGameIds, {
        accelerating: lastOfficialState.accStatus !== 'normal',
        activeGameId: lastOfficialState.gameId,
      });
      const gameIds = new Set(matched.gameIds);
      if (matched.activeHandoff) {
        queueAutoEvaluation(matched.gameIds);
        continue;
      }
      if (gameIds.size > 0) {
        queueAutoEvaluation(gameIds, { allowSwitch: true });
      }
    }
  }

  function resetAutoAccelerationIndex(clearCandidates = false) {
    autoIndexGeneration += 1;
    autoIndexPromise = null;
    autoProcessIndex.clear();
    autoGameLocations.clear();
    autoLocalProcesses.clear();
    autoUnresolvedGameIds.clear();
    autoEvaluationQueue.clear();
    pendingAutoStartEvents.length = 0;
    if (autoIndexRefreshTimer) {
      clearTimeout(autoIndexRefreshTimer);
      autoIndexRefreshTimer = null;
    }
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
      if (pendingGeneration === autoIndexGeneration) {
        replayPendingAutoStarts();
      }
      return;
    }

    const generation = ++autoIndexGeneration;
    const buildPromise = (async () => {
      if (forceCandidates || autoCandidatesLoadedAt === 0) {
        let discovered = [];
        if (hasGlobalTargets) {
          try {
            discovered = await bridge.call('autoCandidates');
          } catch (error) {
            log(`Official automatic acceleration discovery failed: ${messageOf(error)}`);
          }
        }
        const sdkRoot = path.join(process.resourcesPath, 'leishenSdk');
        const installed = readJson(path.join(sdkRoot, 'installed_app.json'), {});
        let gamePaths = readJson(path.join(sdkRoot, 'game_path_updated.json'), null);
        if (!Array.isArray(gamePaths)) {
          gamePaths = readJson(path.join(sdkRoot, 'game_path.json'), []);
        }
        const localGames = discoverInstalledGames(
          installed,
          gamePaths,
          community.excludedGameIds,
          { steamInstallLocations: discoverSteamInstallLocations(installed) },
        );
        if (generation !== autoIndexGeneration) {
          return;
        }
        autoCandidateIds = hasGlobalTargets
          ? [
            ...(Array.isArray(discovered) ? discovered : []),
            ...localGames.map((game) => game.id),
          ]
          : [];
        autoGameLocations.clear();
        autoLocalProcesses.clear();
        for (const game of localGames) {
          if (game.locations.length > 0) {
            autoGameLocations.set(String(game.id), game.locations);
          }
          if (game.processes.length > 0) {
            autoLocalProcesses.set(String(game.id), game.processes);
          }
        }
        autoCandidatesLoadedAt = Date.now();
      }

      const gameIds = resolveAutoGameIds(settings, autoCandidateIds);
      const explicitGameIds = new Set([
        ...Object.keys(settings.autoAccelerateGames),
        ...Object.keys(settings.gameSelections),
      ]);
      const entrySlots = new Array(gameIds.length);
      let nextGameIndex = 0;
      const workers = Array.from(
        { length: Math.min(4, gameIds.length) },
        async () => {
          while (generation === autoIndexGeneration) {
            const index = nextGameIndex++;
            if (index >= gameIds.length) {
              return;
            }
            const gameId = gameIds[index];
            const liveProcesses = explicitGameIds.has(gameId) ||
              !autoGameLocations.has(gameId);
            try {
              entrySlots[index] = [gameId, await getAutoGame(gameId, { liveProcesses })];
            } catch (error) {
              log(`Automatic acceleration index skipped game ${gameId}: ${messageOf(error)}`);
            }
          }
        },
      );
      await Promise.all(workers);
      if (generation !== autoIndexGeneration) {
        return;
      }
      const entries = entrySlots.filter(Boolean);

      autoProcessIndex.clear();
      autoUnresolvedGameIds.clear();
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
        const hasAuthoritativeProcesses =
          normalizeProcesses(settings.processOverrides[gameId]).length > 0 ||
          normalizeProcesses(community.games[gameId]).length > 0;
        if (!autoGameLocations.has(gameId) && !game.liveProcessesLoaded &&
          !hasAuthoritativeProcesses) {
          autoUnresolvedGameIds.add(gameId);
        }
      }
      for (const gameId of autoWatchStates.keys()) {
        if (!retainedIds.has(gameId)) {
          autoWatchStates.delete(gameId);
          clearAutoRetry(gameId);
        }
      }
      log(
        `Automatic acceleration index ready: games=${entries.length} ` +
        `processes=${autoProcessIndex.size} locations=${autoGameLocations.size} ` +
        `unresolved=${autoUnresolvedGameIds.size}`,
      );
      if (evaluate) {
        queueAutoEvaluation(gameIds);
      }
      replayPendingAutoStarts();
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

  function queueAutoEvaluation(gameIds, { allowSwitch = false } = {}) {
    autoEvaluationQueue.enqueue(gameIds, { allowSwitch });
  }

  function scheduleAutoIndexRefresh() {
    if (autoIndexRefreshTimer || closing) {
      return;
    }
    const elapsed = Math.max(0, Date.now() - autoCandidatesLoadedAt);
    const delay = Math.max(0, 5000 - elapsed);
    autoIndexRefreshTimer = setTimeout(() => {
      autoIndexRefreshTimer = null;
      void refreshAutoAccelerationIndex({ forceCandidates: true, evaluate: true });
    }, delay);
    autoIndexRefreshTimer?.unref?.();
  }

  async function evaluateAutoGame(gameId, allowSwitch = false) {
    const game = autoGameCache.get(gameId);
    if (!game || !processEvents?.snapshot.ready ||
      !resolveAutoGameIds(settings, autoCandidateIds).includes(gameId)) {
      return false;
    }
    try {
      const runningByName = game.processes.some(
        (processName) => processEvents.isRunning(processName),
      );
      const locations = autoGameLocations.get(gameId) ?? [];
      const runningByLocation = locations.length > 0 && processEvents.runningProcesses.some(
        (process) => executableMatchesLocations(process.path, locations),
      );
      const running = runningByName || runningByLocation;
      let watchState = autoWatchStates.get(gameId);
      const evaluation = evaluateAutoWatchState(watchState, {
        running,
        loggedIn: lastOfficialState.isLogin,
        accelerating: lastOfficialState.accStatus !== 'normal',
        activeGameId: lastOfficialState.gameId,
        gameId,
        allowSwitch,
      });
      watchState = evaluation.state;
      autoWatchStates.set(gameId, watchState);
      if (!running) {
        clearAutoRetry(gameId);
        return false;
      }
      let started = false;
      if (evaluation.shouldStart && !autoStartBusy) {
        clearAutoRetry(gameId);
        started = await triggerAutoAcceleration(gameId, game);
        watchState = completeAutoWatchAttempt(watchState, started);
        autoWatchStates.set(gameId, watchState);
      }
      scheduleAutoRetry(gameId, watchState);
      return started;
    } catch (error) {
      log(`Automatic acceleration event failed for game ${gameId}: ${messageOf(error)}`);
      return false;
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

  async function getAutoGame(gameId, { liveProcesses = false } = {}) {
    const cached = autoGameCache.get(gameId);
    if (cached && (!liveProcesses || cached.liveProcessesLoaded)) {
      return cached;
    }
    const game = await bridge.call('getGame', {
      gameId: numericId(gameId),
      liveProcesses,
    });
    const resolved = {
      title: game.title,
      processes: resolveProcesses(gameId, [
        ...(Array.isArray(game.processes) ? game.processes : []),
        ...(autoLocalProcesses.get(gameId) ?? []),
      ]),
      areas: Array.isArray(game.areas) ? game.areas : [],
      liveProcessesLoaded: liveProcesses && game.liveProcessesResolved === true,
    };
    rememberGameSummary(gameId, resolved.title);
    autoGameCache.set(gameId, resolved);
    return resolved;
  }

  async function triggerAutoAcceleration(gameId, game, { notify = true } = {}) {
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
      rememberRecentGame(gameId);
      if (result?.needsAttention) {
        showOfficialWindow();
      } else if (notify && settings.notificationsEnabled && Notification.isSupported()) {
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
      const game = await bridge.call('getGame', {
        gameId: numericId(id),
        liveProcesses: true,
      });
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
    officialVisible = true;
    if (!officialWindow || officialWindow.isDestroyed()) {
      sendState();
      return;
    }
    setOfficialBackgroundPolicy(officialWindow);
    officialWindow.webContents.setAudioMuted?.(false);
    officialWindow.setOpacity?.(1);
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
    setOfficialBackgroundPolicy(officialWindow);
    officialWindow.webContents.setAudioMuted?.(true);
    officialWindow.setOpacity?.(0);
    officialWindow.hide();
    officialWindow.setSkipTaskbar(true);
    sendState();
  }

  function setOfficialBackgroundPolicy(window) {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    const allowThrottling = !officialVisible && lastOfficialState.ready === true;
    window.webContents.setBackgroundThrottling?.(allowThrottling);
  }

  async function confirmApplicationExit() {
    if (closing || !app.isReady?.()) {
      return true;
    }
    const options = {
      type: 'question',
      buttons: ['退出', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: '退出 LeigodClean',
      message: '要退出 LeigodClean 吗？',
      detail: settings.pauseOnClose
        ? '退出前将停止当前加速并暂停剩余时长。'
        : '退出后自动加速与游戏进程监控将停止。',
    };
    const owner = cleanWindow && !cleanWindow.isDestroyed() && cleanWindow.isVisible()
      ? cleanWindow
      : null;
    const result = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    return result.response === 0;
  }

  function concealApplicationShell() {
    closing = true;
    officialVisible = false;
    cleanWindow?.hide?.();
    if (officialWindow && !officialWindow.isDestroyed()) {
      officialWindow.setOpacity?.(0);
      officialWindow.hide();
      officialWindow.setSkipTaskbar(true);
    }
    tray?.destroy();
    tray = null;
  }

  async function prepareApplicationClose() {
    try {
      monitoredGameId = '';
      monitor.stop('application-close');
      if (settings.pauseOnClose && lastOfficialState.isLogin &&
        (lastOfficialState.accStatus !== 'normal' || lastOfficialState.timeStatus !== 'pause')) {
        await performPause('application-close');
      }
    } catch (error) {
      log(`Pause during close failed: ${messageOf(error)}`);
    }
  }

  function disposeApplication() {
    stopOfficialStateWatch();
    processEvents?.stop();
    for (const timer of autoRetryTimers.values()) {
      clearTimeout(timer);
    }
    autoRetryTimers.clear();
    if (officialWindow && !officialWindow.isDestroyed()) {
      officialWindow.destroy();
    }
    if (cleanWindow && !cleanWindow.isDestroyed()) {
      cleanWindow.destroy();
    }
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
    synchronizeTrayDuration(previous, next);
    lastOfficialState = { ...next, ready: Boolean(next.ready) };
    setOfficialBackgroundPolicy(officialWindow);

    const gameId = String(lastOfficialState.gameId || '');
    if (gameId && isAccelerationActive(lastOfficialState) &&
      (!isAccelerationActive(previous) || String(previous.gameId || '') !== gameId)) {
      rememberRecentGame(gameId);
    }
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
      log('Official client state ready');
      void refreshAutoAccelerationIndex({ forceCandidates: true, evaluate: true });
      void refreshTrayRecentGames();
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
    if (lastOfficialState.ready && String(previous.gameId || '') !== gameId) {
      void refreshTrayRecentGames();
    }

    if (JSON.stringify(previous) !== JSON.stringify(lastOfficialState)) {
      sendState();
    }
  }

  function sendState() {
    updateTrayStatus();
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
      automaticAcceleration: {
        globalEnabled: settings.autoAccelerationEnabled,
        configuredGameIds: resolveAutoGameIds(settings, autoCandidateIds),
        candidateCount: autoCandidateIds.length,
        indexedProcessCount: autoProcessIndex.size,
        indexedLocationCount: autoGameLocations.size,
        unresolvedGameIds: [...autoUnresolvedGameIds],
        pendingEvaluationCount: autoEvaluationQueue.pending,
      },
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
      recentGameIds: [...settings.recentGameIds],
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
    const recentGameIds = [];
    const recentSeen = new Set();
    for (const recentGameId of Array.isArray(value?.recentGameIds)
      ? value.recentGameIds.slice(0, 100)
      : []) {
      const gameId = String(recentGameId ?? '');
      if (/^\d{1,12}$/u.test(gameId) && Number(gameId) > 0 && !recentSeen.has(gameId)) {
        recentSeen.add(gameId);
        recentGameIds.push(gameId);
      }
      if (recentGameIds.length >= 20) {
        break;
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
      recentGameIds,
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

  function discoverSteamInstallLocations(installedApps) {
    const applications = installedApps && typeof installedApps === 'object'
      ? Object.entries(installedApps)
      : [];
    const steamApplication = applications.find(([key, application]) =>
      String(key).trim().toLocaleLowerCase('en-US') === 'steam' ||
      String(application?.display_name ?? '').trim().toLocaleLowerCase('en-US') === 'steam');
    const steamLocation = executableLocation(steamApplication?.[1]?.install_location);
    if (!steamLocation) {
      return {};
    }
    const steamRoot = steamLocation.kind === 'file'
      ? path.dirname(steamLocation.path)
      : steamLocation.path;
    const libraries = new Set([steamRoot]);
    const folders = readText(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), '');
    for (const match of folders.matchAll(/"path"\s+"((?:\\.|[^"\\])+)"/gu)) {
      const library = match[1].replace(/\\\\/gu, '\\').trim();
      if (library) {
        libraries.add(library);
      }
    }

    const result = {};
    for (const library of libraries) {
      const steamApps = path.join(library, 'steamapps');
      let manifests = [];
      try {
        manifests = fs.readdirSync(steamApps, { withFileTypes: true })
          .filter((entry) => entry.isFile() && /^appmanifest_\d+\.acf$/iu.test(entry.name))
          .slice(0, 1000);
      } catch {
        continue;
      }
      for (const manifest of manifests) {
        const appId = manifest.name.match(/^appmanifest_(\d+)\.acf$/iu)?.[1] ?? '';
        const content = readText(path.join(steamApps, manifest.name), '');
        const installDirectory = content.match(/"installdir"\s+"([^"]+)"/iu)?.[1]
          ?.replace(/\\\\/gu, '\\')
          ?.trim();
        if (!appId || !installDirectory) {
          continue;
        }
        const location = path.join(steamApps, 'common', installDirectory);
        if (fs.existsSync(location)) {
          result[appId] = location;
        }
      }
    }
    return result;
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

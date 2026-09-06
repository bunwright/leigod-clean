'use strict';

function rankGames(games, priorities = {}) {
  if (!Array.isArray(games)) {
    return [];
  }

  const idOf = (value) => {
    const candidate = value && typeof value === 'object'
      ? (value.id ?? value.game_id ?? value.gameId)
      : value;
    const id = Number(candidate);
    return Number.isFinite(id) ? String(id) : '';
  };
  const indexIds = (values) => {
    const result = new Map();
    for (const value of Array.isArray(values) ? values : []) {
      const id = idOf(value);
      if (id && !result.has(id)) {
        result.set(id, result.size);
      }
    }
    return result;
  };
  const recent = indexIds(priorities.recentGameIds);
  const local = indexIds(priorities.localGameIds);
  const activeId = idOf(priorities.activeGameId);
  const numbered = games.map((game, index) => ({ game, index, id: idOf(game) }));

  numbered.sort((left, right) => {
    const priorityOf = (entry) => {
      if (activeId && entry.id === activeId) {
        return [0, 0];
      }
      if (recent.has(entry.id)) {
        return [1, recent.get(entry.id)];
      }
      if (local.has(entry.id)) {
        return [2, local.get(entry.id)];
      }
      return [3, 0];
    };
    const leftPriority = priorityOf(left);
    const rightPriority = priorityOf(right);
    if (leftPriority[0] !== rightPriority[0]) {
      return leftPriority[0] - rightPriority[0];
    }
    if (leftPriority[1] !== rightPriority[1]) {
      return leftPriority[1] - rightPriority[1];
    }
    if (leftPriority[0] === 3) {
      const hotDifference = Number(right.game?.hot || 0) - Number(left.game?.hot || 0);
      if (hotDifference !== 0) {
        return hotDifference;
      }
      const sortDifference = Number(left.game?.sort_index ?? 100000) -
        Number(right.game?.sort_index ?? 100000);
      if (sortDifference !== 0) {
        return sortDifference;
      }
    }
    return left.index - right.index;
  });

  return numbered.map((entry) => entry.game);
}

function installOfficialBridge(rankCatalog) {
  if (window.__leigodCleanOfficial?.version === 4) {
    return true;
  }

  const runtime = {
    version: 4,
    games: null,
    gameById: new Map(),
    recentGameIds: [],
    sessionRecentGameIds: [],
    localGameIds: [],
    prioritiesLoadedAt: 0,
    lineByKey: new Map(),
    databaseName: '',
  };

  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function plainError(message, code = 'OFFICIAL_BRIDGE_ERROR') {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function findPinia() {
    const application = document.querySelector('#app')?.__vue_app__;
    const provides = application?._context?.provides;
    if (!provides) {
      return null;
    }

    return Reflect.ownKeys(provides)
      .map((key) => provides[key])
      .find((value) => value && value._s instanceof Map) ?? null;
  }

  async function requirePinia(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    do {
      const pinia = findPinia();
      if (pinia) {
        return pinia;
      }
      await wait(100);
    } while (Date.now() < deadline);

    throw plainError('官方客户端尚未完成初始化。', 'OFFICIAL_NOT_READY');
  }

  async function requireStore(name) {
    const pinia = await requirePinia();
    const store = pinia._s.get(name);
    if (!store) {
      throw plainError(`官方客户端缺少 ${name} 状态模块。`, 'OFFICIAL_STORE_MISSING');
    }
    return store;
  }

  function toNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function accountLabel(account) {
    const value = String(account.nickname ?? account.user_name ?? account.mobile ?? '').trim();
    if (/^\d{11}$/u.test(value)) {
      return `${value.slice(0, 3)}••••${value.slice(-4)}`;
    }
    return value.slice(0, 48);
  }

  function isVisible(element) {
    if (!(element instanceof Element) || element.getClientRects().length === 0) {
      return false;
    }
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function visibleAttention() {
    const selectors = [
      '[role="dialog"]',
      '.el-overlay-dialog',
      '.leigod-dialog',
      '.leigod-message-box',
      '.confirm-box',
    ];
    const element = selectors
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .find(isVisible);
    if (!element) {
      return { needsAttention: false, attentionText: '' };
    }

    return {
      needsAttention: true,
      attentionText: String(element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 160),
    };
  }

  function pictureUrl(value) {
    const source = String(value ?? '').trim();
    if (!source) {
      return '';
    }
    if (['http', 'blob:', 'data:', 'cache-img:'].some((prefix) => source.startsWith(prefix))) {
      return source;
    }

    const host = window.webPreloadApi?.picture_host ?? window.picture_host ?? '';
    if (!host) {
      return '';
    }
    return `${host}${source.slice(source.lastIndexOf(':') + 1)}`;
  }

  function parseProcesses(value) {
    const seen = new Set();
    return String(value ?? '')
      .split(/[,，;；|\r\n]+/u)
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => {
        const key = item.toLocaleLowerCase('en-US');
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
  }

  function normalizeArea(area) {
    const id = toNumber(area?.id ?? area?.area_id, -1);
    const children = Array.isArray(area?.son_area) ? area.son_area : [];
    return {
      id,
      title: String(area?.title ?? area?.area_title ?? `区服 ${id}`),
      subAreas: children.map((subArea) => ({
        id: toNumber(subArea?.sub_area_id ?? subArea?.id, -1),
        title: String(subArea?.title ?? subArea?.sub_area_title ?? '默认区服'),
      })).filter((subArea) => subArea.id >= 0),
    };
  }

  function normalizeGame(game) {
    if (!game) {
      return null;
    }
    const id = toNumber(game.id, -1);
    const image = pictureUrl(game.game_pic_url || game.gameBackgroundImage);
    const artwork = pictureUrl(game.gameBackgroundImage || game.game_pic_url);
    return {
      id,
      title: String(game.title ?? `游戏 ${id}`),
      subtitle: String(game.game_info ?? game.alias ?? ''),
      image,
      artwork,
      type: toNumber(game.game_type, 0),
      isFree: String(game.is_free ?? '0') === '1',
      processes: parseProcesses(game.game_process),
      areas: (Array.isArray(game.area) ? game.area : []).map(normalizeArea)
        .filter((area) => area.id >= 0),
    };
  }

  function openDatabase(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? plainError('无法打开官方游戏库。'));
      request.onblocked = () => reject(plainError('官方游戏库当前被占用。'));
    });
  }

  function getAllFromStore(database, storeName) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => reject(request.error ?? plainError('无法读取官方游戏库。'));
    });
  }

  function getAllFromOptionalStore(database, storeName) {
    if (!database.objectStoreNames.contains(storeName)) {
      return Promise.resolve([]);
    }
    return getAllFromStore(database, storeName);
  }

  function uniqueGameIds(values) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const candidate = value && typeof value === 'object'
        ? (value.id ?? value.game_id ?? value.gameId)
        : value;
      const id = toNumber(candidate, -1);
      if (id >= 0 && !seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
    return result;
  }

  function applyGamePriorities(localGames, recentRecords) {
    const recentRecord = recentRecords.find((record) => record?.id === '_') ?? recentRecords[0];
    runtime.recentGameIds = uniqueGameIds([
      ...runtime.sessionRecentGameIds,
      ...uniqueGameIds(recentRecord?.games),
    ]).slice(0, 20);
    runtime.localGameIds = uniqueGameIds(localGames);
    runtime.prioritiesLoadedAt = Date.now();
  }

  async function databaseCandidates() {
    if (typeof indexedDB.databases === 'function') {
      const databases = await indexedDB.databases();
      return databases
        .map((item) => item.name)
        .filter((name) => typeof name === 'string' && name.startsWith('leigod_database_'))
        .sort((left, right) => right.localeCompare(left, 'en-US', { numeric: true }));
    }
    return ['leigod_database_11.0.0.0'];
  }

  async function loadGames(force = false) {
    if (runtime.games && !force) {
      return runtime.games;
    }

    const names = await databaseCandidates();
    let lastError = null;
    for (const name of names) {
      let database = null;
      try {
        database = await openDatabase(name);
        if (!database.objectStoreNames.contains('game_list')) {
          database.close();
          continue;
        }
        const [games, localGames, recentRecords] = await Promise.all([
          getAllFromStore(database, 'game_list'),
          getAllFromOptionalStore(database, 'local_games'),
          getAllFromOptionalStore(database, 'recent_games'),
        ]);
        database.close();
        runtime.databaseName = name;
        runtime.games = games;
        runtime.gameById = new Map(games.map((game) => [String(game.id), game]));
        applyGamePriorities(localGames, recentRecords);
        return games;
      } catch (error) {
        database?.close();
        lastError = error;
      }
    }

    throw lastError ?? plainError('未找到官方游戏库。', 'GAME_DATABASE_MISSING');
  }

  async function refreshGamePriorities() {
    if (!runtime.databaseName || Date.now() - runtime.prioritiesLoadedAt < 5000) {
      return;
    }
    let database = null;
    try {
      database = await openDatabase(runtime.databaseName);
      const [localGames, recentRecords] = await Promise.all([
        getAllFromOptionalStore(database, 'local_games'),
        getAllFromOptionalStore(database, 'recent_games'),
      ]);
      applyGamePriorities(localGames, recentRecords);
    } finally {
      database?.close();
    }
  }

  async function getRawGame(gameId) {
    await loadGames();
    let game = runtime.gameById.get(String(gameId));
    if (!game) {
      await loadGames(true);
      game = runtime.gameById.get(String(gameId));
    }
    return game ?? null;
  }

  function gameSearchText(game) {
    const aliases = typeof game.alias === 'string'
      ? game.alias
      : JSON.stringify(game.alias ?? '');
    return [game.id, game.title, game.game_info, aliases, game.game_process]
      .join(' ')
      .toLocaleLowerCase('zh-CN');
  }

  async function searchGames(payload = {}) {
    const query = String(payload.query ?? '').trim().toLocaleLowerCase('zh-CN');
    const limit = Math.min(100, Math.max(1, toNumber(payload.limit, 60)));
    const games = await loadGames();
    if (!query) {
      await refreshGamePriorities().catch(() => {});
    }
    const visible = games.filter((game) => String(game.is_show_v11 ?? '1') !== '0');
    const matches = query
      ? visible.filter((game) => gameSearchText(game).includes(query))
      : rankCatalog(visible, {
        activeGameId: findPinia()?._s.get('acc')?.accInfo?.game_id,
        recentGameIds: runtime.recentGameIds,
        localGameIds: runtime.localGameIds,
      });

    return matches.slice(0, limit).map((game) => {
      const normalized = normalizeGame(game);
      return {
        id: normalized.id,
        title: normalized.title,
        subtitle: normalized.subtitle,
        image: normalized.image,
        artwork: normalized.artwork,
        isFree: normalized.isFree,
      };
    });
  }

  async function autoCandidates() {
    const games = await loadGames();
    await refreshGamePriorities().catch(() => {});
    const visibleGameIds = new Set(games
      .filter((game) => String(game.is_show_v11 ?? '1') !== '0')
      .map((game) => String(toNumber(game.id, -1))));
    return uniqueGameIds([
      ...runtime.localGameIds,
      ...runtime.recentGameIds,
    ])
      .filter((gameId) => gameId > 0 && visibleGameIds.has(String(gameId)))
      .slice(0, 500);
  }

  async function getGame(payload = {}) {
    const game = await getRawGame(payload.gameId);
    if (!game) {
      throw plainError('官方游戏库中没有该游戏。', 'GAME_NOT_FOUND');
    }
    return normalizeGame(game);
  }

  const lineModes = {
    0: ['智能模式', '适用于大多数网络环境'],
    3: ['模式四', '适用于大多数网络环境'],
    7: ['模式七', '兼容部分特殊网络'],
    8: ['模式八', '主机加速线路'],
    9: ['模式九', '兼容部分特殊网络'],
    10: ['模式十', '适用于受限网络环境'],
    12: ['模式二', '适用于个人和家庭网络'],
    13: ['模式三', '适用于大多数网络环境'],
    21: ['防丢包一', '适用于弱网和网络波动环境'],
    22: ['防丢包二', '适用于弱网和网络波动环境'],
    23: ['防丢包三', '适用于弱网和网络波动环境'],
    31: ['防丢包一', '适用于弱网和网络波动环境'],
    32: ['防丢包二', '适用于弱网和网络波动环境'],
    33: ['防丢包三', '适用于弱网和网络波动环境'],
  };
  const regions = {
    list_ZHONGBU: ['中部专线', 0],
    list_HUANAN: ['华南专线', 1],
    list_BEIFANG: ['北方专线', 2],
    list_XINAN: ['西南专线', 3],
    list_DONGNAN: ['东南专线', 4],
    list_OPTIMAL: ['本地专线', 5],
  };

  async function getLines(payload = {}) {
    const user = await requireStore('user');
    if (!user.isLogin || !user.accountToken) {
      throw plainError('请先在官方客户端中完成登录。', 'LOGIN_REQUIRED');
    }

    const game = await getRawGame(payload.gameId);
    if (!game) {
      throw plainError('官方游戏库中没有该游戏。', 'GAME_NOT_FOUND');
    }
    const gameId = toNumber(payload.gameId, -1);
    const areaId = toNumber(payload.areaId, -1);
    const subAreaId = toNumber(payload.subAreaId, -1);
    if (gameId < 0 || areaId < 0) {
      throw plainError('区服参数无效。', 'INVALID_SELECTION');
    }

    const response = await window.leigodSimplify.invoke('get-line-list', {
      nGameID: gameId,
      nAreaID: areaId,
      nSubAreaId: subAreaId,
      game_type: toNumber(game.game_type, 0),
      token: user.accountToken,
      clearCache: payload.refresh ? 1 : 0,
      save_selection: 0,
    }, { timeout: 20000 });
    const data = response?.data ?? response?.result?.data ?? response?.result ?? response;
    if (!data || typeof data !== 'object') {
      throw plainError('官方客户端未返回可用线路。', 'LINE_LIST_EMPTY');
    }

    const recommendedKey = `list_${data.recomRegion ?? ''}`;
    const entries = Object.entries(regions)
      .sort(([left], [right]) => (left === recommendedKey ? -1 : right === recommendedKey ? 1 : 0));
    const result = [];
    const selectionPrefix = `${gameId}:${areaId}:${subAreaId}:`;
    for (const key of runtime.lineByKey.keys()) {
      if (key.startsWith(selectionPrefix)) {
        runtime.lineByKey.delete(key);
      }
    }

    for (const [regionKey, [regionTitle, district]] of entries) {
      const lines = Array.isArray(data[regionKey]) ? data[regionKey] : [];
      for (const line of lines) {
        const lineId = toNumber(line?.line_id, 0);
        const assignId = toNumber(line?.leigod_assign_id ?? line?.assign_id, -1);
        if (lineId === 0 || assignId < 0) {
          continue;
        }
        const mode = lineModes[toNumber(line.line_type, 0)] ?? lineModes[0];
        const index = result.length;
        const key = `${gameId}:${areaId}:${subAreaId}:${lineId}:${assignId}:${index}`;
        const normalizedLine = {
          ...line,
          district,
          nodeIndex: index,
          node_line_title: toNumber(game.game_type, 0) === 0
            ? String(line.line_title ?? regionTitle)
            : regionTitle,
          node_line_mode_name: index === 0 ? '智能模式' : mode[0],
          node_line_desc: mode[1],
          isAI: index === 0 || [21, 22, 23, 31, 32, 33].includes(toNumber(line.line_type, 0)),
        };
        runtime.lineByKey.set(key, {
          gameId,
          areaId,
          subAreaId,
          line: normalizedLine,
        });
        result.push({
          key,
          lineId,
          assignId,
          title: String(line.line_title ?? line.line_enter_title ?? regionTitle),
          region: regionTitle,
          mode: normalizedLine.node_line_mode_name,
          description: normalizedLine.node_line_desc,
          delay: toNumber(line.leigod_delay ?? line.fixed_delays, 0),
          recommended: index === 0,
        });
      }
    }

    if (result.length === 0) {
      throw plainError('当前区服暂无可用线路。', 'LINE_LIST_EMPTY');
    }
    if (runtime.lineByKey.size > 3000) {
      for (const key of runtime.lineByKey.keys()) {
        if (!key.startsWith(selectionPrefix)) {
          runtime.lineByKey.delete(key);
        }
        if (runtime.lineByKey.size <= 3000) {
          break;
        }
      }
    }
    return result;
  }

  async function start(payload = {}, options = {}) {
    const user = await requireStore('user');
    const acc = await requireStore('acc');
    if (!user.isLogin) {
      throw plainError('请先在官方客户端中完成登录。', 'LOGIN_REQUIRED');
    }
    const selection = runtime.lineByKey.get(String(payload.lineKey ?? ''));
    if (!selection) {
      throw plainError('所选线路已失效，请重新获取线路。', 'LINE_SELECTION_EXPIRED');
    }
    const gameId = toNumber(payload.gameId, -1);
    const areaId = toNumber(payload.areaId, -1);
    const subAreaId = toNumber(payload.subAreaId, -1);
    if (gameId < 0 || areaId < 0) {
      throw plainError('加速参数无效。', 'INVALID_SELECTION');
    }
    if (selection.gameId !== gameId || selection.areaId !== areaId ||
      selection.subAreaId !== subAreaId) {
      throw plainError('所选线路与当前区服不匹配，请重新选择。', 'LINE_SELECTION_MISMATCH');
    }
    const line = selection.line;
    const resumeScene = options.automatic ? 'auto_acc' : 'other';
    const wasPaused = user.userTimeInfo?.timeStatus === 'pause';
    const currentGameId = toNumber(acc.accInfo?.game_id, 0);
    const switchingGame = currentGameId > 0 && currentGameId !== gameId &&
      String(acc.accInfo?.accStatus ?? 'normal') !== 'normal';

    if (switchingGame) {
      await Promise.resolve(acc.stopAcc({
        game_id: currentGameId,
        isConfirm: false,
        reason: 'other',
      }));
      await wait(250);
    }

    if (wasPaused) {
      await Promise.resolve(user.toggleTimeStatus('resume', { scene: resumeScene }));
      await wait(250);
    }
    try {
      acc.recordManualLineSelect?.({ game_id: gameId, area_id: areaId, line_id: line.line_id });
      await Promise.resolve(acc.startAcc({
        scene: 'leigodClean',
        game_id: gameId,
        area_id: areaId,
        sub_area_id: subAreaId < 0 ? undefined : subAreaId,
        lineInfo: { is_user_select: true, ...line },
      }));
    } catch (error) {
      if (wasPaused && acc.accInfo?.accStatus === 'normal' &&
        user.userTimeInfo?.timeStatus !== 'pause') {
        await Promise.resolve(user.toggleTimeStatus('pause', { scene: resumeScene }));
      }
      throw error;
    }
    runtime.sessionRecentGameIds = [
      gameId,
      ...runtime.sessionRecentGameIds.filter((id) => id !== gameId),
    ].slice(0, 20);
    runtime.recentGameIds = uniqueGameIds([
      ...runtime.sessionRecentGameIds,
      ...runtime.recentGameIds,
    ]).slice(0, 20);
    await wait(350);
    return { accepted: true, state: await state(), ...visibleAttention() };
  }

  async function autoStart(payload = {}) {
    const lines = await getLines({
      gameId: payload.gameId,
      areaId: payload.areaId,
      subAreaId: payload.subAreaId,
      refresh: false,
    });
    const line = lines.find((item) =>
      Number(item.lineId) === Number(payload.lineId) &&
      Number(item.assignId) === Number(payload.assignId)) ??
      lines.find((item) => Number(item.lineId) === Number(payload.lineId)) ??
      lines[0];
    const result = await start({
      gameId: payload.gameId,
      areaId: payload.areaId,
      subAreaId: payload.subAreaId,
      lineKey: line.key,
    }, { automatic: true });
    return {
      ...result,
      selection: {
        areaId: toNumber(payload.areaId, -1),
        subAreaId: toNumber(payload.subAreaId, -1),
        lineId: line.lineId,
        assignId: line.assignId,
        lineTitle: line.title,
        lineMode: line.mode,
      },
    };
  }

  async function stop() {
    const acc = await requireStore('acc');
    const gameId = toNumber(acc.accInfo?.game_id, 0);
    await Promise.resolve(acc.stopAcc({ game_id: gameId, isConfirm: false, reason: 'other' }));
    return state();
  }

  async function pause() {
    const acc = await requireStore('acc');
    const user = await requireStore('user');
    const gameId = toNumber(acc.accInfo?.game_id, 0);
    if (acc.accInfo?.accStatus !== 'normal' || gameId > 0) {
      await Promise.resolve(acc.stopAcc({ game_id: gameId, isConfirm: false, reason: 'other' }));
      await wait(250);
    }
    if (user.userTimeInfo?.timeStatus !== 'pause') {
      await Promise.resolve(user.toggleTimeStatus('pause', { scene: 'other' }));
    }
    return state();
  }

  async function resume() {
    const user = await requireStore('user');
    if (!user.isLogin) {
      throw plainError('请先在官方客户端中完成登录。', 'LOGIN_REQUIRED');
    }
    if (user.userTimeInfo?.timeStatus === 'pause') {
      await Promise.resolve(user.toggleTimeStatus('resume', { scene: 'other' }));
      await wait(250);
    }
    return state();
  }

  async function state() {
    const pinia = await requirePinia(1000);
    const user = pinia._s.get('user');
    const acc = pinia._s.get('acc');
    const account = user?.userInfo ?? {};
    const time = user?.userTimeInfo ?? {};
    const acceleration = acc?.accInfo ?? {};
    const attention = visibleAttention();
    return {
      ready: Boolean(user && acc),
      isLogin: Boolean(user?.isLogin),
      displayName: accountLabel(account),
      timeStatus: String(time.timeStatus ?? ''),
      totalTimeLeft: toNumber(time.totalTimeLeft, 0),
      canPauseTimeLeft: toNumber(time.canPauseTimeLeft, 0),
      accStatus: String(acceleration.accStatus ?? 'normal'),
      gameId: toNumber(acceleration.game_id, 0),
      duration: toNumber(acceleration.duration, 0),
      delay: toNumber(acceleration.delay, 0),
      loss: toNumber(acceleration.lose ?? acceleration.line_lose, 0),
      ...attention,
    };
  }

  async function diagnostics() {
    const pinia = await requirePinia();
    const databases = await databaseCandidates().catch(() => []);
    return {
      bridgeVersion: runtime.version,
      storeIds: [...pinia._s.keys()],
      databaseName: runtime.databaseName,
      databaseCandidates: databases,
      recentGames: runtime.recentGameIds.length,
      localGames: runtime.localGameIds.length,
      hasSimplifyApi: typeof window.leigodSimplify?.invoke === 'function',
    };
  }

  const methods = {
    autoCandidates,
    autoStart,
    diagnostics,
    getGame,
    getLines,
    pause,
    resume,
    searchGames,
    start,
    state,
    stop,
  };
  window.__leigodCleanOfficial = Object.freeze({
    version: runtime.version,
    async call(method, payload) {
      if (!Object.hasOwn(methods, method)) {
        throw plainError('不支持的官方客户端调用。', 'METHOD_NOT_ALLOWED');
      }
      return methods[method](payload);
    },
  });
  return true;
}

class OfficialBridge {
  constructor(getWindow, log = () => {}) {
    this._getWindow = getWindow;
    this._log = log;
    this._installScript = `(${installOfficialBridge.toString()})(${rankGames.toString()})`;
    this._installedWebContents = null;
    this._installPromise = null;
  }

  async install() {
    const window = this._requireWindow();
    const webContents = window.webContents;
    if (this._installedWebContents === webContents.id) {
      return;
    }
    if (this._installPromise) {
      return this._installPromise;
    }
    this._installPromise = (async () => {
      const installed = await webContents.executeJavaScript(this._installScript, true);
      if (!installed) {
        throw new Error('无法初始化官方客户端桥接。');
      }
      this._installedWebContents = webContents.id;
      this._log('Official renderer bridge installed');
    })();
    try {
      await this._installPromise;
    } finally {
      this._installPromise = null;
    }
  }

  invalidate(window) {
    if (!window || window.webContents.id === this._installedWebContents) {
      this._installedWebContents = null;
    }
  }

  async call(method, payload = {}) {
    const window = this._requireWindow();
    await this.install();
    const script = `window.__leigodCleanOfficial.call(${JSON.stringify(method)},${safeJson(payload)})`;
    return window.webContents.executeJavaScript(script, true);
  }

  _requireWindow() {
    const window = this._getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      const error = new Error('官方客户端界面尚未就绪。');
      error.code = 'OFFICIAL_NOT_READY';
      throw error;
    }
    return window;
  }
}

function safeJson(value) {
  return JSON.stringify(value ?? {}).replace(/</gu, '\\u003c');
}

module.exports = { OfficialBridge, installOfficialBridge, rankGames };

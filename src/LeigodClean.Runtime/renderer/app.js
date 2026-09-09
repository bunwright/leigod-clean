'use strict';

const api = window.leigodClean;
const viewState = window.leigodCleanViewState;
const telemetry = window.leigodCleanTelemetry;
const model = {
  state: null,
  settings: null,
  games: [],
  selectedGame: null,
  lines: [],
  searchGeneration: 0,
  selectionGeneration: 0,
  lineGeneration: 0,
  starting: false,
  switching: false,
  stopping: false,
  timeChanging: false,
  settingsUpdating: false,
  selectedMetric: 'duration',
  toastTimer: null,
  monitorClockTimer: null,
  durationClockTimer: null,
  durationClock: { gameId: '', source: 0, base: 0, anchoredAt: 0 },
  telemetryRangeMs: telemetry.RANGES.fiveMinutes,
  telemetrySeries: { delay: [], loss: [] },
  telemetrySessionId: '',
  telemetrySampleTimer: null,
  telemetryFrame: null,
};

const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
const pickerData = new WeakMap();
const pickerSpecs = new Map([
  [elements.areaSelect, {
    root: elements.areaPicker,
    button: elements.areaPickerButton,
    value: elements.areaPickerValue,
    meta: elements.areaPickerMeta,
    menu: elements.areaPickerMenu,
    label: '区服',
  }],
  [elements.subAreaSelect, {
    root: elements.subAreaPicker,
    button: elements.subAreaPickerButton,
    value: elements.subAreaPickerValue,
    meta: elements.subAreaPickerMeta,
    menu: elements.subAreaPickerMenu,
    label: '子区服',
  }],
  [elements.lineSelect, {
    root: elements.linePicker,
    button: elements.linePickerButton,
    value: elements.linePickerValue,
    meta: elements.linePickerMeta,
    menu: elements.linePickerMenu,
    label: '线路',
  }],
]);

function unwrap(response) {
  if (!response?.ok) {
    const error = new Error(response?.error?.message ?? '操作失败。');
    error.code = response?.error?.code ?? 'OPERATION_FAILED';
    throw error;
  }
  return response.data;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? '未知错误');
}

async function initialize() {
  showCenterState('loading');
  try {
    const initial = unwrap(await api.initialize());
    applyState(initial);
    model.settings = initial.settings;
    if (initial.client.connected && initial.client.ready) {
      await searchGames();
      showCenterState(model.selectedGame ? 'workspace' : 'empty');
      if (!model.selectedGame && initial.client.gameId) {
        await selectGame(initial.client.gameId);
      }
    } else {
      showCenterState('loading');
    }
  } catch {
    showCenterState('loading');
  }
}

function applyState(next) {
  if (!next) {
    return;
  }
  const previousClient = model.state?.client ?? {};
  synchronizeDurationClock(previousClient, next.client ?? {});
  model.state = next;
  synchronizeTelemetrySession(next.client ?? {});
  model.settings = next.settings ?? model.settings;
  const client = next.client ?? {};
  const connected = Boolean(client.connected && client.ready);
  const previousAcceleration = viewState.accelerationContext(previousClient);
  const acceleration = viewState.accelerationContext(client);
  const promoted = acceleration.activeGameId
    ? promoteGameInList(
      acceleration.activeGameId,
      acceleration.activeGameId !== previousAcceleration.activeGameId,
    )
    : false;
  const activityChanged = previousAcceleration.activeGameId !== acceleration.activeGameId ||
    previousAcceleration.status !== acceleration.status;

  if ((promoted || activityChanged) && model.games.length > 0) {
    renderGameList();
  }

  elements.accountButton.hidden = !connected;
  elements.accountName.textContent = client.isLogin ? (client.displayName || '已登录') : '尚未登录';
  elements.accountStatus.textContent = client.isLogin
    ? '雷神账户'
    : connected ? '点击前往登录' : '';
  renderTimeControl();
  elements.officialClientDescription.textContent = client.clientVersion && client.clientVersion !== 'unknown'
    ? `雷神 v${client.clientVersion} · 登录或使用完整功能`
    : '登录或使用 LeigodClean 未提供的功能';
  if (model.selectedGame) {
    renderSession();
    renderGameAutoAcceleration();
  }
  if (!connected) {
    showCenterState('loading');
  }
}

function showCenterState(name) {
  elements.loadingState.hidden = name !== 'loading';
  elements.emptyState.hidden = name !== 'empty';
  elements.workspace.hidden = name !== 'workspace';
}

async function searchGames() {
  if (!model.state?.client?.ready) {
    return;
  }
  const generation = ++model.searchGeneration;
  elements.searchSpinner.hidden = false;
  try {
    const games = unwrap(await api.searchGames(elements.searchInput.value, 100));
    if (generation !== model.searchGeneration) {
      return;
    }
    model.games = viewState.promoteGame(
      games,
      viewState.accelerationContext(model.state?.client).activeGameId,
    );
    elements.gameList.scrollTop = 0;
    renderGameList();
  } catch (error) {
    if (generation === model.searchGeneration) {
      model.games = [];
      renderGameList();
      showToast(messageOf(error), true);
    }
  } finally {
    if (generation === model.searchGeneration) {
      elements.searchSpinner.hidden = true;
    }
  }
}

function promoteGameInList(gameId, reveal = false) {
  const games = viewState.promoteGame(model.games, gameId);
  if (games === model.games) {
    return false;
  }
  model.games = games;
  if (reveal) {
    elements.gameList.scrollTop = 0;
  }
  return true;
}

function renderGameList() {
  elements.gameList.replaceChildren();
  elements.gameCount.textContent = String(model.games.length);
  if (model.games.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'game-item-copy';
    empty.textContent = elements.searchInput.value ? '没有匹配的游戏' : '游戏目录正在加载';
    elements.gameList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  const activeGameId = viewState.accelerationContext(model.state?.client).activeGameId;
  for (const game of model.games) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'game-item';
    button.setAttribute('role', 'option');
    button.dataset.gameId = String(game.id);
    const isActive = activeGameId === String(game.id);
    button.classList.toggle('selected', String(model.selectedGame?.id) === String(game.id));
    button.classList.toggle('active-session', isActive);
    button.setAttribute('aria-selected', button.classList.contains('selected') ? 'true' : 'false');
    button.setAttribute('aria-label', isActive ? `${game.title}，正在加速` : game.title);

    const thumbnail = document.createElement('span');
    thumbnail.className = 'game-thumb-wrap';
    const fallback = document.createElement('span');
    fallback.className = 'game-thumb-fallback';
    fallback.textContent = initials(game.title);
    if (game.image) {
      const image = document.createElement('img');
      image.className = 'game-thumb';
      image.src = game.image;
      image.alt = '';
      image.addEventListener('error', () => image.replaceWith(fallback), { once: true });
      thumbnail.append(image);
    } else {
      thumbnail.append(fallback);
    }
    if (isActive) {
      const indicator = document.createElement('span');
      indicator.className = 'game-active-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      indicator.title = '正在加速';
      thumbnail.append(indicator);
    }
    button.append(thumbnail);

    const copy = document.createElement('span');
    copy.className = 'game-item-copy';
    const title = document.createElement('strong');
    title.textContent = game.title;
    const subtitle = document.createElement('small');
    subtitle.textContent = game.subtitle || `游戏 ID ${game.id}`;
    copy.append(title, subtitle);

    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.classList.add('game-item-chevron');
    chevron.setAttribute('viewBox', '0 0 24 24');
    chevron.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm9 6 6 6-6 6');
    chevron.append(path);
    button.append(copy, chevron);
    fragment.append(button);
  }
  elements.gameList.append(fragment);
}

async function selectGame(gameId) {
  const generation = ++model.selectionGeneration;
  model.lineGeneration += 1;
  try {
    const game = unwrap(await api.getGame(gameId));
    if (generation !== model.selectionGeneration) {
      return;
    }
    model.selectedGame = game;
    model.lines = [];
    renderGameList();
    renderSelectedGame();
    showCenterState('workspace');
    populateAreas();
    await loadLines(false);
  } catch (error) {
    if (generation === model.selectionGeneration) {
      showToast(messageOf(error), true);
    }
  }
}

function renderSelectedGame() {
  const game = model.selectedGame;
  if (!game) {
    return;
  }
  elements.gameTitle.textContent = game.title;
  elements.gameSubtitle.textContent = game.subtitle || '选择区服与线路后开始加速。';
  elements.gameIdTag.textContent = `ID ${game.id}`;
  elements.processTag.textContent = game.processes.length > 0
    ? `${game.processes.length} 个监控进程`
    : '可自定义监控进程';
  renderProcessOverview(game.processes);
  const artwork = game.artwork || game.image;
  elements.gameArtworkPlaceholder.textContent = initials(game.title);
  elements.gameArtwork.hidden = !artwork;
  if (artwork) {
    elements.gameArtwork.src = artwork;
    elements.gameArtwork.alt = game.title;
  } else {
    elements.gameArtwork.removeAttribute('src');
  }
  renderSession();
  renderGameAutoAcceleration();
}

function renderProcessOverview(processes) {
  const values = Array.isArray(processes) ? processes.filter(Boolean) : [];
  elements.processList.replaceChildren();
  elements.processSummary.textContent = values.length > 0
    ? `任一进程运行即保持会话 · 共 ${values.length} 个`
    : '尚未配置，可在偏好设置中添加';
  if (values.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'process-chip empty';
    empty.textContent = '未配置';
    elements.processList.append(empty);
    return;
  }

  for (const processName of values.slice(0, 5)) {
    const chip = document.createElement('span');
    chip.className = 'process-chip';
    chip.textContent = processName;
    chip.title = processName;
    elements.processList.append(chip);
  }
  if (values.length > 5) {
    const more = document.createElement('span');
    more.className = 'process-chip more';
    more.textContent = `+${values.length - 5}`;
    more.title = `另有 ${values.length - 5} 个进程`;
    elements.processList.append(more);
  }
}

function populateAreas() {
  const areas = model.selectedGame?.areas ?? [];
  const preference = selectedPreference();
  setOptions(
    elements.areaSelect,
    areas.map((area) => ({
      value: area.id,
      text: area.title,
      meta: area.subAreas.length > 0 ? `${area.subAreas.length} 个子区服` : '自动匹配可用线路',
    })),
    '暂无区服',
    preference?.areaId,
  );
  populateSubAreas(true);
  updateStartAvailability();
}

function populateSubAreas(usePreference = false) {
  const area = selectedArea();
  const subAreas = area?.subAreas ?? [];
  elements.subAreaField.hidden = subAreas.length === 0;
  setOptions(
    elements.subAreaSelect,
    subAreas.map((item) => ({ value: item.id, text: item.title, meta: '子区服' })),
    '暂无子区服',
    usePreference ? selectedPreference()?.subAreaId : undefined,
  );
}

async function loadLines(refresh) {
  const game = model.selectedGame;
  const area = selectedArea();
  if (!game || !area || !model.state?.client?.isLogin) {
    setLineRefreshBusy(false, true);
    model.lines = [];
    setOptions(elements.lineSelect, [], model.state?.client?.isLogin ? '暂无线路' : '登录后获取线路');
    elements.lineHint.textContent = model.state?.client?.isLogin
      ? '当前游戏没有可选区服'
      : '请先在官方界面完成登录';
    updateStartAvailability();
    return;
  }

  const generation = ++model.lineGeneration;
  setLineRefreshBusy(true);
  setChoiceDisabled(elements.lineSelect, true);
  setOptions(elements.lineSelect, [], '正在获取线路…');
  elements.lineHint.textContent = '正在从官方客户端获取可用线路';
  updateStartAvailability();
  try {
    const lines = unwrap(await api.getLines({
      gameId: game.id,
      areaId: area.id,
      subAreaId: selectedSubArea()?.id ?? -1,
      refresh,
    }));
    if (generation !== model.lineGeneration) {
      return;
    }
    model.lines = lines;
    const preference = selectedPreference();
    const preferredLine = lines.find((line) =>
      Number(line.lineId) === Number(preference?.lineId) &&
      Number(line.assignId) === Number(preference?.assignId)) ??
      lines.find((line) => Number(line.lineId) === Number(preference?.lineId));
    setOptions(elements.lineSelect, lines.map((line) => ({
      value: line.key,
      text: line.title,
      meta: `${line.region} · ${line.mode}`,
      trailing: line.delay > 0 ? `${line.delay} ms` : '',
      recommended: line.recommended,
    })), '暂无线路', preferredLine?.key);
    renderLineHint();
    void rememberSelection().then(() => renderGameAutoAcceleration());
  } catch (error) {
    if (generation === model.lineGeneration) {
      model.lines = [];
      setOptions(elements.lineSelect, [], '获取线路失败');
      elements.lineHint.textContent = messageOf(error);
      if (error.code === 'LOGIN_REQUIRED') {
        showToast('请先在官方界面完成登录。', true);
      }
    }
  } finally {
    if (generation === model.lineGeneration) {
      setLineRefreshBusy(false);
      setChoiceDisabled(elements.lineSelect, model.lines.length === 0);
      updateStartAvailability();
    }
  }
}

function setLineRefreshBusy(busy, disabled = busy) {
  elements.refreshLinesButton.disabled = Boolean(disabled);
  elements.refreshLinesButton.classList.toggle('refreshing', Boolean(busy));
}

function renderLineHint() {
  const line = model.lines.find((item) => item.key === elements.lineSelect.value);
  elements.lineHint.textContent = line
    ? `${line.region} · ${line.description}${line.delay > 0 ? ` · ${line.delay} ms` : ''}`
    : '请选择一条线路';
}

async function startAcceleration() {
  if (!model.selectedGame || !selectedArea() || !elements.lineSelect.value ||
    model.starting || model.stopping) {
    return;
  }
  const gameId = model.selectedGame.id;
  model.switching = viewState.accelerationContext(
    model.state?.client,
    gameId,
  ).anotherIsActive;
  model.starting = true;
  updateStartAvailability();
  try {
    const next = unwrap(await api.start({
      gameId,
      areaId: selectedArea().id,
      subAreaId: selectedSubArea()?.id ?? -1,
      lineKey: elements.lineSelect.value,
    }));
    applyState(next);
    if (promoteGameInList(gameId, true)) {
      renderGameList();
    }
  } catch (error) {
    if (error.code === 'LOGIN_REQUIRED') {
      await showOfficial();
    }
    showToast(messageOf(error), true);
  } finally {
    model.starting = false;
    model.switching = false;
    updateStartAvailability();
  }
}

async function stopAcceleration() {
  if (model.starting || model.stopping) {
    return;
  }
  model.stopping = true;
  updateStartAvailability();
  try {
    applyState(unwrap(await api.stopAcceleration()));
  } catch (error) {
    showToast(messageOf(error), true);
  } finally {
    model.stopping = false;
    renderSession();
  }
}

function canStopAcceleration(client = model.state?.client ?? {}) {
  return Boolean(
    client.isLogin &&
    viewState.accelerationContext(client, model.selectedGame?.id).canStop,
  );
}

async function toggleTime() {
  const client = model.state?.client ?? {};
  if (!client.isLogin || model.timeChanging) {
    return;
  }
  model.timeChanging = true;
  renderTimeControl();
  try {
    const operation = client.timeStatus === 'pause' ? api.resumeTime : api.pauseTime;
    applyState(unwrap(await operation()));
  } catch (error) {
    if (error.code === 'LOGIN_REQUIRED') {
      await showOfficial();
    }
    showToast(messageOf(error), true);
  } finally {
    model.timeChanging = false;
    renderTimeControl();
  }
}

function renderTimeControl() {
  const client = model.state?.client ?? {};
  const visible = Boolean(client.isLogin);
  const paused = client.timeStatus === 'pause';
  elements.timeOverview.hidden = !visible;
  if (!visible) {
    return;
  }
  elements.timeOverview.classList.toggle('paused', paused);
  elements.timeStatusLabel.textContent = paused ? '时长已暂停' : '时长使用中';
  const remainingText = `剩余 ${formatRemaining(Number(client.totalTimeLeft) || 0)}`;
  elements.toolbarTimeLeft.textContent = remainingText;
  elements.toolbarTimeLeft.title = remainingText;
  elements.timeToggleButton.disabled = model.timeChanging;
  elements.timeButtonSpinner.hidden = !model.timeChanging;
  elements.timePauseIcon.hidden = model.timeChanging || paused;
  elements.timeResumeIcon.hidden = model.timeChanging || !paused;
  elements.timeToggleText.textContent = model.timeChanging
    ? paused ? '正在恢复' : '正在暂停'
    : paused ? '恢复' : '暂停';
  const action = paused ? '恢复加速时长' : '暂停加速时长';
  elements.timeToggleButton.setAttribute('aria-label', action);
  elements.timeToggleButton.title = action;
}

function renderSession() {
  const client = model.state?.client ?? {};
  const monitor = model.state?.monitor ?? { state: 'idle' };
  const acceleration = viewState.accelerationContext(client, model.selectedGame?.id);
  const monitorVisible = viewState.shouldDisplayMonitor(
    client,
    monitor,
    model.selectedGame?.id,
  );
  const visibleMonitor = monitorVisible
    ? monitor
    : {
      state: 'idle',
      reason: acceleration.anotherIsActive ? 'another-game-active' : 'different-game',
    };

  elements.sessionBadge.classList.toggle('active', acceleration.accelerating);
  elements.sessionBadge.classList.toggle('loading', acceleration.loading);
  elements.sessionStatus.textContent = acceleration.accelerating
    ? '加速中'
    : acceleration.loading ? '正在启动' : '未加速';
  if (acceleration.selectedIsActive) {
    renderDurationMetric(acceleration);
    elements.delayMetric.textContent = Number(client.delay) > 0 ? `${client.delay} ms` : '—';
    elements.lossMetric.textContent = Number(client.loss) > 0 ? `${client.loss}%` : '0%';
    elements.trafficMetric.textContent = formatTraffic(client.trafficKb);
  } else {
    clearDurationClockTimer();
    elements.durationMetric.textContent = '—';
    elements.delayMetric.textContent = '—';
    elements.lossMetric.textContent = '—';
    elements.trafficMetric.textContent = '—';
  }
  renderTelemetryFocus(acceleration);
  const monitorView = monitorPresentation(visibleMonitor);
  elements.monitorChip.textContent = monitorView.chip;
  elements.monitorChip.className = `monitor-chip ${visibleMonitor.state ?? 'idle'}`;
  elements.monitorDescription.textContent = monitorView.description;
  elements.monitorTitle.textContent = monitorView.title;
  elements.monitorDetail.textContent = monitorView.detail;
  scheduleMonitorClock(visibleMonitor);
  updateStartAvailability();
}

function synchronizeDurationClock(previousClient, client) {
  const acceleration = viewState.accelerationContext(client);
  const gameId = acceleration.activeGameId ? String(acceleration.activeGameId) : '';
  const source = Math.max(0, Number(client.duration) || 0);
  const previousAcceleration = viewState.accelerationContext(previousClient);
  const sessionChanged = gameId !== model.durationClock.gameId ||
    acceleration.status !== previousAcceleration.status;
  if (!gameId) {
    model.durationClock = { gameId: '', source: 0, base: 0, anchoredAt: 0 };
    clearDurationClockTimer();
    return;
  }
  if (sessionChanged || source !== model.durationClock.source) {
    model.durationClock = {
      gameId,
      source,
      base: source,
      anchoredAt: Date.now(),
    };
  }
}

function currentDuration(acceleration) {
  const source = Math.max(0, Number(model.state?.client?.duration) || 0);
  if (!acceleration?.accelerating ||
    String(acceleration.activeGameId || '') !== model.durationClock.gameId ||
    model.durationClock.anchoredAt <= 0) {
    return source;
  }
  return model.durationClock.base + Math.floor(
    Math.max(0, Date.now() - model.durationClock.anchoredAt) / 1000,
  );
}

function renderDurationMetric(acceleration) {
  elements.durationMetric.textContent = formatClock(currentDuration(acceleration));
  if (model.selectedMetric === 'duration') {
    renderTelemetryFocus(acceleration);
  }
  clearDurationClockTimer();
  if (!acceleration?.accelerating || document.hidden ||
    elements.settingsDialog.open || elements.aboutDialog.open) {
    return;
  }
  const elapsed = Math.max(0, Date.now() - model.durationClock.anchoredAt);
  const delay = Math.max(100, 1000 - (elapsed % 1000));
  model.durationClockTimer = setTimeout(() => {
    model.durationClockTimer = null;
    const current = viewState.accelerationContext(
      model.state?.client ?? {},
      model.selectedGame?.id,
    );
    if (current.selectedIsActive) {
      renderDurationMetric(current);
    }
  }, delay);
}

function renderTelemetryFocus(acceleration = viewState.accelerationContext(
  model.state?.client ?? {},
  model.selectedGame?.id,
)) {
  const definitions = {
    duration: {
      label: '加速时长',
      value: elements.durationMetric.textContent,
      icon: elements.telemetryDurationIcon,
      activeCaption: '当前会话累计时间',
    },
    delay: {
      label: '线路延迟',
      value: elements.delayMetric.textContent,
      icon: elements.telemetryDelayIcon,
      activeCaption: elements.delayMetric.textContent === '—' ? '等待线路反馈' : '数值越低，响应越快',
    },
    loss: {
      label: '线路丢包',
      value: elements.lossMetric.textContent,
      icon: elements.telemetryLossIcon,
      activeCaption: '数值越低，连接越稳定',
    },
    traffic: {
      label: '会话流量',
      value: elements.trafficMetric.textContent,
      icon: elements.telemetryTrafficIcon,
      activeCaption: '当前加速会话累计传输流量',
    },
  };
  const selected = definitions[model.selectedMetric] ?? definitions.duration;
  elements.telemetryLabel.textContent = selected.label;
  elements.telemetryValue.textContent = selected.value || '—';
  elements.telemetryCaption.textContent = acceleration.selectedIsActive
    ? selected.activeCaption
    : '开始加速后显示实时指标';
  for (const definition of Object.values(definitions)) {
    definition.icon.hidden = definition !== selected;
  }
  for (const option of elements.metricSwitcher.querySelectorAll('[data-metric]')) {
    const active = option.dataset.metric === model.selectedMetric;
    option.classList.toggle('selected', active);
    option.setAttribute('aria-selected', active ? 'true' : 'false');
    option.tabIndex = active ? 0 : -1;
  }
  const chartVisible = ['delay', 'loss'].includes(model.selectedMetric);
  elements.telemetryFocus.classList.toggle('charting', chartVisible);
  elements.telemetryFocus.closest('.session-panel')?.classList.toggle('charting', chartVisible);
  elements.telemetryChart.hidden = !chartVisible;
  if (chartVisible) {
    scheduleTelemetrySampling(acceleration);
  } else {
    clearTelemetrySampling();
  }
}

function selectTelemetryMetric(metric, focus = false) {
  if (!['duration', 'delay', 'loss', 'traffic'].includes(metric)) {
    return;
  }
  model.selectedMetric = metric;
  renderTelemetryFocus();
  if (focus) {
    elements.metricSwitcher.querySelector(`[data-metric="${metric}"]`)?.focus();
  }
}

function synchronizeTelemetrySession(client) {
  const acceleration = viewState.accelerationContext(client);
  const sessionId = acceleration.activeGameId || '';
  if (sessionId === model.telemetrySessionId) {
    return;
  }
  model.telemetrySessionId = sessionId;
  model.telemetrySeries = { delay: [], loss: [] };
  clearTelemetrySampling();
}

function telemetryCanSample(acceleration = viewState.accelerationContext(
  model.state?.client ?? {},
  model.selectedGame?.id,
)) {
  return ['delay', 'loss'].includes(model.selectedMetric) &&
    acceleration.selectedIsActive &&
    document.hidden === false &&
    !elements.settingsDialog.open &&
    !elements.aboutDialog.open;
}

function scheduleTelemetrySampling(acceleration) {
  clearTelemetrySampleTimer();
  if (!telemetryCanSample(acceleration)) {
    drawTelemetryChart();
    return;
  }
  captureTelemetrySamples();
  model.telemetrySampleTimer = setTimeout(() => {
    model.telemetrySampleTimer = null;
    const current = viewState.accelerationContext(
      model.state?.client ?? {},
      model.selectedGame?.id,
    );
    if (telemetryCanSample(current)) {
      scheduleTelemetrySampling(current);
    }
  }, 2_000);
}

function captureTelemetrySamples() {
  const client = model.state?.client ?? {};
  const acceleration = viewState.accelerationContext(client, model.selectedGame?.id);
  if (!acceleration.selectedIsActive) {
    return;
  }
  const now = Date.now();
  const delay = Number(client.delay);
  const loss = Number(client.loss);
  if (Number.isFinite(delay) && delay > 0) {
    telemetry.appendSample(model.telemetrySeries.delay, { at: now, value: delay });
  }
  if (Number.isFinite(loss) && loss >= 0) {
    telemetry.appendSample(model.telemetrySeries.loss, { at: now, value: loss });
  }
  drawTelemetryChart();
}

function drawTelemetryChart() {
  if (!['delay', 'loss'].includes(model.selectedMetric) ||
    elements.telemetryChart.hidden || document.hidden) {
    return;
  }
  if (model.telemetryFrame !== null) {
    cancelAnimationFrame(model.telemetryFrame);
  }
  model.telemetryFrame = requestAnimationFrame(() => {
    model.telemetryFrame = null;
    if (elements.telemetryChart.hidden || document.hidden) {
      return;
    }
    const canvas = elements.telemetryCanvas;
    const width = Math.max(1, Math.floor(canvas.clientWidth));
    const height = Math.max(1, Math.floor(canvas.clientHeight));
    const pixelRatio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const bitmapWidth = Math.floor(width * pixelRatio);
    const bitmapHeight = Math.floor(height * pixelRatio);
    if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
      canvas.width = bitmapWidth;
      canvas.height = bitmapHeight;
    }
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.strokeStyle = 'rgba(8, 120, 249, 0.09)';
    context.lineWidth = 1;
    for (let index = 1; index <= 3; index += 1) {
      const y = Math.round((height / 4) * index) + 0.5;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }

    const metric = model.selectedMetric === 'loss' ? 'loss' : 'delay';
    const series = model.telemetrySeries[metric];
    const chart = telemetry.createChartModel(series, {
      metric,
      now: Date.now(),
      rangeMs: model.telemetryRangeMs,
      width: Math.max(1, width - 4),
      height: Math.max(1, height - 8),
    });
    const unit = metric === 'delay' ? 'ms' : '%';
    elements.telemetryChartEmpty.hidden = chart.points.length > 0;
    elements.telemetryRangeStart.textContent = `${Math.round(model.telemetryRangeMs / 60_000)} 分钟前`;
    if (!chart.summary) {
      elements.telemetryChartStats.textContent = '等待采样';
      canvas.setAttribute('aria-label', `${metric === 'delay' ? '线路延迟' : '线路丢包'}，等待数据`);
      return;
    }

    const roundValue = (value) => metric === 'delay'
      ? Math.round(value)
      : Math.round(value * 10) / 10;
    elements.telemetryChartStats.textContent =
      `平均 ${roundValue(chart.summary.average)} ${unit} · 峰值 ${roundValue(chart.summary.maximum)} ${unit}`;
    canvas.setAttribute(
      'aria-label',
      `${metric === 'delay' ? '线路延迟' : '线路丢包'}，当前 ${roundValue(chart.summary.current)} ${unit}，平均 ${roundValue(chart.summary.average)} ${unit}`,
    );

    const points = chart.points.map((point) => ({ x: point.x + 2, y: point.y + 4 }));
    const color = metric === 'delay' ? '#0878f9' : '#28a76f';
    const fill = context.createLinearGradient(0, 0, 0, height);
    fill.addColorStop(0, metric === 'delay' ? 'rgba(8, 120, 249, 0.22)' : 'rgba(40, 167, 111, 0.22)');
    fill.addColorStop(1, 'rgba(255, 255, 255, 0)');
    if (points.length > 1) {
      context.beginPath();
      context.moveTo(points[0].x, height);
      for (const point of points) {
        context.lineTo(point.x, point.y);
      }
      context.lineTo(points.at(-1).x, height);
      context.closePath();
      context.fillStyle = fill;
      context.fill();
    }
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) {
      context.lineTo(point.x, point.y);
    }
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.stroke();
    const latest = points.at(-1);
    context.beginPath();
    context.arc(latest.x, latest.y, 2.5, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
  });
}

function clearTelemetrySampleTimer() {
  if (model.telemetrySampleTimer) {
    clearTimeout(model.telemetrySampleTimer);
    model.telemetrySampleTimer = null;
  }
}

function clearTelemetrySampling() {
  clearTelemetrySampleTimer();
  if (model.telemetryFrame !== null) {
    cancelAnimationFrame(model.telemetryFrame);
    model.telemetryFrame = null;
  }
}

function clearDurationClockTimer() {
  if (model.durationClockTimer) {
    clearTimeout(model.durationClockTimer);
    model.durationClockTimer = null;
  }
}

function monitorPresentation(monitor) {
  const remainingMs = Number(monitor.deadline) > 0
    ? Math.max(0, Number(monitor.deadline) - Date.now())
    : Number(monitor.remainingMs) || 0;
  const remaining = formatCountdown(remainingMs);
  const process = monitor.activeProcess || '';
  if (monitor.reason === 'process-observer-unavailable') {
    return {
      chip: '监控恢复中',
      title: '进程监控暂时不可用',
      detail: monitor.error || '恢复后将从当前进程状态继续。',
      description: '正在恢复进程监控',
    };
  }
  switch (monitor.state) {
    case 'waiting':
      return { chip: `等待 ${remaining}`, title: '等待游戏启动', detail: '检测到任一目标进程后自动进入监控。', description: '等待游戏进程' };
    case 'active':
      return { chip: '监控中', title: '游戏正在运行', detail: process ? `当前进程：${process}` : '目标进程保持运行。', description: '进程监控正常' };
    case 'grace':
      if (monitor.reason === 'pause-failed') {
        return { chip: `重试 ${remaining}`, title: '暂停未完成', detail: monitor.error || '稍后将自动重试。', description: '正在等待重试' };
      }
      return { chip: `宽限 ${remaining}`, title: '等待进程接力', detail: '启动器、游戏本体或重启进程出现后会继续监控。', description: '暂未检测到目标进程' };
    case 'pausing':
      return { chip: '暂停中', title: '正在暂停加速时长', detail: '正在调用官方客户端完成停止与暂停。', description: '正在结束会话' };
    case 'paused':
      return { chip: '已暂停', title: '加速时长已暂停', detail: '本次自动监控会话已经结束。', description: '会话已安全结束' };
    case 'missing':
      return { chip: '需要设置', title: '未找到可用进程列表', detail: monitor.error || '可在偏好设置中填写当前游戏的进程名。', description: '自动暂停暂不可用' };
    default:
      if (monitor.reason === 'another-game-active') {
        return { chip: '可切换', title: '当前游戏未加速', detail: '选择配置并点击“一键加速”即可切换。', description: '可切换到当前游戏' };
      }
      if (monitor.reason === 'automatic-pause-disabled') {
        return { chip: '已关闭', title: '自动暂停已关闭', detail: '可在偏好设置中重新开启。', description: '仅保留手动控制' };
      }
      return { chip: '空闲', title: '自动暂停待命', detail: '开始加速后将自动检测游戏进程。', description: '等待开始加速' };
  }
}

function scheduleMonitorClock(monitor) {
  clearMonitorClockTimer();
  if (!['waiting', 'grace'].includes(monitor?.state) || Number(monitor?.deadline) <= Date.now() ||
    document.hidden || elements.settingsDialog.open || elements.aboutDialog.open) {
    return;
  }
  const remaining = Number(monitor.deadline) - Date.now();
  model.monitorClockTimer = setTimeout(() => {
    model.monitorClockTimer = null;
    if (model.selectedGame) {
      renderSession();
    }
  }, Math.min(1000, Math.max(100, remaining)));
}

function clearMonitorClockTimer() {
  if (model.monitorClockTimer) {
    clearTimeout(model.monitorClockTimer);
    model.monitorClockTimer = null;
  }
}

function updateStartAvailability() {
  const client = model.state?.client ?? {};
  const acceleration = viewState.accelerationContext(client, model.selectedGame?.id);
  const selectedStarting = acceleration.loading;
  const anotherStarting = client.accStatus === 'loading' && !acceleration.selectedIsActive;
  const stopMode = canStopAcceleration(client);
  const busy = model.starting || model.stopping || selectedStarting;
  const canStart = Boolean(
    model.state?.client?.ready &&
    client.isLogin &&
    model.selectedGame &&
    selectedArea() &&
    elements.lineSelect.value,
  );
  elements.startButton.disabled = busy || anotherStarting || (stopMode ? !client.isLogin : !canStart);
  elements.startButton.classList.toggle('stop-action', stopMode || model.stopping);
  elements.startSpinner.hidden = !busy;
  elements.startIcon.hidden = busy || stopMode;
  elements.stopIcon.hidden = busy || !stopMode;
  let buttonText = stopMode ? '停止加速' : '一键加速';
  if (model.stopping) {
    buttonText = '正在停止';
  } else if (model.starting) {
    buttonText = model.switching ? '正在切换' : '正在启动';
  } else if (selectedStarting) {
    buttonText = '正在启动';
  }
  elements.startButtonText.textContent = buttonText;
}

function performPrimaryAction() {
  return canStopAcceleration() ? stopAcceleration() : startAcceleration();
}

function selectedPreference() {
  return model.settings?.gameSelections?.[String(model.selectedGame?.id ?? '')] ?? null;
}

async function rememberSelection() {
  const game = model.selectedGame;
  const area = selectedArea();
  const line = model.lines.find((item) => item.key === elements.lineSelect.value);
  if (!game || !area || !line) {
    return null;
  }
  const selection = {
    gameId: game.id,
    areaId: area.id,
    subAreaId: selectedSubArea()?.id ?? -1,
    lineId: line.lineId,
    assignId: line.assignId,
    lineTitle: line.title,
    lineMode: line.mode,
  };
  try {
    const saved = unwrap(await api.rememberSelection(selection));
    model.settings ??= {};
    model.settings.gameSelections ??= {};
    model.settings.gameSelections[String(game.id)] = saved;
    return saved;
  } catch {
    // A saved preference is convenient but never blocks acceleration.
    return null;
  }
}

function renderGameAutoAcceleration() {
  const gameId = String(model.selectedGame?.id ?? '');
  const dedicatedEnabled = Boolean(model.settings?.autoAccelerateGames?.[gameId]);
  const hasSelection = Boolean(
    model.lines.find((item) => item.key === elements.lineSelect.value) || selectedPreference(),
  );
  const globalEnabled = model.settings?.autoAccelerationEnabled === true;
  const observerReady = model.state?.processEvents?.ready === true;
  const primaryProcess = model.selectedGame?.processes?.[0] ?? '';
  elements.gameAutoInput.checked = dedicatedEnabled;
  elements.gameAutoInput.disabled = !hasSelection && !dedicatedEnabled;
  elements.gameAutoOption.classList.toggle('enabled', dedicatedEnabled || globalEnabled);
  if (dedicatedEnabled) {
    elements.gameAutoHint.textContent = observerReady
      ? `正在监听 ${primaryProcess || '目标进程'} · 关闭全局开关后仍然生效`
      : '已单独启用，关闭全局开关后仍然生效';
  } else if (globalEnabled) {
    elements.gameAutoHint.textContent = hasSelection
      ? observerReady
        ? `全局已启用 · 正在监听 ${primaryProcess || '目标进程'}`
        : '全局已启用 · 进程检测服务恢复中'
      : '本地或近期游戏将自动匹配可用线路';
  } else {
    elements.gameAutoHint.textContent = hasSelection
      ? '单独开启后不受全局开关影响'
      : '选择线路后可为当前游戏单独开启';
  }
}

async function setGameAutoAcceleration() {
  const game = model.selectedGame;
  if (!game) {
    return;
  }
  const desired = elements.gameAutoInput.checked;
  elements.gameAutoInput.disabled = true;
  try {
    if (desired && !await rememberSelection()) {
      throw new Error('请先选择可用区服与线路。');
    }
    model.settings = unwrap(await api.setGameAutoAcceleration(game.id, desired));
    showToast(desired ? '已为当前游戏开启自动加速。' : '已关闭当前游戏的自动加速。');
  } catch (error) {
    elements.gameAutoInput.checked = !desired;
    showToast(messageOf(error), true);
  } finally {
    renderGameAutoAcceleration();
  }
}

function selectedArea() {
  return model.selectedGame?.areas.find((area) => String(area.id) === elements.areaSelect.value) ?? null;
}

function selectedSubArea() {
  return selectedArea()?.subAreas.find((area) => String(area.id) === elements.subAreaSelect.value) ?? null;
}

function setOptions(select, options, emptyText, preferredValue) {
  select.replaceChildren();
  pickerData.set(select, { options: [...options], emptyText });
  if (options.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = emptyText;
    select.append(option);
    select.disabled = true;
    renderChoicePicker(select);
    return;
  }
  for (const item of options) {
    const option = document.createElement('option');
    option.value = String(item.value);
    option.textContent = item.text;
    select.append(option);
  }
  if (preferredValue !== undefined && options.some((item) => String(item.value) === String(preferredValue))) {
    select.value = String(preferredValue);
  }
  select.disabled = false;
  renderChoicePicker(select);
}

function setChoiceDisabled(select, disabled) {
  select.disabled = Boolean(disabled);
  renderChoicePicker(select);
}

function renderChoicePicker(select) {
  const spec = pickerSpecs.get(select);
  if (!spec) {
    return;
  }
  const data = pickerData.get(select) ?? { options: [], emptyText: `选择${spec.label}` };
  const selected = data.options.find((item) => String(item.value) === select.value);
  const selectedText = selected?.text ?? data.emptyText;
  spec.value.textContent = selectedText;
  spec.meta.textContent = selected?.meta ?? '';
  spec.meta.hidden = !selected?.meta;
  spec.button.disabled = select.disabled || !selected;
  spec.button.setAttribute('aria-label', selected
    ? `${spec.label}：${selectedText}`
    : data.emptyText);
  spec.menu.replaceChildren();
  const fragment = document.createDocumentFragment();

  data.options.forEach((item, index) => {
    const active = String(item.value) === select.value;
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'choice-option';
    option.dataset.value = String(item.value);
    option.id = `${spec.menu.id}-option-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', active ? 'true' : 'false');
    option.tabIndex = -1;

    const marker = document.createElement('span');
    marker.className = 'choice-option-marker';
    marker.textContent = active ? '✓' : '';
    const copy = document.createElement('span');
    copy.className = 'choice-option-copy';
    const title = document.createElement('strong');
    title.textContent = item.text;
    copy.append(title);
    if (item.meta) {
      const meta = document.createElement('small');
      meta.textContent = item.meta;
      copy.append(meta);
    }
    const badges = document.createElement('span');
    badges.className = 'choice-option-badges';
    if (item.recommended) {
      const recommended = document.createElement('span');
      recommended.className = 'choice-badge recommended';
      recommended.textContent = '推荐';
      badges.append(recommended);
    }
    if (item.trailing) {
      const trailing = document.createElement('span');
      trailing.className = 'choice-badge';
      trailing.textContent = item.trailing;
      badges.append(trailing);
    }
    option.append(marker, copy, badges);
    option.addEventListener('click', () => {
      select.value = String(item.value);
      renderChoicePicker(select);
      closeChoicePicker(select, true);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    fragment.append(option);
  });
  spec.menu.append(fragment);
}

function openChoicePicker(select, focusDirection = 0) {
  const spec = pickerSpecs.get(select);
  if (!spec || spec.button.disabled) {
    return;
  }
  closeAllChoicePickers(select);
  spec.menu.hidden = false;
  spec.root.classList.add('open');
  spec.button.setAttribute('aria-expanded', 'true');
  spec.root.closest('.panel')?.classList.add('picker-active');
  spec.root.classList.remove('drop-up');
  spec.menu.style.removeProperty('max-height');
  const triggerBounds = spec.button.getBoundingClientRect();
  const desiredHeight = Math.min(276, spec.menu.scrollHeight);
  const spaceBelow = window.innerHeight - triggerBounds.bottom - 12;
  const spaceAbove = triggerBounds.top - 12;
  const dropUp = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
  spec.root.classList.toggle('drop-up', dropUp);
  const availableHeight = dropUp ? spaceAbove : spaceBelow;
  spec.menu.style.maxHeight = `${Math.max(96, Math.min(276, availableHeight))}px`;
  const options = [...spec.menu.querySelectorAll('.choice-option')];
  const target = focusDirection < 0
    ? options.at(-1)
    : spec.menu.querySelector('[aria-selected="true"]') ?? options[0];
  requestAnimationFrame(() => target?.focus());
}

function closeChoicePicker(select, restoreFocus = false) {
  const spec = pickerSpecs.get(select);
  if (!spec) {
    return;
  }
  spec.menu.hidden = true;
  spec.root.classList.remove('open');
  spec.root.classList.remove('drop-up');
  spec.menu.style.removeProperty('max-height');
  spec.button.setAttribute('aria-expanded', 'false');
  if (![...pickerSpecs.values()].some((item) => !item.menu.hidden)) {
    spec.root.closest('.panel')?.classList.remove('picker-active');
  }
  if (restoreFocus) {
    spec.button.focus();
  }
}

function closeAllChoicePickers(exceptSelect = null) {
  for (const select of pickerSpecs.keys()) {
    if (select !== exceptSelect) {
      closeChoicePicker(select);
    }
  }
}

function initializeChoicePickers() {
  for (const [select, spec] of pickerSpecs) {
    spec.button.addEventListener('click', () => {
      if (spec.menu.hidden) {
        openChoicePicker(select);
      } else {
        closeChoicePicker(select, true);
      }
    });
    spec.button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openChoicePicker(select, event.key === 'ArrowUp' ? -1 : 1);
      }
    });
    spec.menu.addEventListener('keydown', (event) => {
      const options = [...spec.menu.querySelectorAll('.choice-option')];
      const index = options.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        closeChoicePicker(select, true);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        options[(index + delta + options.length) % options.length]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        options[event.key === 'Home' ? 0 : options.length - 1]?.focus();
      }
    });
    select.addEventListener('change', () => renderChoicePicker(select));
  }

  document.addEventListener('pointerdown', (event) => {
    for (const [select, spec] of pickerSpecs) {
      if (!spec.menu.hidden && !spec.root.contains(event.target)) {
        closeChoicePicker(select);
      }
    }
  });
  window.addEventListener('resize', () => closeAllChoicePickers());
  elements.content.addEventListener('scroll', () => closeAllChoicePickers(), { passive: true });
}

async function showOfficial() {
  try {
    const method = model.state?.client?.officialVisible ? api.hideOfficial : api.showOfficial;
    const state = unwrap(await method());
    applyState(state);
  } catch (error) {
    showToast(messageOf(error), true);
  }
}

function syncModalPresentation() {
  const open = elements.settingsDialog.open || elements.aboutDialog.open;
  document.body.classList.toggle('modal-open', open);
  if (open) {
    clearDurationClockTimer();
    clearMonitorClockTimer();
    clearTelemetrySampling();
  } else if (model.selectedGame) {
    renderSession();
  }
  void api.setModalOpen(open).then(unwrap).catch(() => {});
}

function openSettings() {
  const settings = model.settings ?? {
    autoAccelerationEnabled: false,
    autoPauseEnabled: true,
    pauseTimeWhenIdle: true,
    launchAtLogin: false,
    minimizeToTray: true,
    pauseOnClose: true,
    notificationsEnabled: true,
    startupTimeoutMinutes: 10,
    graceMinutes: 5,
    autoAccelerateGames: {},
    gameSelections: {},
    processOverrides: {},
    recentGameIds: [],
  };
  elements.autoAccelerationInput.checked = settings.autoAccelerationEnabled === true;
  elements.autoPauseInput.checked = settings.autoPauseEnabled !== false;
  elements.pauseTimeWhenIdleInput.checked = settings.pauseTimeWhenIdle !== false;
  elements.launchAtLoginInput.checked = settings.launchAtLogin === true;
  elements.minimizeToTrayInput.checked = settings.minimizeToTray !== false;
  elements.pauseOnCloseInput.checked = settings.pauseOnClose !== false;
  elements.notificationsInput.checked = settings.notificationsEnabled !== false;
  elements.startupTimeoutInput.value = String(settings.startupTimeoutMinutes);
  elements.graceInput.value = String(settings.graceMinutes);
  const game = model.selectedGame;
  elements.processEditorLabel.textContent = game ? game.title : '请先选择游戏';
  elements.processOverrideInput.disabled = !game;
  elements.processOverrideInput.value = game
    ? (settings.processOverrides?.[String(game.id)] ?? []).join(', ')
    : '';
  elements.processOverrideInput.placeholder = game?.processes?.length
    ? game.processes.join(', ')
    : 'Game.exe, Launcher.exe';
  elements.settingsOfficialButton.textContent = model.state?.client?.officialVisible ? '收起' : '打开';
  elements.settingsDialog.showModal();
  syncModalPresentation();
}

async function saveSettings(event) {
  event.preventDefault();
  if (model.settingsUpdating) {
    return;
  }
  try {
    const next = {
      autoAccelerationEnabled: elements.autoAccelerationInput.checked,
      autoPauseEnabled: elements.autoPauseInput.checked,
      pauseTimeWhenIdle: elements.pauseTimeWhenIdleInput.checked,
      launchAtLogin: elements.launchAtLoginInput.checked,
      minimizeToTray: elements.minimizeToTrayInput.checked,
      pauseOnClose: elements.pauseOnCloseInput.checked,
      notificationsEnabled: elements.notificationsInput.checked,
      startupTimeoutMinutes: Number(elements.startupTimeoutInput.value),
      graceMinutes: Number(elements.graceInput.value),
      autoAccelerateGames: { ...(model.settings?.autoAccelerateGames ?? {}) },
      gameSelections: { ...(model.settings?.gameSelections ?? {}) },
      processOverrides: { ...(model.settings?.processOverrides ?? {}) },
      recentGameIds: [...(model.settings?.recentGameIds ?? [])],
    };
    if (model.selectedGame) {
      const gameId = String(model.selectedGame.id);
      const processes = elements.processOverrideInput.value
        .split(/[,，;；\r\n]+/u)
        .map((item) => item.trim())
        .filter(Boolean);
      if (processes.length > 0) {
        next.processOverrides[gameId] = processes;
      } else {
        delete next.processOverrides[gameId];
      }
    }
    model.settings = unwrap(await api.updateSettings(next));
    if (model.selectedGame) {
      try {
        model.selectedGame = unwrap(await api.getGame(model.selectedGame.id));
        renderSelectedGame();
      } catch {
        // The preference is saved; a later state refresh will update this summary.
      }
    }
    elements.settingsDialog.close();
    showToast('偏好设置已保存。');
  } catch (error) {
    showToast(messageOf(error), true);
  }
}

async function setGlobalAutoAcceleration() {
  if (model.settingsUpdating) {
    return;
  }
  const desired = elements.autoAccelerationInput.checked;
  model.settingsUpdating = true;
  elements.autoAccelerationInput.disabled = true;
  elements.saveSettingsButton.disabled = true;
  try {
    model.settings = unwrap(await api.updateSettings({
      ...(model.settings ?? {}),
      autoAccelerationEnabled: desired,
    }));
    renderGameAutoAcceleration();
  } catch (error) {
    elements.autoAccelerationInput.checked = !desired;
    showToast(messageOf(error), true);
  } finally {
    model.settingsUpdating = false;
    elements.autoAccelerationInput.disabled = false;
    elements.saveSettingsButton.disabled = false;
  }
}

function showToast(message, isError = false) {
  clearTimeout(model.toastTimer);
  elements.toastText.textContent = message;
  elements.toastIcon.textContent = isError ? '!' : '✓';
  elements.toast.classList.toggle('error', isError);
  elements.toast.hidden = false;
  model.toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, isError ? 5200 : 3000);
}

function initials(value) {
  const text = String(value ?? '').trim();
  return [...text].slice(0, 2).join('').toLocaleUpperCase('zh-CN') || 'LC';
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return [hours, minutes, remaining].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatTraffic(kilobytes) {
  const megabytes = Math.max(0, Number(kilobytes) || 0) / 1024;
  if (megabytes >= 1024) {
    return `${formatTrafficNumber(megabytes / 1024)} GB`;
  }
  return `${formatTrafficNumber(megabytes)} MB`;
}

function formatTrafficNumber(value) {
  if (value === 0) {
    return '0';
  }
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}

function formatRemaining(seconds) {
  const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
  if (totalMinutes <= 0) {
    return '不足 1 分钟';
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分钟`;
  }
  return `${minutes} 分钟`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return '—';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function formatVersionDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(value ?? ''));
  return match ? `${match[1]} 年 ${Number(match[2])} 月 ${Number(match[3])} 日` : '—';
}

function openAbout() {
  const application = model.state?.application ?? {};
  const client = model.state?.client ?? {};
  elements.aboutName.textContent = application.name || 'LeigodClean';
  elements.aboutDescription.textContent = application.description || '简洁的雷神加速控制界面。';
  elements.aboutVersion.textContent = application.version && application.version !== 'unknown'
    ? `v${application.version}`
    : '—';
  elements.aboutOfficialVersion.textContent = client.clientVersion && client.clientVersion !== 'unknown'
    ? `v${client.clientVersion}`
    : '等待客户端连接';
  elements.aboutVersionDate.textContent = formatVersionDate(application.versionDate);
  elements.aboutStartedAt.textContent = formatDateTime(application.startedAt);
  elements.aboutEnvironment.textContent = [application.platform, application.electron
    ? `Electron ${application.electron}`
    : ''].filter(Boolean).join(' · ') || '—';
  elements.aboutDialog.showModal();
  syncModalPresentation();
}

function formatCountdown(milliseconds) {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

initializeChoicePickers();

let searchTimer = null;
elements.searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void searchGames(), 180);
});
elements.gameList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-game-id]');
  if (button) {
    void selectGame(button.dataset.gameId);
  }
});
elements.gameArtwork.addEventListener('error', () => {
  elements.gameArtwork.hidden = true;
});
elements.areaSelect.addEventListener('change', () => {
  populateSubAreas(false);
  void loadLines(false);
});
elements.subAreaSelect.addEventListener('change', () => void loadLines(false));
elements.lineSelect.addEventListener('change', () => {
  renderLineHint();
  updateStartAvailability();
  void rememberSelection().then(() => renderGameAutoAcceleration());
});
elements.gameAutoInput.addEventListener('change', () => void setGameAutoAcceleration());
elements.refreshLinesButton.addEventListener('click', () => void loadLines(true));
elements.startButton.addEventListener('click', () => void performPrimaryAction());
elements.metricSwitcher.addEventListener('click', (event) => {
  const option = event.target.closest('[data-metric]');
  if (option) {
    selectTelemetryMetric(option.dataset.metric);
  }
});
elements.metricSwitcher.addEventListener('keydown', (event) => {
  const order = ['duration', 'delay', 'loss', 'traffic'];
  const current = order.indexOf(model.selectedMetric);
  let next = current;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    next = (current + 1) % order.length;
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    next = (current - 1 + order.length) % order.length;
  } else if (event.key === 'Home') {
    next = 0;
  } else if (event.key === 'End') {
    next = order.length - 1;
  } else {
    return;
  }
  event.preventDefault();
  selectTelemetryMetric(order[next], true);
});
elements.telemetryRange.addEventListener('click', (event) => {
  const button = event.target.closest('[data-range]');
  const range = Number(button?.dataset.range);
  if (!button || !Object.values(telemetry.RANGES).includes(range)) {
    return;
  }
  model.telemetryRangeMs = range;
  for (const option of elements.telemetryRange.querySelectorAll('[data-range]')) {
    option.classList.toggle('selected', option === button);
  }
  drawTelemetryChart();
});
elements.timeToggleButton.addEventListener('click', () => void toggleTime());
elements.accountButton.addEventListener('click', () => {
  if (model.state?.client?.isLogin) {
    openSettings();
  } else {
    void showOfficial();
  }
});
elements.settingsButton.addEventListener('click', openSettings);
elements.aboutButton.addEventListener('click', openAbout);
elements.aboutDialog.addEventListener('close', syncModalPresentation);
elements.aboutCloseButton.addEventListener('click', () => elements.aboutDialog.close());
elements.aboutDoneButton.addEventListener('click', () => elements.aboutDialog.close());
elements.settingsDialog.addEventListener('close', syncModalPresentation);
elements.settingsCloseButton.addEventListener('click', () => elements.settingsDialog.close());
elements.settingsCancelButton.addEventListener('click', () => elements.settingsDialog.close());
elements.settingsOfficialButton.addEventListener('click', async () => {
  elements.settingsDialog.close();
  await showOfficial();
});
elements.settingsForm.addEventListener('submit', saveSettings);
elements.autoAccelerationInput.addEventListener('change', () => void setGlobalAutoAcceleration());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearDurationClockTimer();
    clearMonitorClockTimer();
    clearTelemetrySampling();
  } else if (model.selectedGame) {
    renderSession();
  }
});
window.addEventListener('resize', () => drawTelemetryChart());
elements.openLogsButton.addEventListener('click', async () => {
  try {
    unwrap(await api.openLogs());
  } catch (error) {
    showToast(messageOf(error), true);
  }
});
elements.copyDiagnosticsButton.addEventListener('click', async () => {
  try {
    unwrap(await api.copyDiagnostics());
    showToast('诊断信息已复制。');
  } catch (error) {
    showToast(messageOf(error), true);
  }
});
api.onState((state) => {
  const wasReady = Boolean(model.state?.client?.ready);
  const wasLogin = Boolean(model.state?.client?.isLogin);
  applyState(state);
  if (!wasReady && state.client?.ready) {
    void searchGames().then(() => {
      if (model.selectedGame) {
        return selectGame(model.selectedGame.id);
      }
      if (state.client.gameId) {
        return selectGame(state.client.gameId);
      }
      showCenterState('empty');
      return undefined;
    });
  } else if (!wasLogin && state.client?.isLogin && model.selectedGame) {
    showCenterState('workspace');
    void loadLines(false);
  }
});
api.onCommand((command) => {
  if (command === 'open-settings') {
    openSettings();
  }
});

void initialize();

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rendererRoot = path.join(__dirname, '..', 'renderer');
const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(rendererRoot, 'app.js'), 'utf8');
const viewStateScript = fs.readFileSync(path.join(rendererRoot, 'view-state.js'), 'utf8');
const telemetryScript = fs.readFileSync(path.join(rendererRoot, 'telemetry.js'), 'utf8');
const styles = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8');
const mainRuntime = fs.readFileSync(path.join(rendererRoot, '..', 'main.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(rendererRoot, '..', 'preload.cjs'), 'utf8');
const processEvents = fs.readFileSync(path.join(rendererRoot, '..', 'process-events.cjs'), 'utf8');
const autoAcceleration = fs.readFileSync(
  path.join(rendererRoot, '..', 'auto-acceleration.cjs'),
  'utf8',
);
const officialTray = fs.readFileSync(path.join(rendererRoot, '..', 'official-tray.cjs'), 'utf8');
const shutdownRuntime = fs.readFileSync(path.join(rendererRoot, '..', 'shutdown.cjs'), 'utf8');
const trayRuntime = fs.readFileSync(path.join(rendererRoot, '..', 'tray.cjs'), 'utf8');
const communityProcesses = JSON.parse(fs.readFileSync(
  path.join(rendererRoot, '..', 'community-processes.json'),
  'utf8',
));
const product = JSON.parse(fs.readFileSync(path.join(rendererRoot, '..', 'product.json'), 'utf8'));
const project = fs.readFileSync(
  path.join(rendererRoot, '..', '..', 'LeigodClean.Launcher', 'LeigodClean.Launcher.csproj'),
  'utf8',
);

test('renderer element references match unique HTML ids', () => {
  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/gu)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML ids must be unique');

  const usedIds = new Set(
    [...script.matchAll(/\belements\.([A-Za-z][A-Za-z0-9_]*)/gu)].map((match) => match[1]),
  );
  for (const id of usedIds) {
    assert.ok(ids.includes(id), `Missing renderer element #${id}`);
  }
});

test('renderer keeps scripts external and declares a restrictive policy', () => {
  assert.match(html, /Content-Security-Policy/iu);
  assert.match(html, /connect-src 'none'/u);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/iu);
  assert.match(html, /src="view-state\.js"[\s\S]*src="telemetry\.js"[\s\S]*src="app\.js"/u);
});

test('main runtime avoids globals missing from the bundled Electron baseline', () => {
  assert.doesNotMatch(mainRuntime, /\bstructuredClone\s*\(/u);
});

test('clean loading window is registered before the official runtime and official windows are suppressed', () => {
  assert.ok(
    mainRuntime.indexOf('app.whenReady().then') < mainRuntime.indexOf("officialRequire('./main.jsc')"),
  );
  assert.match(mainRuntime, /function suppressOfficialWindow\(window\)/u);
  assert.match(mainRuntime, /if \(!officialVisible\) \{[\s\S]{0,180}?window\.hide\(\)/u);
  assert.match(mainRuntime, /creatingCleanWindow \|\| window\.getTitle\(\) === 'LeigodClean'/u);
  assert.doesNotMatch(mainRuntime, /showing the official interface/u);
  assert.match(mainRuntime, /Clean renderer failed to load/u);
  assert.match(mainRuntime, /Clean renderer exited unexpectedly/u);
  assert.match(mainRuntime, /officialVisible = true;\s*showOfficialWindow\(\)/u);
  assert.doesNotMatch(html, /正在准备|尚未就绪|继续自动连接|正在连接|等待官方客户端/u);
  assert.match(html, /id="loadingState"[^>]*role="status"[^>]*aria-label="正在加载"/u);
  assert.match(html, /id="accountButton"[^>]*hidden/u);
  assert.match(mainRuntime, /app\.setAppUserModelId\('io\.github\.bunwright\.leigodclean'\)/u);
  assert.ok(
    mainRuntime.indexOf('app.setAppUserModelId') < mainRuntime.indexOf("officialRequire('./main.jsc')"),
  );
});

test('sidebar has a bounded native scroll container', () => {
  assert.match(styles, /\.sidebar\s*\{[^}]*overflow:\s*hidden/isu);
  assert.match(styles, /\.game-list\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/isu);
});

test('toolbar is concise and exposes settings and about dialogs', () => {
  assert.doesNotMatch(html, /官方服务已连接|轻量加速控制/u);
  assert.match(html, /<header class="toolbar[^>]*>[\s\S]*?class="search-wrap toolbar-search no-drag"/u);
  assert.match(html, /id="aboutButton"/u);
  assert.match(html, /id="aboutDialog"/u);
  assert.match(html, /M9\.671 4\.136/u);
  assert.match(mainRuntime, /buildTrayMenuTemplate/u);
});

test('remaining time uses hours and minutes instead of day-only rounding', () => {
  assert.match(script, /`\$\{hours\} 小时 \$\{minutes\} 分钟`/u);
  assert.doesNotMatch(script, /Math\.floor\(hours \/ 24\).*天/u);
  assert.match(html, /id="timeOverview"/u);
  assert.match(html, /id="timeToggleButton"/u);
  assert.doesNotMatch(html, /id="timeLeftMetric"/u);
});

test('acceleration uses one contextual primary action without speculative success copy', () => {
  assert.match(html, /id="startButton"/u);
  assert.match(html, /id="stopIcon"/u);
  assert.doesNotMatch(html, /id="pauseButton"|id="actionHint"|class="bottom-actions"/u);
  assert.doesNotMatch(script, /调用官方加速服务|加速请求已提交/u);
  assert.match(script, /canStopAcceleration\(\) \? stopAcceleration\(\) : startAcceleration\(\)/u);
  assert.match(script, /停止加速/u);
  assert.doesNotMatch(script, /停止并暂停/u);
});

test('primary acceleration control and switchable telemetry occupy the game workspace header', () => {
  assert.ok(html.indexOf('id="startButton"') < html.indexOf('class="workspace-grid"'));
  assert.match(html, /class="session-control" id="sessionBadge"/u);
  assert.match(html, /id="metricSwitcher"[^>]*role="tablist"/u);
  assert.match(html, /data-metric="duration"[\s\S]*data-metric="delay"[\s\S]*data-metric="loss"/u);
  assert.match(script, /function selectTelemetryMetric/u);
  assert.match(html, /id="telemetryCanvas"[^>]*role="img"/u);
  assert.match(html, /data-range="60000"[\s\S]*data-range="300000"[\s\S]*data-range="900000"/u);
  assert.match(script, /model\.selectedMetric !== 'duration'/u);
  assert.match(script, /setTimeout\([\s\S]*2_000/u);
  assert.match(telemetryScript, /MAX_POINTS = 480/u);
  assert.match(styles, /\.workspace-grid\s*\{[^}]*align-items:\s*stretch/isu);
  assert.match(script, /closest\('\.session-panel'\)\?\.classList\.toggle\('charting', chartVisible\)/u);
  assert.match(
    styles,
    /\.session-panel\.charting \.monitor-detail,\s*\.session-panel\.charting \.process-overview\s*\{[^}]*display:\s*none/isu,
  );
  assert.match(styles, /\.telemetry-canvas-wrap\s*\{[^}]*height:\s*74px/isu);
});

test('acceleration state belongs to one game and active games are promoted visibly', () => {
  assert.match(viewStateScript, /selectedIsActive/u);
  assert.match(viewStateScript, /canStop:\s*selectedIsActive && status === 'speeding'/u);
  assert.match(script, /className = 'game-active-indicator'/u);
  assert.match(styles, /\.game-active-indicator\s*\{[^}]*background:\s*var\(--green\)/isu);
  assert.match(script, /promoteGameInList\(gameId, true\)/u);
  assert.match(script, /reason:\s*acceleration\.anotherIsActive \? 'another-game-active'/u);
  assert.match(mainRuntime, /return combinedState\(\);/u);
});

test('modal dialogs dim native controls without mutating Windows button capabilities', () => {
  assert.match(preload, /setModalOpen/u);
  assert.match(mainRuntime, /setCleanModalOpen\(open\)/u);
  assert.doesNotMatch(mainRuntime, /setMinimizable\(/u);
  assert.doesNotMatch(mainRuntime, /setMaximizable\(/u);
  assert.doesNotMatch(mainRuntime, /setClosable\(/u);
  assert.match(mainRuntime, /modalTitleBarOverlay/u);
  assert.match(script, /addEventListener\('close', syncModalPresentation\)/u);
  assert.doesNotMatch(styles, /backdrop-filter/u);
});

test('process automation is event-driven and independent of the official native polling addon', () => {
  assert.doesNotMatch(mainRuntime, /setInterval\s*\(/u);
  assert.doesNotMatch(mainRuntime, /win32Addon|isProcessRunning/u);
  assert.match(mainRuntime, /processEvents\.subscribe\(handleProcessEvent\)/u);
  assert.match(mainRuntime, /bridge\.call\('watchState'/u);
  assert.match(processEvents, /--process-events/u);
  assert.match(mainRuntime, /process-observer\.exe/u);
  assert.match(project, /process-events\.cjs/u);
  assert.match(project, /PublishTrimmed>true/u);
});

test('official shell starts without taskbar painting and keeps the clean tray authoritative', () => {
  assert.match(mainRuntime, /installOfficialShellIsolation/u);
  assert.ok(
    mainRuntime.indexOf('installOfficialShellIsolation') < mainRuntime.indexOf("officialRequire('./main.jsc')"),
  );
  assert.match(mainRuntime, /finally\s*\{\s*restoreOfficialShell\(\)/u);
  assert.match(officialTray, /property === 'Tray'/u);
  assert.match(officialTray, /property === 'BrowserWindow'/u);
  assert.match(officialTray, /paintWhenInitiallyHidden = false/u);
  assert.match(officialTray, /backgroundThrottling:\s*true/u);
  assert.match(officialTray, /nativeSetOpacity\?\.\(0\)/u);
  assert.match(mainRuntime, /window\.setOpacity\?\.\(0\);\s*window\.hide\(\)/u);
  assert.doesNotMatch(mainRuntime, /scheduleCompatibilityFallback|showing the official interface/u);
  assert.match(officialTray, /property === 'setAppUserModelId'/u);
  assert.match(mainRuntime, /tray = new Tray\(/u);
  assert.match(mainRuntime, /tray\.on\('right-click', showTrayContextMenu\)/u);
  assert.match(mainRuntime, /tray\.popUpContextMenu/u);
  assert.match(mainRuntime, /createTrayStatusIcons/u);
  assert.match(trayRuntime, /red:\s*40,\s*green:\s*199,\s*blue:\s*111/su);
  assert.doesNotMatch(trayRuntime, /打开官方客户端/u);
  assert.match(project, /official-tray\.cjs/u);
  assert.match(project, /tray\.cjs/u);
});

test('shutdown is single-request, immediately concealed, and independent of official quit handlers', () => {
  assert.match(mainRuntime, /createShutdownCoordinator/u);
  assert.match(mainRuntime, /cleanWindow\.on\('close', \(event\) => \{\s*event\.preventDefault\(\);\s*void shutdown\.request\(\)/u);
  assert.match(mainRuntime, /function quitFromTray\(\) \{\s*void shutdown\.request\(\)/u);
  assert.match(mainRuntime, /cleanWindow\?\.hide\?\.\(\)/u);
  assert.match(mainRuntime, /exit:\s*\(code\) => app\.exit\(code\)/u);
  assert.doesNotMatch(mainRuntime, /app\.quit\(\)/u);
  assert.match(shutdownRuntime, /if \(completion\) \{\s*return completion/u);
  assert.match(project, /shutdown\.cjs/u);
});

test('preferences use a responsive two-column layout without requiring desktop scrolling', () => {
  assert.match(html, /class="settings-layout"[\s\S]*class="settings-column"[\s\S]*class="settings-column"/u);
  assert.match(styles, /\.settings-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/isu);
  assert.match(styles, /\.settings-dialog form\s*\{[^}]*grid-template-rows:[^}]*overflow:\s*hidden/isu);
});

test('global and per-game automatic acceleration rules are independent', () => {
  assert.match(html, /所有游戏自动加速/u);
  assert.match(html, /单独启用的游戏不受此开关影响/u);
  assert.match(script, /关闭全局开关后仍然生效/u);
  assert.match(mainRuntime, /resolveAutoGameIds\(settings, autoCandidateIds\)/u);
  assert.match(mainRuntime, /bridge\.call\('autoCandidates'\)/u);
  assert.doesNotMatch(
    mainRuntime,
    /autoWatcherPolling \|\| autoStartBusy \|\| !settings\.autoAccelerationEnabled/u,
  );
  assert.match(mainRuntime, /allowSwitch:\s*kind === 'started'/u);
  assert.match(mainRuntime, /new AutoEvaluationQueue/u);
  assert.match(autoAcceleration, /allowSwitch && !actionTaken/u);
  assert.match(mainRuntime, /event\.processes/u);
  assert.match(mainRuntime, /explicitGameIds\.has\(gameId\)/u);
  assert.match(mainRuntime, /autoLocalProcesses/u);
  assert.match(
    script,
    /autoAccelerationInput\.addEventListener\('change', \(\) => void setGlobalAutoAcceleration\(\)\)/u,
  );
});

test('game configuration uses accessible custom pickers and exposes monitored processes', () => {
  assert.match(html, /id="areaPickerButton"[^>]*aria-haspopup="listbox"/u);
  assert.match(html, /id="linePickerMenu"[^>]*role="listbox"/u);
  assert.match(html, /class="native-choice"/u);
  assert.doesNotMatch(html, /class="select-shell"/u);
  assert.match(script, /event\.key === 'ArrowDown'/u);
  assert.match(script, /classList\.toggle\('drop-up', dropUp\)/u);
  assert.match(styles, /\.choice-menu\s*\{[^}]*max-height:\s*276px[^}]*overflow-y:\s*auto/isu);
  assert.match(script, /document\.createDocumentFragment\(\)/u);
  assert.match(html, /id="processList"/u);
  assert.match(mainRuntime, /processes: resolveProcesses\(gameId, game\.processes\)/u);
});

test('line refresh and dialog close controls have icon-sized accessible hit targets', () => {
  assert.match(html, /id="refreshLinesButton"[^>]*aria-label="刷新线路"/u);
  assert.doesNotMatch(html, /id="refreshLinesButton"[^>]*>\s*刷新线路/u);
  assert.match(styles, /\.dialog-close\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/isu);
  assert.match(styles, /\.dialog-header\s*\{[^}]*position:\s*sticky/isu);
  assert.match(styles, /\.dialog-close\s*\{[^}]*-webkit-app-region:\s*no-drag/isu);
});

test('community process catalog recognizes the current Counter-Strike executable', () => {
  assert.ok(communityProcesses.games['119'].includes('cs2.exe'));
});

test('product metadata version matches the launcher version', () => {
  const match = /<Version>([^<]+)<\/Version>/u.exec(project);
  assert.ok(match);
  assert.equal(product.version, match[1]);
  assert.equal(product.name, 'LeigodClean');
});

test('the original brand artwork is used throughout the application', () => {
  assert.match(html, /src="\.\.\/assets\/leigodclean\.svg"/u);
  assert.match(mainRuntime, /assets', 'leigodclean\.png'/u);
  assert.match(project, /<ApplicationIcon>\.\.\\LeigodClean\.Runtime\\assets\\leigodclean\.ico<\/ApplicationIcon>/u);
});

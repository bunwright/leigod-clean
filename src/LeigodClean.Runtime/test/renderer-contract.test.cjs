'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rendererRoot = path.join(__dirname, '..', 'renderer');
const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(rendererRoot, 'app.js'), 'utf8');
const viewStateScript = fs.readFileSync(path.join(rendererRoot, 'view-state.js'), 'utf8');
const styles = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8');
const mainRuntime = fs.readFileSync(path.join(rendererRoot, '..', 'main.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(rendererRoot, '..', 'preload.cjs'), 'utf8');
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
  assert.match(html, /src="view-state\.js"[\s\S]*src="app\.js"/u);
});

test('main runtime avoids globals missing from the bundled Electron baseline', () => {
  assert.doesNotMatch(mainRuntime, /\bstructuredClone\s*\(/u);
});

test('clean loading window is registered before the official runtime and official windows are suppressed', () => {
  assert.ok(
    mainRuntime.indexOf('app.whenReady().then') < mainRuntime.indexOf("officialRequire('./main.jsc')"),
  );
  assert.match(mainRuntime, /function suppressOfficialWindow\(window\)/u);
  assert.match(mainRuntime, /if \(!officialVisible\) \{\s*window\.hide\(\)/u);
  assert.match(mainRuntime, /creatingCleanWindow \|\| window\.getTitle\(\) === 'LeigodClean'/u);
  assert.match(mainRuntime, /showing the official interface/u);
  assert.match(mainRuntime, /Clean renderer failed to load/u);
  assert.match(mainRuntime, /Clean renderer exited unexpectedly/u);
  assert.match(mainRuntime, /officialVisible = true;\s*showOfficialWindow\(\)/u);
  assert.doesNotMatch(html, /正在准备|尚未就绪|继续自动连接|正在连接|等待官方客户端/u);
  assert.match(html, /id="loadingState"[^>]*role="status"[^>]*aria-label="正在加载"/u);
  assert.match(html, /id="accountButton"[^>]*hidden/u);
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
  assert.match(mainRuntime, /lastOfficialState\.accStatus,\s*lastOfficialState\.timeStatus,/u);
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
  assert.match(styles, /backdrop-filter:\s*blur\(7px\) saturate\(\.82\)/u);
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

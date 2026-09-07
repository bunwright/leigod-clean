'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTrayMenuTemplate,
  createTrayStatusIcons,
  decorateActiveTrayBitmap,
  formatRemainingCompact,
} = require('../tray.cjs');

test('tray menu presents concise account, session, time, and recent-game actions', () => {
  const calls = [];
  const template = buildTrayMenuTemplate({
    application: { name: 'LeigodClean', version: '0.4.0' },
    client: {
      connected: true,
      ready: true,
      isLogin: true,
      clientVersion: '11.3.2.5',
      accStatus: 'speeding',
      gameId: 42,
      duration: 65,
      delay: 28,
      loss: 0,
      totalTimeLeft: 3720,
      timeStatus: 'resume',
    },
    activeGameTitle: 'Example Game',
    recentGames: [
      { id: 42, title: 'Example Game' },
      { id: 84, title: 'Second Game' },
    ],
    actions: {
      startGame: (id) => calls.push(`start:${id}`),
      pauseTime: () => calls.push('pause'),
    },
  });

  const labels = template.map((item) => item.label).filter(Boolean);
  assert.deepEqual(labels.slice(0, 2), ['LeigodClean  v0.4.0', '已登录 · 雷神 11.3.2.5']);
  assert.ok(labels.includes('Example Game · 加速中'));
  assert.ok(labels.includes('00:01:05 · 28 ms · 丢包 0%'));
  assert.ok(labels.includes('剩余 1 小时 2 分'));
  assert.ok(labels.includes('停止并暂停'));
  assert.ok(!labels.some((label) => label.includes('官方客户端')));

  const recent = template.find((item) => item.label === '最近游戏').submenu;
  assert.equal(recent[0].enabled, false);
  assert.equal(recent[1].enabled, true);
  recent[1].click();
  template.find((item) => item.label === '停止并暂停').click();
  assert.deepEqual(calls, ['start:84', 'pause']);
});

test('paused tray menu exposes a resume action and handles an empty recent list', () => {
  let resumed = false;
  const template = buildTrayMenuTemplate({
    application: { name: 'LeigodClean' },
    client: {
      connected: true,
      ready: true,
      isLogin: true,
      accStatus: 'normal',
      timeStatus: 'pause',
      totalTimeLeft: 30,
    },
    actions: { resumeTime: () => { resumed = true; } },
  });
  const resume = template.find((item) => item.label === '恢复时长');
  assert.equal(resume.enabled, true);
  resume.click();
  assert.equal(resumed, true);
  assert.equal(template.find((item) => item.label === '最近游戏').submenu[0].enabled, false);
  assert.equal(formatRemainingCompact(30), '不足 1 分钟');
});

test('disconnected state never presents stale acceleration as active', () => {
  const menu = buildTrayMenuTemplate({
    client: {
      connected: false,
      ready: false,
      isLogin: true,
      accStatus: 'speeding',
      gameId: 42,
    },
    activeGameTitle: 'Stale Game',
  });
  assert.equal(menu[1].label, '客户端未连接');
  assert.equal(menu[3].label, '当前未加速');
});

test('active tray bitmap adds a white-ringed green status light', () => {
  const bitmap = Buffer.alloc(20 * 20 * 4);
  const decorated = decorateActiveTrayBitmap(bitmap, 20, 20);
  const centerOffset = ((15 * 20) + 15) * 4;
  assert.equal(decorated[centerOffset], 111);
  assert.equal(decorated[centerOffset + 1], 199);
  assert.equal(decorated[centerOffset + 2], 40);
  assert.equal(decorated[centerOffset + 3], 255);
  assert.deepEqual(bitmap, Buffer.alloc(20 * 20 * 4), 'source bitmap remains unchanged');
});

test('tray status icon creation keeps idle and active images cached separately', () => {
  const bitmap = Buffer.alloc(20 * 20 * 4, 16);
  const idle = { toBitmap: () => bitmap };
  const source = {
    resize(options) {
      assert.deepEqual(options, { width: 20, height: 20, quality: 'best' });
      return idle;
    },
  };
  let activeInput = null;
  const nativeImage = {
    createFromBitmap(input, options) {
      activeInput = input;
      assert.deepEqual(options, { width: 20, height: 20, scaleFactor: 1 });
      return { kind: 'active' };
    },
  };
  const icons = createTrayStatusIcons(nativeImage, source);
  assert.equal(icons.idle, idle);
  assert.deepEqual(icons.active, { kind: 'active' });
  assert.notDeepEqual(activeInput, bitmap);
});

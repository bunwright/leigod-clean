'use strict';

function isAccelerationActive(client = {}) {
  return client.accStatus === 'loading' || client.accStatus === 'speeding';
}

function formatRemainingCompact(seconds) {
  const totalMinutes = Math.floor(Math.max(0, Number(seconds) || 0) / 60);
  if (totalMinutes <= 0) {
    return '不足 1 分钟';
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) {
    return `${hours} 小时 ${minutes} 分`;
  }
  return hours > 0 ? `${hours} 小时` : `${minutes} 分钟`;
}

function formatDurationCompact(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return [hours, minutes, remaining]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

function buildTrayMenuTemplate({
  application = {},
  client = {},
  activeGameTitle = '',
  recentGames = [],
  busy = false,
  actions = {},
} = {}) {
  const name = String(application.name || 'LeigodClean');
  const version = String(application.version || '').trim();
  const connected = client.connected === true && client.ready === true;
  const loggedIn = connected && client.isLogin === true;
  const active = connected && isAccelerationActive(client);
  const loading = client.accStatus === 'loading';
  const activeGameId = active ? String(client.gameId || '') : '';
  const paused = client.timeStatus === 'pause';
  const delay = Math.max(0, Number(client.delay) || 0);
  const loss = Math.max(0, Number(client.loss) || 0);
  const title = String(activeGameTitle || '').trim() || '当前游戏';
  const candidates = Array.isArray(recentGames) ? recentGames.slice(0, 3) : [];

  const recentSubmenu = candidates.length > 0
    ? candidates.map((game) => {
      const id = String(game?.id || '');
      const current = Boolean(activeGameId && id === activeGameId);
      return {
        label: `${String(game?.title || `游戏 ${id}`)}${current ? ' · 当前' : ''}`,
        enabled: loggedIn && !busy && !current,
        click: () => actions.startGame?.(id),
      };
    })
    : [{ label: '暂无最近游戏', enabled: false }];

  const template = [
    { label: `${name}${version ? `  v${version}` : ''}`, enabled: false },
    {
      label: connected
        ? (loggedIn ? '已登录' : '未登录')
        : '客户端未连接',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: active ? `${title} · ${loading ? '启动中' : '加速中'}` : '当前未加速',
      enabled: false,
    },
  ];

  if (active) {
    template.push({
      label: `${formatDurationCompact(client.duration)} · ${delay > 0 ? `${delay} ms` : '— ms'} · 丢包 ${loss}%`,
      enabled: false,
    });
  }
  if (loggedIn) {
    template.push({
      label: `剩余 ${formatRemainingCompact(client.totalTimeLeft)}`,
      enabled: false,
    });
  }

  template.push(
    {
      label: paused ? '恢复时长' : '停止并暂停',
      enabled: loggedIn && !busy,
      click: () => (paused ? actions.resumeTime?.() : actions.pauseTime?.()),
    },
    { type: 'separator' },
    { label: '最近游戏', submenu: recentSubmenu },
    { type: 'separator' },
    { label: '打开 LeigodClean', click: () => actions.show?.() },
    { label: '偏好设置…', click: () => actions.openSettings?.() },
    { type: 'separator' },
    { label: '退出', click: () => actions.quit?.() },
  );
  return template;
}

function blendPixel(bitmap, offset, red, green, blue, opacity) {
  const sourceAlpha = Math.max(0, Math.min(1, opacity));
  if (sourceAlpha <= 0) {
    return;
  }
  const targetAlpha = bitmap[offset + 3] / 255;
  const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  const blend = (source, target) => outputAlpha <= 0
    ? 0
    : Math.round((source * sourceAlpha + target * targetAlpha * (1 - sourceAlpha)) / outputAlpha);
  bitmap[offset] = blend(blue, bitmap[offset]);
  bitmap[offset + 1] = blend(green, bitmap[offset + 1]);
  bitmap[offset + 2] = blend(red, bitmap[offset + 2]);
  bitmap[offset + 3] = Math.round(outputAlpha * 255);
}

function paintCircle(bitmap, width, height, centerX, centerY, radius, color) {
  const left = Math.max(0, Math.floor(centerX - radius - 1));
  const right = Math.min(width - 1, Math.ceil(centerX + radius + 1));
  const top = Math.max(0, Math.floor(centerY - radius - 1));
  const bottom = Math.min(height - 1, Math.ceil(centerY + radius + 1));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const distance = Math.hypot((x + 0.5) - centerX, (y + 0.5) - centerY);
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - distance));
      if (coverage > 0) {
        blendPixel(bitmap, ((y * width) + x) * 4, color.red, color.green, color.blue, coverage);
      }
    }
  }
}

function decorateActiveTrayBitmap(bitmapInput, width, height) {
  if (!Buffer.isBuffer(bitmapInput) || bitmapInput.length < width * height * 4) {
    throw new TypeError('A BGRA tray bitmap is required.');
  }
  const bitmap = Buffer.from(bitmapInput);
  const scale = Math.min(width, height) / 20;
  const centerX = width - (4.25 * scale);
  const centerY = height - (4.25 * scale);
  paintCircle(bitmap, width, height, centerX, centerY, 4.35 * scale, {
    red: 255,
    green: 255,
    blue: 255,
  });
  paintCircle(bitmap, width, height, centerX, centerY, 3.15 * scale, {
    red: 40,
    green: 199,
    blue: 111,
  });
  return bitmap;
}

function createTrayStatusIcons(nativeImage, source, size = 20) {
  if (!nativeImage || typeof nativeImage.createFromBitmap !== 'function' ||
    !source || typeof source.resize !== 'function') {
    throw new TypeError('Electron nativeImage and a source image are required.');
  }
  const idle = source.resize({ width: size, height: size, quality: 'best' });
  const activeBitmap = decorateActiveTrayBitmap(idle.toBitmap(), size, size);
  const active = nativeImage.createFromBitmap(activeBitmap, {
    width: size,
    height: size,
    scaleFactor: 1,
  });
  return { idle, active };
}

module.exports = {
  buildTrayMenuTemplate,
  createTrayStatusIcons,
  decorateActiveTrayBitmap,
  formatDurationCompact,
  formatRemainingCompact,
  isAccelerationActive,
};

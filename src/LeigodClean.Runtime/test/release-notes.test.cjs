'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractReleaseNotes } = require('../../../scripts/extract-release-notes.cjs');

const changelog = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8');
const product = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'product.json'), 'utf8'));

test('release notes are extracted from exactly one changelog version', () => {
  const notes = extractReleaseNotes(changelog, `v${product.version}`);
  assert.match(notes, /已安装及最近游戏不再触发启动、结束通知/u);
  assert.doesNotMatch(notes, /840 像素/u);
  assert.doesNotMatch(notes, /增加可选的极简模式/u);
  assert.doesNotMatch(notes, /官方状态已就绪后被错误重置/u);
  assert.match(notes, /blob\/main\/CHANGELOG\.md/u);
});

test('release notes reject missing or malformed tags', () => {
  assert.throws(() => extractReleaseNotes(changelog, 'latest'), /Invalid release tag/u);
  assert.throws(() => extractReleaseNotes(changelog, 'v9.9.9'), /no section/u);
});

test('the final changelog section excludes link-reference definitions', () => {
  const notes = extractReleaseNotes(changelog, 'v0.1.0');
  assert.match(notes, /提供游戏搜索/u);
  assert.doesNotMatch(notes, /^\[未发布\]:/mu);
  assert.doesNotMatch(notes, /^\[[^\]\r\n]+\]:/mu);
});

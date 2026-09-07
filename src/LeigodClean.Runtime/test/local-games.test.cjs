'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  discoverInstalledGameIds,
  discoverInstalledGames,
  executableName,
  executableLocation,
  executableMatchesLocations,
  steamAppId,
} = require('../local-games.cjs');

test('discovers installed games by registry name, display name, or normalized location', () => {
  const installed = {
    'steam app 730': {
      display_name: 'Counter-Strike 2',
      install_location: 'steam://rungameid/730',
    },
    launcher: {
      display_name: 'Example Online',
      install_location: 'C:\\Games\\Example\\',
    },
  };
  const mappings = [
    { game_id: 455, parent_game_id: 119, info: { reg_name: 'Steam App 730' } },
    { game_id: 119, parent_game_id: 119, info: { reg_localpath: 'steam://rungameid/730/' } },
    { game_id: 42, parent_game_id: 42, info: { reg_name: 'example online' } },
    { game_id: 43, parent_game_id: 43, info: { reg_localpath: 'c:/games/example' } },
  ];

  assert.deepEqual(discoverInstalledGameIds(installed, mappings), [119, 42, 43]);
  assert.deepEqual(discoverInstalledGames(installed, mappings), [
    { id: 119, locations: [], processes: [] },
    {
      id: 42,
      locations: [{ kind: 'directory', path: 'C:\\Games\\Example' }],
      processes: [],
    },
    {
      id: 43,
      locations: [{ kind: 'directory', path: 'C:\\Games\\Example' }],
      processes: [],
    },
  ]);
});

test('filters malformed and excluded mappings and caps duplicate parent games', () => {
  const installed = { game: { display_name: 'Game' } };
  const mappings = [
    { game_id: 1, parent_game_id: 10, info: { reg_name: 'game' } },
    { game_id: 2, parent_game_id: 10, info: { display_name: 'Game' } },
    { game_id: 3, parent_game_id: 11, info: { reg_name: 'Game' } },
    { game_id: 'invalid', info: { reg_name: 'Game' } },
  ];

  assert.deepEqual(discoverInstalledGameIds(installed, mappings, [11]), [10]);
});

test('normalizes launcher commands and matches exact files or install directories', () => {
  assert.deepEqual(
    executableLocation('"C:\\Riot Games\\Riot Client\\RiotClientServices.exe" --launch-product=x'),
    { kind: 'file', path: 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe' },
  );
  assert.deepEqual(
    executableLocation('C:\\Games\\Example\\launcher.exe --silent'),
    { kind: 'file', path: 'C:\\Games\\Example\\launcher.exe' },
  );
  assert.equal(executableLocation('steam://rungameid/730'), null);
  assert.equal(executableName('bin\\Game-Win64-Shipping.exe'), 'Game-Win64-Shipping.exe');
  assert.equal(executableName('GameAssembly.dll'), '');
  assert.equal(steamAppId('Steam App 730'), '730');
  assert.equal(steamAppId('', 'steam://rungameid/1091500'), '1091500');
  assert.equal(executableMatchesLocations('C:\\Games\\Example\\Bin\\Game.exe', [
    { kind: 'directory', path: 'c:\\games\\example' },
  ]), true);
  assert.equal(executableMatchesLocations('C:\\Games\\Other\\Game.exe', [
    { kind: 'directory', path: 'C:\\Games\\Example' },
  ]), false);
  assert.equal(executableMatchesLocations('C:\\Games\\Example\\launcher.exe', [
    { kind: 'file', path: 'c:\\games\\example\\launcher.exe' },
  ]), true);
});

test('uses resolved Steam library locations for installed games', () => {
  const installed = {
    'steam app 730': {
      display_name: 'Counter-Strike 2',
      install_location: 'steam://rungameid/730',
    },
  };
  const mappings = [{ parent_game_id: 119, info: { reg_name: 'steam app 730' } }];

  assert.deepEqual(discoverInstalledGames(installed, mappings, [], {
    steamInstallLocations: {
      730: 'D:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive',
    },
  }), [{
    id: 119,
    locations: [{
      kind: 'directory',
      path: 'D:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive',
    }],
    processes: [],
  }]);
});

test('derives executable names from matched local application metadata', () => {
  const installed = {
    example: {
      display_name: 'Example Game',
      install_location: 'C:\\Games\\Example\\Launcher.exe --silent',
    },
  };
  const mappings = [{
    parent_game_id: 42,
    info: {
      reg_name: 'Example Game',
      reg_relativepath: 'Binaries\\Game.exe',
    },
  }];

  assert.deepEqual(discoverInstalledGames(installed, mappings), [{
    id: 42,
    locations: [{ kind: 'file', path: 'C:\\Games\\Example\\Launcher.exe' }],
    processes: ['Game.exe', 'Launcher.exe'],
  }]);
});

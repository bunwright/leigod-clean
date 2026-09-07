'use strict';

function normalizedText(value) {
  return String(value ?? '').trim().toLocaleLowerCase('en-US');
}

function normalizedLocation(value) {
  return normalizedText(value).replace(/\//gu, '\\').replace(/\\+$/gu, '');
}

function executableLocation(value) {
  let location = String(value ?? '').trim();
  if (!location || /^[a-z][a-z0-9+.-]*:\/\//iu.test(location)) {
    return null;
  }
  if (location.startsWith('"')) {
    const closingQuote = location.indexOf('"', 1);
    location = closingQuote > 1 ? location.slice(1, closingQuote) : location.slice(1);
  } else {
    const executable = location.match(/^(.+?\.exe)(?:\s+.*)?$/iu);
    if (executable) {
      location = executable[1];
    }
  }
  location = location.trim().replace(/\//gu, '\\').replace(/\\+$/gu, '');
  if (!/^(?:[a-z]:\\|\\\\)/iu.test(location) || /[\0\r\n]/u.test(location)) {
    return null;
  }
  return {
    kind: /\.exe$/iu.test(location) ? 'file' : 'directory',
    path: location,
  };
}

function steamAppId(...values) {
  for (const value of values) {
    const match = String(value ?? '').match(/(?:steam\s+app\s+|steam:\/\/rungameid\/)(\d+)/iu);
    if (match) {
      return match[1];
    }
  }
  return '';
}

function executableName(value) {
  let candidate = String(value ?? '').trim();
  if (!candidate) {
    return '';
  }
  if (candidate.startsWith('"')) {
    const closingQuote = candidate.indexOf('"', 1);
    candidate = closingQuote > 1 ? candidate.slice(1, closingQuote) : candidate.slice(1);
  } else {
    candidate = candidate.match(/^(.+?\.exe)(?:\s+.*)?$/iu)?.[1] ?? candidate;
  }
  const name = candidate.replace(/\//gu, '\\').split('\\').at(-1)?.trim() ?? '';
  return /^[^\\/:*?"<>|\0\r\n]{1,260}\.exe$/iu.test(name) ? name : '';
}

function discoverInstalledGames(installedApps, gamePaths, excludedGameIds = [], options = {}) {
  const steamInstallLocations = options?.steamInstallLocations &&
    typeof options.steamInstallLocations === 'object'
    ? options.steamInstallLocations
    : {};
  const applications = installedApps && typeof installedApps === 'object' && !Array.isArray(installedApps)
    ? Object.entries(installedApps).map(([key, application]) => ({
      names: new Set([
        normalizedText(key),
        normalizedText(application?.display_name),
      ].filter(Boolean)),
      rawLocation: normalizedLocation(application?.install_location),
      executableLocation: executableLocation(
        steamInstallLocations[steamAppId(key, application?.install_location)] ??
          application?.install_location,
      ),
    }))
    : [];
  const applicationsByName = new Map();
  const applicationsByLocation = new Map();
  for (const application of applications) {
    for (const name of application.names) {
      if (!applicationsByName.has(name)) {
        applicationsByName.set(name, []);
      }
      applicationsByName.get(name).push(application);
    }
    if (application.rawLocation) {
      if (!applicationsByLocation.has(application.rawLocation)) {
        applicationsByLocation.set(application.rawLocation, []);
      }
      applicationsByLocation.get(application.rawLocation).push(application);
    }
  }
  const excluded = new Set((Array.isArray(excludedGameIds) ? excludedGameIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0));
  const games = new Map();

  for (const mapping of Array.isArray(gamePaths) ? gamePaths : []) {
    const gameId = Number(mapping?.parent_game_id ?? mapping?.game_id);
    if (!Number.isSafeInteger(gameId) || gameId <= 0 || excluded.has(gameId)) {
      continue;
    }
    const info = mapping?.info ?? {};
    const mappingNames = new Set([info.reg_name, info.display_name]
      .map(normalizedText)
      .filter(Boolean));
    const mappingLocation = normalizedLocation(info.reg_localpath);
    const matches = new Set();
    for (const name of mappingNames) {
      for (const application of applicationsByName.get(name) ?? []) {
        matches.add(application);
      }
    }
    for (const application of applicationsByLocation.get(mappingLocation) ?? []) {
      matches.add(application);
    }
    if (matches.size === 0) {
      continue;
    }
    if (!games.has(gameId)) {
      games.set(gameId, { id: gameId, locations: new Map(), processes: new Map() });
    }
    const mappingProcess = executableName(info.reg_relativepath) ||
      executableName(info.reg_localpath);
    if (mappingProcess) {
      games.get(gameId).processes.set(normalizedText(mappingProcess), mappingProcess);
    }
    for (const application of matches) {
      const location = application.executableLocation;
      if (location) {
        games.get(gameId).locations.set(
          `${location.kind}:${normalizedLocation(location.path)}`,
          location,
        );
        const installedProcess = location.kind === 'file' ? executableName(location.path) : '';
        if (installedProcess) {
          games.get(gameId).processes.set(normalizedText(installedProcess), installedProcess);
        }
      }
    }
  }

  return [...games.values()].slice(0, 500).map((game) => ({
    id: game.id,
    locations: [...game.locations.values()],
    processes: [...game.processes.values()],
  }));
}

function discoverInstalledGameIds(installedApps, gamePaths, excludedGameIds = [], options = {}) {
  return discoverInstalledGames(installedApps, gamePaths, excludedGameIds, options)
    .map((game) => game.id);
}

function executableMatchesLocations(executablePath, locations) {
  const candidate = normalizedLocation(executablePath);
  if (!candidate || !/^(?:[a-z]:\\|\\\\)/iu.test(candidate)) {
    return false;
  }
  return (Array.isArray(locations) ? locations : []).some((location) => {
    const target = normalizedLocation(location?.path ?? location);
    if (!target) {
      return false;
    }
    if (location?.kind === 'file' || /\.exe$/iu.test(target)) {
      return candidate === target;
    }
    return candidate === target || candidate.startsWith(`${target}\\`);
  });
}

module.exports = {
  discoverInstalledGameIds,
  discoverInstalledGames,
  executableName,
  executableLocation,
  executableMatchesLocations,
  steamAppId,
};

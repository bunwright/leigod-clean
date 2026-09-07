'use strict';

const fs = require('node:fs');
const path = require('node:path');

function extractReleaseNotes(changelog, tag) {
  const version = String(tag || '').trim().replace(/^v/u, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Invalid release tag: ${tag || '<empty>'}`);
  }
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const heading = new RegExp(`^## \\[${escapedVersion}\\](?: - [^\\r\\n]+)?\\r?$`, 'mu');
  const match = heading.exec(String(changelog || ''));
  if (!match) {
    throw new Error(`CHANGELOG.md has no section for ${version}.`);
  }
  const sectionStart = match.index + match[0].length;
  const remainder = String(changelog).slice(sectionStart);
  const nextBoundary = /^(?:## \[|\[[^\]\r\n]+\]:\s)/mu.exec(remainder);
  const body = remainder.slice(0, nextBoundary?.index ?? remainder.length).trim();
  if (!body) {
    throw new Error(`CHANGELOG.md section ${version} is empty.`);
  }
  return `${body}\n\n[查看完整更新日志](https://github.com/bunwright/leigod-clean/blob/main/CHANGELOG.md)`;
}

function run(argv = process.argv.slice(2)) {
  const [tag, outputPath, ...options] = argv;
  if (!tag || !outputPath) {
    throw new Error('Usage: node scripts/extract-release-notes.cjs <tag> <output> [--historical]');
  }
  const repositoryRoot = path.resolve(__dirname, '..');
  const changelog = fs.readFileSync(path.join(repositoryRoot, 'CHANGELOG.md'), 'utf8');
  const product = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'src', 'LeigodClean.Runtime', 'product.json'),
    'utf8',
  ));
  const version = String(tag).trim().replace(/^v/u, '');
  const historical = options.includes('--historical');
  if (!historical && String(product.version) !== version) {
    throw new Error(`Release tag ${tag} does not match product version ${product.version}.`);
  }
  const notes = extractReleaseNotes(changelog, tag);
  const resolvedOutput = path.resolve(repositoryRoot, outputPath);
  const relativeOutput = path.relative(repositoryRoot, resolvedOutput);
  if (relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) {
    throw new Error('Release notes output must stay inside the repository.');
  }
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, `${notes}\n`, 'utf8');
  process.stdout.write(`Prepared release notes for ${tag}.\n`);
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { extractReleaseNotes, run };

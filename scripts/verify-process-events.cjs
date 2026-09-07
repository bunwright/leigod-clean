'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const executable = path.resolve(String(process.argv[2] ?? ''));
if (!process.argv[2]) {
  console.error('Usage: node scripts/verify-process-events.cjs <LeigodClean.exe>');
  process.exit(2);
}

const observer = spawn(executable, ['--process-events'], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let target = null;
let buffer = '';
let diagnostic = '';
let sawStart = false;
let sawStop = false;
let finished = false;

const timeout = setTimeout(() => fail('Timed out waiting for process start and stop events.'), 20000);
observer.stderr.setEncoding('utf8');
observer.stderr.on('data', (chunk) => {
  diagnostic = `${diagnostic}${chunk}`.slice(-8000);
});
observer.on('error', (error) => fail(`Observer could not start: ${error.message}`));
observer.on('close', (code) => {
  if (!finished) {
    fail(`Observer exited early with code ${code}.${diagnostic ? `\n${diagnostic}` : ''}`);
  }
});
observer.stdout.setEncoding('utf8');
observer.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      acceptLine(line);
    }
    newline = buffer.indexOf('\n');
  }
});

function acceptLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch (error) {
    fail(`Observer returned invalid JSON: ${error.message}`);
    return;
  }
  if (event.type === 'error') {
    fail(`Observer reported an error: ${event.message}${diagnostic ? `\n${diagnostic}` : ''}`);
    return;
  }
  if (event.type === 'snapshot' && !target) {
    target = spawn('ping.exe', ['127.0.0.1', '-n', '3'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    target.on('error', (error) => fail(`Probe process could not start: ${error.message}`));
    return;
  }
  if (!target || Number(event.pid) !== target.pid) {
    return;
  }
  if (event.type === 'started') {
    sawStart = true;
  } else if (event.type === 'stopped') {
    sawStop = true;
  }
  if (sawStart && sawStop) {
    succeed();
  }
}

function succeed() {
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(timeout);
  observer.stdin.end('stop\n');
  console.log(`Verified event-driven process start/stop for PID ${target.pid}.`);
}

function fail(message) {
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(timeout);
  try {
    observer.stdin.end('stop\n');
  } catch {
    // The observer may already be closed.
  }
  setTimeout(() => {
    try {
      observer.kill();
    } catch {
      // The observer may have completed its graceful shutdown.
    }
    try {
      target?.kill();
    } catch {
      // The probe process may already have exited.
    }
  }, 2000).unref();
  console.error(message);
  process.exitCode = 1;
}

#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = resolve(rootDir, 'src/index.ts');

const child = spawn(
  process.execPath,
  ['--import', 'tsx', entrypoint, ...process.argv.slice(2)],
  {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  }
);

child.on('error', error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

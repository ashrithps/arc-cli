import os from 'os';
import path from 'path';

function getHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || os.homedir();
}

export function getArcHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getHomeDir(env), '.arc-cli');
}

export function getArcConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getArcHome(env), 'config.json');
}

export function getArcDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getArcHome(env), 'data');
}

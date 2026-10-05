import os from 'os';
import path from 'path';

function getHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || os.homedir();
}

/** `~/.arc-cli`, or `ARC_CONFIG_DIR` for a second install or an isolated run. */
export function getArcHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ARC_CONFIG_DIR) return path.resolve(env.ARC_CONFIG_DIR);
  return path.join(getHomeDir(env), '.arc-cli');
}

export function getArcConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getArcHome(env), 'config.json');
}

export function getArcDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getArcHome(env), 'data');
}

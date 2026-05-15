import * as path from 'node:path';

export const PROJECT_ROOT = process.env.PROJECT_ROOT
  ? path.resolve(process.env.PROJECT_ROOT)
  : path.resolve(__dirname, '..', '..', '..');

export const STORAGE_DIRS = {
  root: path.join(PROJECT_ROOT, 'storage'),
  profiles: path.join(PROJECT_ROOT, 'storage', 'profiles'),
  screenshots: path.join(PROJECT_ROOT, 'storage', 'screenshots'),
  html: path.join(PROJECT_ROOT, 'storage', 'html'),
  logs: path.join(PROJECT_ROOT, 'storage', 'logs'),
} as const;

export const PORTS = {
  web: 3000,
  api: 3001,
  postgres: 5432,
} as const;

export const HOSTS = {
  web: '127.0.0.1',
  api: '127.0.0.1',
} as const;

export const JOB_POLL_INTERVAL_MS = 750;
export const SCAN_ACCOUNT_BASE_INTERVAL_MS = 7 * 60 * 1000;
export const SCAN_ACCOUNT_JITTER_MS = 3 * 60 * 1000;

export function accountProfilePath(accountId: number | string): string {
  return path.join(STORAGE_DIRS.profiles, String(accountId));
}

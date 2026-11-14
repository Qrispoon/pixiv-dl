/**
 * 常量与小工具：路径、时间、日志。
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const APP_NAME = 'pixiv-tag-dl';

export const APP_UA = 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)';
export const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
export const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
export const HASH_SECRET = '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c';
export const OAUTH_URL = 'https://oauth.secure.pixiv.net/auth/token';
export const API_BASE = 'https://app-api.pixiv.net';
export const WEB_BASE = 'https://www.pixiv.net';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const isoDate = (d = new Date()) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

export const addDays = (dateStr, days) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return isoDate(dt);
};

export const dayOf = (iso) => iso.slice(0, 10);

export function createLogger({ quiet = false, verbose = false } = {}) {
  const log = (...args) => {
    if (!quiet) console.log(...args);
  };
  log.verbose = (...args) => {
    if (verbose && !quiet) console.log('[debug]', ...args);
  };
  log.warn = (...args) => console.error('[warn]', ...args);
  return log;
}

export class UserError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'UserError';
    this.exitCode = exitCode;
  }
}

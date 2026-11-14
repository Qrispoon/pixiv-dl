/**
 * 鉴权：refresh_token → access_token。
 *
 * token 来源（优先级）：
 *   1. 环境变量 PIXIV_REFRESH_TOKEN
 *   2. 配置文件 refreshToken
 *   3. <repo>/.secrets/pixiv-refresh-token.txt（scripts/login.mjs 写入）
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  APP_UA,
  CLIENT_ID,
  CLIENT_SECRET,
  HASH_SECRET,
  OAUTH_URL,
  REPO_ROOT,
  UserError,
  sleep,
} from './common.mjs';
import { md5, requestJson } from './http.mjs';

let cache = null;

export function loadRefreshToken(config = {}) {
  const env = process.env.PIXIV_REFRESH_TOKEN?.trim();
  if (env) return env;
  if (config.refreshToken) return String(config.refreshToken).trim();
  const file = join(REPO_ROOT, '.secrets', 'pixiv-refresh-token.txt');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  return null;
}

export async function getAuth(config, log) {
  if (cache && cache.expiresAt > Date.now() + 60_000) return cache;
  const refreshToken = loadRefreshToken(config);
  if (!refreshToken) {
    throw new UserError(
      '未找到 refresh_token。请先运行 `node scripts/login.mjs`（或 ptdl login），或设置 PIXIV_REFRESH_TOKEN。',
      3,
    );
  }
  const time = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const body = new URLSearchParams({
    get_secure_url: '1',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const r = await requestJson(OAUTH_URL, {
    method: 'POST',
    body,
    timeout: 60_000,
    retries: 2,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': APP_UA,
      'App-OS': 'ios',
      'App-OS-Version': '16.7.2',
      'X-Client-Time': time,
      'X-Client-Hash': md5(time + HASH_SECRET),
    },
    log,
  });
  if (r.status !== 200 || !r.json?.response?.access_token) {
    if (r.status === 400) {
      throw new UserError(`refresh_token 无效或已过期（${JSON.stringify(r.json?.error ?? r.json)}），请重新登录。`, 3);
    }
    throw new UserError(`刷新 access_token 失败：HTTP ${r.status}`, 4);
  }
  const response = r.json.response;
  cache = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    user: response.user,
    expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000,
    savedAt: Date.now(),
  };
  return cache;
}

export function clearAuthCache() {
  cache = null;
}

export { sleep };

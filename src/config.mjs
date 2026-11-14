/**
 * 配置：默认值 + 配置文件合并。
 *
 * 优先级：CLI 参数 > 环境变量 > ./ptdl.config.json > %APPDATA%/pixiv-tag-dl/config.json > 默认值
 * （CLI 合并发生在 cli.mjs，这里只负责文件层）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { APP_NAME, UserError } from './common.mjs';

export const DEFAULTS = {
  out: './downloads',
  minBookmarks: 0,
  maxBookmarks: null,
  limit: null,
  maxPages: 200,
  since: null,
  until: null,
  sort: 'date',
  exact: false,
  and: false,
  type: 'all',
  r18: 'exclude',
  ai: 'include',
  ugoira: 'gif', // M1 默认：动图转 GIF（本机 ffmpeg 已实测）
  ugoiraWidth: 540,
  keepUgoiraZip: false,
  name: '{artist}-{id}-{bookmarks}',
  byTag: false,
  jobs: 2,
  delay: 2,
  retries: 5,
  timeout: 60,
  proxy: null,
  refreshToken: null,
  dryRun: false,
  force: false,
  noResume: false,
  json: false,
  verbose: false,
};

const userConfigPath = () => {
  const appData = process.env.APPDATA;
  return appData ? join(appData, APP_NAME, 'config.json') : null;
};

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UserError(`配置文件解析失败：${path}\n${e.message}`, 2);
  }
}

export function loadConfig({ configPath } = {}) {
  const layers = [];
  const candidates = [userConfigPath(), resolve('./ptdl.config.json'), configPath ? resolve(configPath) : null]
    .filter(Boolean);
  for (const file of candidates) {
    if (existsSync(file)) layers.push({ file, data: readJson(file) });
  }
  const merged = { ...DEFAULTS };
  for (const { data } of layers) Object.assign(merged, data);
  return { config: merged, configFiles: layers.map((l) => l.file) };
}

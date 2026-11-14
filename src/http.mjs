/**
 * HTTP 层：统一超时 / 重试 / 429 冷却 / 流式下载。
 *
 * 注意：代理必须在进程启动前通过 HTTPS_PROXY + NODE_USE_ENV_PROXY=1 生效（见 bin/ptdl.mjs）。
 */

import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import process from 'node:process';
import { sleep } from './common.mjs';

export const md5 = (s) => createHash('md5').update(s).digest('hex');

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function retryAfterMs(res, fallbackMs) {
  const raw = res.headers.get('retry-after');
  if (!raw) return fallbackMs;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec > 0) return Math.min(sec * 1000, 15 * 60_000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 15 * 60_000));
  return fallbackMs;
}

export async function requestJson(url, {
  method = 'GET',
  headers = {},
  body,
  timeout = 60_000,
  retries = 3,
  log,
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { method, headers, body, signal: ctrl.signal, redirect: 'follow' });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* 非 JSON 响应 */
      }
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        const wait = res.status === 429 ? retryAfterMs(res, 65_000) : Math.min(2 ** attempt * 1000, 30_000);
        log?.warn?.(`HTTP ${res.status}${res.status === 429 ? '（限流）' : ''}，${Math.round(wait / 1000)}s 后重试（${attempt + 1}/${retries}）`);
        await sleep(wait);
        continue;
      }
      return { status: res.status, json, text, headers: res.headers };
    } catch (e) {
      lastError = e;
      if (attempt >= retries) break;
      const wait = Math.min(2 ** attempt * 1000, 30_000);
      log?.warn?.(`网络错误：${e.cause?.message ?? e.message}，${Math.round(wait / 1000)}s 后重试（${attempt + 1}/${retries}）`);
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`请求失败：${url}\n${lastError?.cause?.message ?? lastError?.message ?? 'unknown'}`);
}

/**
 * 下载到文件：先写 .part，成功后 rename；失败清理 .part。
 * @returns {Promise<{bytes:number, contentType:string|null}>}
 */
export async function downloadToFile(url, destPath, {
  headers = {},
  timeout = 120_000,
  retries = 3,
  log,
} = {}) {
  mkdirSync(dirname(destPath), { recursive: true });
  const part = `${destPath}.part`;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal, redirect: 'follow' });
      if (res.status !== 200) {
        const wait = res.status === 429 ? retryAfterMs(res, 65_000) : Math.min(2 ** attempt * 1000, 20_000);
        const err = new Error(`HTTP ${res.status}（${url}）`);
        err.status = res.status;
        if ((RETRYABLE_STATUS.has(res.status) || res.status === 403) && attempt < retries) {
          log?.warn?.(`下载 HTTP ${res.status}，${Math.round(wait / 1000)}s 后重试（${attempt + 1}/${retries}）`);
          await res.body?.cancel?.();
          await sleep(wait);
          continue;
        }
        throw err;
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType && !contentType.startsWith('image/') && !contentType.includes('zip')) {
        throw new Error(`响应不是图片/zip：${contentType}`);
      }
      const expected = Number(res.headers.get('content-length') ?? 0);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
      if (expected > 0) {
        const { statSync } = await import('node:fs');
        const got = statSync(part).size;
        if (got !== expected) throw new Error(`大小不一致：期望 ${expected}，实际 ${got}`);
      }
      renameSync(part, destPath);
      const { statSync } = await import('node:fs');
      return { bytes: statSync(destPath).size, contentType };
    } catch (e) {
      lastError = e;
      try {
        unlinkSync(part);
      } catch {
        /* ignore */
      }
      if (e.status && !RETRYABLE_STATUS.has(e.status) && e.status !== 403) break;
      if (attempt >= retries) break;
      const wait = Math.min(2 ** attempt * 1000, 20_000);
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error(`下载失败：${url}`);
}

export function extFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    const e = extname(p).toLowerCase();
    return e && e.length <= 6 ? e : '.jpg';
  } catch {
    return '.jpg';
  }
}

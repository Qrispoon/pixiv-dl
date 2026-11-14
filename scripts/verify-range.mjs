#!/usr/bin/env node
/**
 * 区间下载校验：把一次下载的 state 与「独立枚举 + Web total」对比，回答：
 *   1) 下载数量是否等于 App API 在该区间的可见作品数（含 R-18 口径）；
 *   2) 是否与 Web 端（匿名安全口径）数量一致；
 *   3) R-18 / 收藏 >100 的子集是否完整；
 *   4) 具体缺了哪些 pid（如果缺）。
 *
 * 用法：
 *   node scripts/verify-range.mjs --tag 西行寺幽々子 --since 2026-10-26 --until 2026-11-14 --out downloads-test-yuyuko
 *
 * 只读：不发写请求、不下载图片。默认 1.2s/请求，避免 429。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { APP_UA, CLIENT_ID, CLIENT_SECRET, HASH_SECRET, OAUTH_URL, REPO_ROOT } from '../src/common.mjs';

const argv = process.argv.slice(2);
const opt = { tag: null, since: null, until: null, out: null, delay: 1200, json: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--tag') opt.tag = argv[++i];
  else if (a === '--since') opt.since = argv[++i];
  else if (a === '--until') opt.until = argv[++i];
  else if (a === '--out') opt.out = argv[++i];
  else if (a === '--delay') opt.delay = Number(argv[++i]);
  else if (a === '--json') opt.json = true;
  else if (a === '--help' || a === '-h') {
    console.log('用法: node scripts/verify-range.mjs --tag <tag> --since YYYY-MM-DD --until YYYY-MM-DD --out <下载目录> [--delay 1200] [--json]');
    process.exit(0);
  }
}
if (!opt.tag || !opt.since || !opt.until || !opt.out) {
  console.error('需要 --tag / --since / --until / --out');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = async (s) => {
  const { createHash } = await import('node:crypto');
  return createHash('md5').update(s).digest('hex');
};

function loadRefreshToken() {
  if (process.env.PIXIV_REFRESH_TOKEN?.trim()) return process.env.PIXIV_REFRESH_TOKEN.trim();
  const f = join(REPO_ROOT, '.secrets', 'pixiv-refresh-token.txt');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  throw new Error('未找到 refresh_token（先运行 scripts/login.mjs）');
}

async function getToken() {
  const time = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const body = new URLSearchParams({
    get_secure_url: '1',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: loadRefreshToken(),
  });
  const r = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': APP_UA,
      'App-OS': 'ios',
      'App-OS-Version': '16.7.2',
      'X-Client-Time': time,
      'X-Client-Hash': await md5(time + HASH_SECRET),
    },
    body,
  });
  const j = await r.json();
  if (r.status !== 200) throw new Error(`刷新 token 失败：HTTP ${r.status}`);
  return j.response.access_token;
}

function readState(outDir) {
  const stateFile = join(outDir, '.pixivdl', 'state.jsonl');
  const failedFile = join(outDir, '.pixivdl', 'failed.jsonl');
  const done = new Map();
  if (existsSync(stateFile)) {
    for (const line of readFileSync(stateFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const it = JSON.parse(line);
        done.set(String(it.pid), it);
      } catch {
        /* ignore */
      }
    }
  }
  const failed = [];
  if (existsSync(failedFile)) {
    for (const line of readFileSync(failedFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        failed.push(JSON.parse(line));
      } catch {
        /* ignore */
      }
    }
  }
  return { done, failed };
}

async function enumerate(token) {
  const headers = {
    'User-Agent': APP_UA,
    'App-OS': 'ios',
    'App-OS-Version': '16.7.2',
    'App-Version': '5.0.234',
    Referer: 'https://app-api.pixiv.net/',
    Authorization: `Bearer ${token}`,
  };
  const works = new Map();
  let offset = 0;
  let pages = 0;
  for (;;) {
    const q = new URLSearchParams({
      word: opt.tag,
      search_target: 'partial_match_for_tags',
      sort: 'date_desc',
      start_date: opt.since,
      end_date: opt.until,
      offset: String(offset),
    });
    const r = await fetch(`https://app-api.pixiv.net/v1/search/illust?${q}`, { headers });
    if (r.status !== 200) throw new Error(`搜索 HTTP ${r.status}`);
    const j = await r.json();
    for (const w of j.illusts ?? []) {
      works.set(String(w.id), {
        id: String(w.id),
        bookmarks: Number(w.total_bookmarks ?? 0),
        xr: Number(w.x_restrict ?? 0),
        type: w.type,
        artist: w.user?.name ?? '',
        date: w.create_date,
      });
    }
    pages++;
    offset += 30;
    if (!j.next_url) break;
    if (offset >= 4500) throw new Error('区间超过 offset 上限，无法单窗口枚举（请缩小范围）');
    await sleep(opt.delay);
  }
  return { works, pages };
}

async function webTotal() {
  const q = encodeURIComponent(opt.tag);
  const url = `https://www.pixiv.net/ajax/search/artworks/${q}?word=${q}&type=all&order=date_d&mode=all&s_mode=s_tag&scd=${opt.since}&ecd=${opt.until}&p=1&lang=zh`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: 'https://www.pixiv.net/',
    },
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, total: j?.body?.illustManga?.total ?? null };
}

function summarize({ works, done, failed, web }) {
  const enumIds = new Set(works.keys());
  const doneIds = new Set(done.keys());
  const missing = [...enumIds].filter((id) => !doneIds.has(id)).map((id) => works.get(id));
  const extra = [...doneIds].filter((id) => !enumIds.has(id));
  const r18Enum = [...works.values()].filter((w) => w.xr > 0);
  const r18Done = r18Enum.filter((w) => doneIds.has(w.id));
  const gt100Enum = [...works.values()].filter((w) => w.bookmarks > 100);
  const gt100Done = gt100Enum.filter((w) => doneIds.has(w.id));
  const safeEnum = [...works.values()].filter((w) => w.xr === 0);
  const safeDone = safeEnum.filter((w) => doneIds.has(w.id));
  const fileCount = [...done.values()].reduce((n, it) => n + (Array.isArray(it.files) ? it.files.length : 0), 0);
  return {
    range: { tag: opt.tag, since: opt.since, until: opt.until },
    expected: {
      appApiTotal: works.size,
      r18: r18Enum.length,
      bookmarksGt100: gt100Enum.length,
      safeOnly: safeEnum.length,
      webTotalAnonymous: web.total,
    },
    downloaded: {
      works: doneIds.size,
      files: fileCount,
      r18: r18Done.length,
      bookmarksGt100: gt100Done.length,
      safeOnly: safeDone.length,
      failedEntries: failed.length,
    },
    missing,
    missingCount: missing.length,
    extra,
    extraCount: extra.length,
    verdict: {
      equalsAppApi: missing.length === 0 && extra.length === 0,
      r18Complete: r18Done.length === r18Enum.length,
      gt100Complete: gt100Done.length === gt100Enum.length,
      safeMatchesWeb: web.total != null ? safeDone.length === web.total : null,
    },
  };
}

(async () => {
  const token = await getToken();
  const { done, failed } = readState(opt.out);
  const { works, pages } = await enumerate(token);
  const web = await webTotal();
  const report = summarize({ works, done, failed, web });
  report.enumeratePages = pages;
  if (opt.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log('区间校验报告');
  console.log(`标签: ${report.range.tag} | 区间: ${report.range.since} ~ ${report.range.until} | 枚举页数: ${pages}`);
  console.log(`App API 可见: ${report.expected.appApiTotal} 条（R-18 ${report.expected.r18}，收藏>100 ${report.expected.bookmarksGt100}，安全口径 ${report.expected.safeOnly}）`);
  console.log(`Web 匿名 total: ${report.expected.webTotalAnonymous ?? 'N/A'}`);
  console.log(`已下载: ${report.downloaded.works} 个作品 / ${report.downloaded.files} 个文件（R-18 ${report.downloaded.r18}，收藏>100 ${report.downloaded.bookmarksGt100}，失败记录 ${report.downloaded.failedEntries}）`);
  console.log(`缺失: ${report.missingCount} 个 | 多余（不在枚举内）: ${report.extraCount} 个`);
  if (report.missingCount > 0) {
    console.log('\n缺失清单（最多 20 条）：');
    for (const w of report.missing.slice(0, 20)) {
      console.log(`  ${w.id}  ${w.artist}  收藏=${w.bookmarks}  x_restrict=${w.xr}  ${w.date}`);
    }
  }
  console.log('\n判定：');
  console.log(`  App API 数量一致: ${report.verdict.equalsAppApi}`);
  console.log(`  R-18 完整: ${report.verdict.r18Complete}`);
  console.log(`  收藏>100 完整: ${report.verdict.gt100Complete}`);
  console.log(`  安全作品与 Web total 一致: ${report.verdict.safeMatchesWeb}`);
})();

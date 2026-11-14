#!/usr/bin/env node
/**
 * 覆盖实验脚本（coverage-lab）：验证「单日 >5000 条」时的可枚举范围
 * ------------------------------------------------------------------
 * 目的：用真实账号回答两个问题
 *   1) App API 单日窗口在 offset≈5000 处是否真的截断；
 *   2) 对同一天再做一次 sort=date_asc（从旧到新，各取 5000），
 *      desc/asc 并集能否覆盖单日 ≤10000 条的作品；
 *   3) Web Ajax 的 total（scd/ecd 精确日期）与 App API 枚举数差多少；
 *      匿名 Web 深翻页是否真的被钳制在 ~10 页（600 条）。
 *
 * 用法（先运行 scripts/login.mjs 保存 token）：
 *   set HTTPS_PROXY=http://127.0.0.1:10090
 *   set HTTP_PROXY=http://127.0.0.1:10090
 *   set NODE_USE_ENV_PROXY=1
 *   node scripts/coverage-lab.mjs --tag オリジナル --day 2025-01-01
 *
 * 常用参数：
 *   --tag <tag>        必填，标签
 *   --day <YYYY-MM-DD> 必填，单日窗口
 *   --delay <ms>       API 间隔，默认 600
 *   --max-pages <n>    每个方向最多页数，默认 200（覆盖 6000 条）
 *   --cookie <PHPSESSID>  可选，登录态 Web 搜索（验证 R-18/深翻页是否放宽）
 *   --web-only         只测 Web（不需要账号）
 *   --web-pages <n>    Web 采样页数，默认 13（用于观察钳制点）
 *   --json             输出 JSON
 *
 * 输出：逐项计数 + 结论；不下载、不写状态。
 */

import process from 'node:process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UA_APP = 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)';
const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
const HASH_SECRET = '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const argv = process.argv.slice(2);
const opt = {
  tag: null,
  day: null,
  delay: 600,
  maxPages: 200,
  cookie: null,
  webOnly: false,
  webPages: 13,
  json: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--tag') opt.tag = argv[++i];
  else if (a === '--day') opt.day = argv[++i];
  else if (a === '--delay') opt.delay = Number(argv[++i]);
  else if (a === '--max-pages') opt.maxPages = Number(argv[++i]);
  else if (a === '--cookie') opt.cookie = argv[++i];
  else if (a === '--web-only') opt.webOnly = true;
  else if (a === '--web-pages') opt.webPages = Number(argv[++i]);
  else if (a === '--json') opt.json = true;
  else if (a === '--help' || a === '-h') {
    console.log('用法: node scripts/coverage-lab.mjs --tag <tag> --day YYYY-MM-DD [--cookie PHPSESSID] [--web-only] [--web-pages 13] [--delay 600] [--json]');
    process.exit(0);
  }
}
if (!opt.tag || !opt.day || !DAY_RE.test(opt.day)) {
  console.error('需要 --tag 与 --day YYYY-MM-DD（例如 --tag オリジナル --day 2025-01-01）');
  process.exit(2);
}

const log = (...a) => {
  if (!opt.json) console.log(...a);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => createHash('md5').update(s).digest('hex');

async function fetchJson(url, headers, timeout = 30000, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...init, headers, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// App API
// ---------------------------------------------------------------------------

function loadRefreshToken() {
  if (process.env.PIXIV_REFRESH_TOKEN?.trim()) return process.env.PIXIV_REFRESH_TOKEN.trim();
  const f = fileURLToPath(new URL('../.secrets/pixiv-refresh-token.txt', import.meta.url));
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  return null;
}

async function getAccessToken() {
  const refresh = loadRefreshToken();
  if (!refresh) throw new Error('未找到 refresh_token：先运行 node scripts/login.mjs --open');
  const time = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const body = new URLSearchParams({
    get_secure_url: '1',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refresh,
  });
  const r = await fetchJson(
    'https://oauth.secure.pixiv.net/auth/token',
    {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA_APP,
      'App-OS': 'ios',
      'App-OS-Version': '16.7.2',
      'X-Client-Time': time,
      'X-Client-Hash': md5(time + HASH_SECRET),
    },
    30000,
    { method: 'POST', body },
  );
  if (r.status !== 200 || !r.json?.response?.access_token) {
    throw new Error(`token 刷新失败 HTTP ${r.status} ${JSON.stringify(r.json?.error ?? r.json).slice(0, 160)}`);
  }
  return { token: r.json.response.access_token, user: r.json.response.user };
}

async function enumerateDay({ token, sort, word, day, maxPages, delay }) {
  const ids = new Set();
  let offset = 0;
  let pages = 0;
  let firstDate = null;
  let lastDate = null;
  let reachedCap = false;
  let retries429 = 0;
  for (;;) {
    const url =
      'https://app-api.pixiv.net/v1/search/illust?' +
      new URLSearchParams({
        word,
        search_target: 'partial_match_for_tags',
        sort,
        filter: 'for_ios',
        start_date: day,
        end_date: day,
        offset: String(offset),
      }).toString();
    const r = await fetchJson(url, {
      'User-Agent': UA_APP,
      'App-OS': 'ios',
      'App-OS-Version': '16.7.2',
      Authorization: `Bearer ${token}`,
      Referer: 'https://app-api.pixiv.net/',
    });
    if (r.status === 429) {
      retries429++;
      log(`  ! ${sort} offset=${offset} 触发 429 限流，冷却 65s 后重试（第 ${retries429} 次）`);
      if (retries429 > 3) {
        log('  ! 429 重试超过 3 次，放弃该方向');
        break;
      }
      await sleep(65000);
      continue;
    }
    if (r.status !== 200) {
      log(`  ! ${sort} offset=${offset} HTTP ${r.status} ${JSON.stringify(r.json?.error ?? r.json).slice(0, 120)}`);
      break;
    }
    const list = r.json?.illusts ?? [];
    for (const w of list) {
      ids.add(String(w.id));
      if (!firstDate) firstDate = w.create_date;
      lastDate = w.create_date;
    }
    pages++;
    offset += 30;
    if (!r.json?.next_url) break;
    if (offset >= 5000) {
      reachedCap = true;
      break;
    }
    if (pages >= maxPages) break;
    await sleep(delay);
  }
  return { ids, pages, reachedCap, retries429, firstDate, lastDate };
}

// ---------------------------------------------------------------------------
// Web Ajax
// ---------------------------------------------------------------------------

async function webSearchTotal({ word, day, cookie }) {
  const q = encodeURIComponent(word);
  const url = `https://www.pixiv.net/ajax/search/artworks/${q}?word=${q}&type=all&order=date_d&mode=all&s_mode=s_tag&scd=${day}&ecd=${day}&p=1&lang=zh`;
  const headers = {
    'User-Agent': UA_WEB,
    Accept: 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: 'https://www.pixiv.net/',
  };
  if (cookie) headers.Cookie = `PHPSESSID=${cookie}`;
  const r = await fetchJson(url, headers);
  return { status: r.status, total: r.json?.body?.illustManga?.total ?? null };
}

async function webPagingProbe({ word, day, cookie, pages }) {
  const q = encodeURIComponent(word);
  const uniq = new Set();
  const pageSigs = [];
  for (let p = 1; p <= pages; p++) {
    const url = `https://www.pixiv.net/ajax/search/artworks/${q}?word=${q}&type=all&order=date_d&mode=all&s_mode=s_tag&scd=${day}&ecd=${day}&p=${p}&lang=zh`;
    const headers = {
      'User-Agent': UA_WEB,
      Accept: 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: 'https://www.pixiv.net/',
    };
    if (cookie) headers.Cookie = `PHPSESSID=${cookie}`;
    const r = await fetchJson(url, headers);
    const d = r.json?.body?.illustManga?.data ?? [];
    const sig = d.map((x) => x.id).join(',');
    pageSigs.push(sig);
    for (const x of d) uniq.add(String(x.id));
    await sleep(250);
  }
  // 检测钳制：某页与之前某页内容完全相同
  const clampAt = pageSigs.findIndex((sig, i) => i > 0 && sig && pageSigs[i - 1] && sig === pageSigs[i - 1]);
  return { unique: uniq.size, pages: pageSigs.filter(Boolean).length, clampAt: clampAt >= 0 ? clampAt + 1 : null };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const out = {
  tag: opt.tag,
  day: opt.day,
  generated_at: new Date().toISOString(),
  proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null,
};

log(`覆盖实验：tag=${opt.tag} day=${opt.day} web-only=${opt.webOnly}`);

try {
  out.web = await webSearchTotal({ word: opt.tag, day: opt.day, cookie: opt.cookie });
  log(`Web total（匿名${opt.cookie ? '+cookie' : ''}）：${out.web.total ?? `HTTP ${out.web.status}`}`);
  out.webPaging = await webPagingProbe({ word: opt.tag, day: opt.day, cookie: opt.cookie, pages: opt.webPages });
  log(`Web 翻页采样：${out.webPaging.pages} 页内 unique=${out.webPaging.unique}，钳制发生在第 ${out.webPaging.clampAt ?? '未出现'} 页`);

  if (!opt.webOnly) {
    const { token, user } = await getAccessToken();
    out.user = { id: user?.id, name: user?.name, is_premium: user?.is_premium };
    log(`账号：${user?.name ?? '?'} (premium=${user?.is_premium ?? '?'})`);

    const desc = await enumerateDay({ token, sort: 'date_desc', word: opt.tag, day: opt.day, maxPages: opt.maxPages, delay: opt.delay });
    log(`desc：${desc.pages} 页，unique=${desc.ids.size}，触顶=${desc.reachedCap}`);
    const ascNeeded = desc.reachedCap || desc.ids.size >= 4980;
    let asc = { ids: new Set(), pages: 0, reachedCap: false };
    if (ascNeeded) {
      asc = await enumerateDay({ token, sort: 'date_asc', word: opt.tag, day: opt.day, maxPages: opt.maxPages, delay: opt.delay });
      log(`asc ：${asc.pages} 页，unique=${asc.ids.size}，触顶=${asc.reachedCap}`);
    } else {
      log('asc ：跳过了（desc 未触顶，本身已完整）');
    }
    const union = new Set([...desc.ids, ...asc.ids]);
    const overlap = desc.ids.size + asc.ids.size - union.size;
    out.desc = { pages: desc.pages, unique: desc.ids.size, reachedCap: desc.reachedCap, retries429: desc.retries429, firstDate: desc.firstDate, lastDate: desc.lastDate };
    out.asc = { pages: asc.pages, unique: asc.ids.size, reachedCap: asc.reachedCap, retries429: asc.retries429 };
    out.union = { unique: union.size, overlap };
    log(`并集：${union.size} 条（重叠 ${overlap}）`);

    // 结论推断
    const webTotal = out.web.total;
    if (webTotal != null) {
      const coverage = union.size / webTotal;
      out.verdict = {
        web_total: webTotal,
        union_unique: union.size,
        ratio: Number(coverage.toFixed(4)),
        note:
          union.size >= webTotal
            ? '并集 ≥ Web total（Web total 为匿名下界，实际可能更高）'
            : union.size < webTotal
              ? '并集 < Web total：存在缺口（可能因 R-18/索引差异，或双向枚举仍不足）'
              : '',
      };
      log(`覆盖推断：并集 ${union.size} / Web total ${webTotal} = ${(coverage * 100).toFixed(2)}%`);
    }
  }
} catch (e) {
  console.error(`✗ 失败：${e.message}`);
  if (!opt.json) {
    console.error('  常见原因：未登录/代理未生效（需要 --use-env-proxy）/ 当日无作品 / 触发限流（增大 --delay）。');
  }
  process.exitCode = 1;
}

if (opt.json) console.log(JSON.stringify(out, null, 2));
else console.log('\n完成。');

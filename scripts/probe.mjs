#!/usr/bin/env node
/**
 * Pixiv 可行性探针
 * ------------------------------------------------------------------
 * 用于在用户本机（需已配置 HTTP 代理）验证本条技术路线所需的关键能力：
 *   - 四个域名（www / app-api / oauth / i.pximg）是否可达
 *   - 匿名 Web Ajax 路线能拿到什么、缺什么
 *   - OAuth 客户端凭据是否仍被 Pixiv 接受
 *   - 可选：携带 refresh_token 验证 app-api 搜索/收藏数/分页/限流
 *   - 可选：动图(ugoira)元数据与 zip 下载
 *
 * 零依赖，只用 Node.js 内置模块，要求 Node >= 24（需要 --use-env-proxy 或
 * NODE_USE_ENV_PROXY=1 才能让内置 fetch 走 HTTP 代理）。
 *
 * 用法：
 *   set HTTPS_PROXY=http://127.0.0.1:10090
 *   set HTTP_PROXY=http://127.0.0.1:10090
 *   node --use-env-proxy scripts/probe.mjs --tag 初音ミク
 *
 * 带登录态（先通过 `node scripts/probe.mjs --login` 拿到 refresh_token，或手动提供）：
 *   set PIXIV_REFRESH_TOKEN=xxxx
 *   node --use-env-proxy scripts/probe.mjs --tag 初音ミク --rate-test
 *
 * 退出码：0 = 关键检查全部通过；1 = 有 FAIL 项。
 */

import process from 'node:process';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// www.pixiv.net 前面的 Cloudflare 会按请求头判定爬虫：只给 UA 会被 302/403，
// 需补齐浏览器常见的 Accept / Accept-Language / Sec-Fetch-* 头。
const H_WEB = {
  'User-Agent': UA_WEB,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Sec-Fetch-Dest': 'document',
  'Upgrade-Insecure-Requests': '1',
};
const UA_APP = 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)';
const HASH_SECRET = '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c';
const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
const REDIRECT_URI = 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback';
const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// 极简参数解析
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const opt = { tag: '初音ミク', json: false, rateTest: false, ugoira: true };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--tag') opt.tag = argv[++i];
  else if (a === '--json') opt.json = true;
  else if (a === '--rate-test') opt.rateTest = true;
  else if (a === '--no-ugoira') opt.ugoira = false;
  else if (a === '--help' || a === '-h') {
    console.log('用法: node --use-env-proxy scripts/probe.mjs [--tag 标签] [--json] [--rate-test] [--no-ugoira]');
    console.log('可选环境变量: HTTPS_PROXY / HTTP_PROXY（必须配合 --use-env-proxy 或 NODE_USE_ENV_PROXY=1）');
    console.log('             PIXIV_REFRESH_TOKEN（有则测试 app-api 登录态能力）');
    process.exit(0);
  }
}

const results = [];
const record = (group, name, status, evidence) => {
  const item = { group, name, status, evidence };
  results.push(item);
  if (!opt.json) {
    const mark = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN', SKIP: 'SKIP' }[status] ?? status;
    console.log(`  [${mark}] ${name}${evidence ? `  — ${evidence}` : ''}`);
  }
  return status === 'PASS';
};

const section = (title) => {
  if (!opt.json) console.log(`\n== ${title} ==`);
};

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------

const proxyOf = () => process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || '';

async function request(url, { method = 'GET', headers = {}, body, redirect = 'manual', timeout = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { method, headers, body, redirect, signal: ctrl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buf };
  } finally {
    clearTimeout(timer);
  }
}

const jsonOf = (r) => {
  try { return JSON.parse(r.buf.toString('utf8')); } catch { return null; }
};

const md5 = async (s) => {
  const { createHash } = await import('node:crypto');
  return createHash('md5').update(s).digest('hex');
};

// ---------------------------------------------------------------------------
// 1. 网络连通性
// ---------------------------------------------------------------------------

async function checkNetwork() {
  section('1. 网络连通性（经本机代理）');

  const via = proxyOf();
  if (!via) {
    record('network', '检测到代理环境变量', 'FAIL', '未设置 HTTPS_PROXY/HTTP_PROXY；内置 fetch 将直连（本机直连 Pixiv 不通）');
    return false;
  }
  const flagOk = process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy');
  record('network', '代理地址', flagOk ? 'PASS' : 'WARN', `${via}${flagOk ? '' : '（注意：未启用 --use-env-proxy，请求可能不走代理）'}`);

  try {
    const r = await request('https://www.pixiv.net/', { headers: H_WEB, redirect: 'follow' });
    record('network', 'www.pixiv.net 首页', r.status === 200 ? 'PASS' : 'FAIL', `HTTP ${r.status}, server=${r.headers.get('server') ?? '?'}, ${r.buf.length} bytes`);
    if (r.status !== 200) return false;
  } catch (e) {
    record('network', 'www.pixiv.net 首页', 'FAIL', `请求失败: ${e.cause?.message ?? e.message}`);
    return false;
  }

  // app-api 无 token：预期 400 OAuth 错误，而不是连接失败，也不是 403
  try {
    const r = await request(
      'https://app-api.pixiv.net/v1/search/illust?word=test&search_target=partial_match_for_tags&sort=date_desc&filter=for_ios',
      { headers: { 'User-Agent': UA_APP, 'App-OS': 'ios', 'App-OS-Version': '16.7.2', 'Referer': 'https://app-api.pixiv.net/' } },
    );
    const j = jsonOf(r);
    const ok = r.status === 400 && j?.error && /OAuth/i.test(JSON.stringify(j));
    record('network', 'app-api.pixiv.net 存活', ok ? 'PASS' : 'WARN', `HTTP ${r.status}${j?.error ? `, error=${JSON.stringify(j.error?.message ?? j.error).slice(0, 80)}` : ''}`);
  } catch (e) {
    record('network', 'app-api.pixiv.net 存活', 'FAIL', `请求失败: ${e.cause?.message ?? e.message}`);
  }

  // oauth 端点 + 客户端凭据：预期 invalid_grant（token 无效），而不是无效客户端
  try {
    const time = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const xClientHash = await md5(time + HASH_SECRET);
    const body = new URLSearchParams({
      get_secure_url: '1',
      client_id: opt.clientId ?? CLIENT_ID,
      client_secret: opt.clientSecret ?? CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: 'probe_invalid_token',
    });
    const r = await request('https://oauth.secure.pixiv.net/auth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA_APP,
        'App-OS': 'ios',
        'App-OS-Version': '16.7.2',
        'X-Client-Time': time,
        'X-Client-Hash': xClientHash,
      },
      body,
    });
    const j = jsonOf(r);
    const err = j?.error ?? '';
    const ok = r.status === 400 && err === 'invalid_grant';
    record(
      'network',
      'oauth.secure.pixiv.net 客户端凭据',
      ok ? 'PASS' : 'WARN',
      ok ? '客户端 ID/Secret 仍被接受（返回 invalid_grant = token 无效，属预期）' : `HTTP ${r.status}, error=${err || String(j).slice(0, 100)}`,
    );
  } catch (e) {
    record('network', 'oauth.secure.pixiv.net 客户端凭据', 'FAIL', `请求失败: ${e.cause?.message ?? e.message}`);
  }

  // 图片 CDN
  const imgUrl = 'https://i.pximg.net/img-original/img/2022/08/11/23/46/14/100412238_p0.png';
  try {
    const r = await request(imgUrl, { method: 'HEAD', headers: { 'User-Agent': UA_WEB, Accept: 'application/json', 'Accept-Language': 'zh-CN,zh;q=0.9', Referer: 'https://www.pixiv.net/' } });
    record('network', 'i.pximg.net 带 Referer', r.status === 200 ? 'PASS' : 'FAIL', `HTTP ${r.status}, ${r.headers.get('content-type')}, ${r.headers.get('content-length')} bytes`);
  } catch (e) {
    record('network', 'i.pximg.net 带 Referer', 'FAIL', `请求失败: ${e.cause?.message ?? e.message}`);
  }
  try {
    const r = await request(imgUrl, { method: 'HEAD', headers: { 'User-Agent': UA_WEB } });
    record('network', 'i.pximg.net 不带 Referer', r.status === 403 ? 'PASS' : 'WARN', `HTTP ${r.status}（403 说明必须伪造 Referer，符合预期）`);
  } catch (e) {
    record('network', 'i.pximg.net 不带 Referer', 'WARN', `请求失败: ${e.cause?.message ?? e.message}`);
  }

  return true;
}

// ---------------------------------------------------------------------------
// 2. 匿名 Web Ajax 能力
// ---------------------------------------------------------------------------

async function checkAnonymous() {
  section('2. 匿名 Web Ajax 路线（无需登录）');
  const q = encodeURIComponent(opt.tag);
  const H = { ...H_WEB, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'empty', Referer: 'https://www.pixiv.net/' };

  // 搜索列表
  let firstId;
  try {
    const r = await request(
      `https://www.pixiv.net/ajax/search/artworks/${q}?word=${q}&type=all&order=date_d&mode=all&s_mode=s_tag&p=1&lang=zh`,
      { headers: H },
    );
    const j = jsonOf(r);
    const data = j?.body?.illustManga?.data ?? [];
    const total = j?.body?.illustManga?.total;
    firstId = data[0]?.id;
    record(
      'anonymous',
      '标签搜索（列表）',
      data.length > 0 ? 'PASS' : 'FAIL',
      `HTTP ${r.status}, 本页 ${data.length} 条, 标签总数 ${total ?? '?'}`,
    );
    if (data[0]) {
      const hasBookmark = 'bookmarkCount' in data[0] || 'total_bookmarks' in data[0];
      record(
        'anonymous',
        '列表是否带收藏数',
        hasBookmark ? 'PASS' : 'WARN',
        hasBookmark ? '列表直接包含收藏数' : '列表不含收藏数 → 匿名路线必须逐作品额外详情请求（本路线的一大劣势）',
      );
    }
  } catch (e) {
    record('anonymous', '标签搜索（列表）', 'FAIL', `请求失败: ${e.cause?.message ?? e.message}`);
  }

  // 作品详情（收藏数、画师、原图）
  if (firstId) {
    try {
      const r = await request(`https://www.pixiv.net/ajax/illust/${firstId}?lang=zh`, { headers: H });
      const b = jsonOf(r)?.body;
      const ok = !!b && Number.isFinite(b.bookmarkCount) && b.userName;
      record(
        'anonymous',
        '作品详情字段',
        ok ? 'PASS' : 'FAIL',
        ok ? `id=${b.id}, 收藏=${b.bookmarkCount}, 画师=${b.userName}, userId=${b.userId}, urls.original=${b.urls?.original ? '有' : 'null（需 pages 接口补）'}` : `HTTP ${r.status}`,
      );
    } catch (e) {
      record('anonymous', '作品详情字段', 'FAIL', `请求失败: ${e.cause?.message ?? e.message}`);
    }

    try {
      const r = await request(`https://www.pixiv.net/ajax/illust/${firstId}/pages?lang=zh`, { headers: H });
      const body = jsonOf(r)?.body ?? [];
      const ok = body.length > 0 && body[0]?.urls?.original;
      record('anonymous', '多页原图 URL（pages 接口）', ok ? 'PASS' : 'WARN', ok ? `页数 ${body.length}, 首图 ${String(body[0].urls.original).slice(0, 70)}…` : `HTTP ${r.status}`);
    } catch (e) {
      record('anonymous', '多页原图 URL（pages 接口）', 'WARN', `请求失败: ${e.cause?.message ?? e.message}`);
    }
  }

  // 深分页（匿名 Web 搜索是否也受 5000 offset 限制）
  try {
    const p = 100; // 60 条/页 → offset 约 5940
    const r = await request(
      `https://www.pixiv.net/ajax/search/artworks/${q}?word=${q}&type=all&order=date_d&mode=all&s_mode=s_tag&p=${p}&lang=zh`,
      { headers: H },
    );
    const data = jsonOf(r)?.body?.illustManga?.data ?? [];
    record('anonymous', `深分页 p=${p}`, data.length > 0 ? 'PASS' : 'WARN', `HTTP ${r.status}, 本页 ${data.length} 条`);
  } catch (e) {
    record('anonymous', `深分页`, 'WARN', `请求失败: ${e.cause?.message ?? e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 3. 动图 ugoira
// ---------------------------------------------------------------------------

async function checkUgoira() {
  if (!opt.ugoira) return;
  section('3. 动图 ugoira');
  try {
    const r = await request('https://www.pixiv.net/ranking.php?format=json&mode=weekly&content=ugoira&p=1', {
      headers: { 'User-Agent': UA_WEB, Accept: 'application/json', 'Accept-Language': 'zh-CN,zh;q=0.9', Referer: 'https://www.pixiv.net/' },
    });
    const j = jsonOf(r);
    const item = j?.contents?.[0];
    if (!item) {
      record('ugoira', '取一个 ugoira 作品 ID', 'SKIP', `ranking HTTP ${r.status}，无内容`);
      return;
    }
    record('ugoira', '取一个 ugoira 作品 ID', 'PASS', `id=${item.illust_id}, ${item.title}`);
    const m = await request(`https://www.pixiv.net/ajax/illust/${item.illust_id}/ugoira_meta?lang=zh`, {
      headers: { 'User-Agent': UA_WEB, Accept: 'application/json', 'Accept-Language': 'zh-CN,zh;q=0.9', Referer: 'https://www.pixiv.net/' },
    });
    const b = jsonOf(m)?.body;
    const ok = !!b?.originalSrc && Array.isArray(b.frames) && b.frames.length > 0;
    record('ugoira', 'ugoira_meta（帧延迟 + zip URL）', ok ? 'PASS' : 'FAIL', ok ? `${b.frames.length} 帧, zip=${String(b.originalSrc).slice(-28)}` : `HTTP ${m.status}`);
    if (ok) {
      const z = await request(b.originalSrc, { method: 'HEAD', headers: { 'User-Agent': UA_WEB, Accept: 'application/json', 'Accept-Language': 'zh-CN,zh;q=0.9', Referer: 'https://www.pixiv.net/' } });
      record('ugoira', 'ugoira zip 可下载', z.status === 200 ? 'PASS' : 'FAIL', `HTTP ${z.status}, ${z.headers.get('content-type')}, ${z.headers.get('content-length')} bytes`);
    }
  } catch (e) {
    record('ugoira', 'ugoira 检查', 'WARN', `请求失败: ${e.cause?.message ?? e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 4. 登录态 app-api 能力（需要 refresh_token）
// ---------------------------------------------------------------------------

async function checkAuthenticated() {
  section('4. 登录态 app-api 能力');
  let refreshToken = process.env.PIXIV_REFRESH_TOKEN?.trim();
  if (!refreshToken) {
    // 回退：读取 scripts/login.mjs 保存的本地 token（token 不落仓库仓库外，仅本机）
    try {
      const { readFileSync, existsSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const file = fileURLToPath(new URL('../.secrets/pixiv-refresh-token.txt', import.meta.url));
      if (existsSync(file)) refreshToken = readFileSync(file, 'utf8').trim();
    } catch {
      /* ignore */
    }
  }
  if (!refreshToken) {
    record('auth', 'refresh_token', 'SKIP', '未提供 PIXIV_REFRESH_TOKEN（或 .secrets/pixiv-refresh-token.txt）；登录态能力（搜索收藏数、分页上限、限流阈值）未验证');
    return;
  }

  // 4.1 换 access_token
  let accessToken;
  try {
    const time = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const body = new URLSearchParams({
      get_secure_url: '1',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const r = await request('https://oauth.secure.pixiv.net/auth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA_APP,
        'App-OS': 'ios',
        'App-OS-Version': '16.7.2',
        'X-Client-Time': time,
        'X-Client-Hash': await md5(time + HASH_SECRET),
      },
      body,
    });
    const j = jsonOf(r);
    accessToken = j?.response?.access_token;
    if (accessToken) {
      const premium = j.response?.user?.is_premium;
      record('auth', 'refresh_token → access_token', 'PASS', `user=${j.response.user?.name ?? '?'}, premium=${premium}`);
      opt.premium = premium;
    } else {
      record('auth', 'refresh_token → access_token', 'FAIL', `HTTP ${r.status}, ${JSON.stringify(j?.error ?? j).slice(0, 120)}（token 可能过期，需重新登录）`);
      return;
    }
  } catch (e) {
    record('auth', 'refresh_token → access_token', 'FAIL', `请求失败: ${e.cause?.message ?? e.message}`);
    return;
  }

  const api = async (path, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`https://app-api.pixiv.net${path}${qs ? `?${qs}` : ''}`, {
      headers: {
        'User-Agent': UA_APP,
        'App-OS': 'ios',
        'App-OS-Version': '16.7.2',
        Authorization: `Bearer ${accessToken}`,
        Referer: 'https://app-api.pixiv.net/',
      },
    });
  };

  // 4.2 标签搜索 + 收藏数字段
  let baseline;
  try {
    const r = await api('/v1/search/illust', {
      word: opt.tag,
      search_target: 'partial_match_for_tags',
      sort: 'date_desc',
      filter: 'for_ios',
    });
    const j = jsonOf(r);
    const list = j?.illusts ?? [];
    baseline = list;
    const hasBm = list[0] && 'total_bookmarks' in list[0];
    record('auth', '标签搜索', r.status === 200 && list.length > 0 ? 'PASS' : 'FAIL', `HTTP ${r.status}, ${list.length} 条/页, next_url=${j?.next_url ? '有' : '无'}`);
    record('auth', '搜索结果内含收藏数', hasBm ? 'PASS' : 'FAIL', hasBm ? `首条 total_bookmarks=${list[0].total_bookmarks}` : '缺少 total_bookmarks，无法本地过滤');
    if (list[0]) {
      const u = list[0].user ?? {};
      record('auth', '结果含画师与多页 URL', u.name ? 'PASS' : 'WARN', `画师=${u.name}(${u.account}), type=${list[0].type}, page_count=${list[0].page_count}, meta_pages=${(list[0].meta_pages ?? []).length}`);
    }
  } catch (e) {
    record('auth', '标签搜索', 'FAIL', `请求失败: ${e.cause?.message ?? e.message}`);
  }

  // 4.3 服务端收藏数过滤参数是否生效（不保证存在，属探针项）
  if (baseline?.length) {
    try {
      const withParam = { word: opt.tag, search_target: 'partial_match_for_tags', sort: 'date_desc', filter: 'for_ios', bookmark_num_min: '5000' };
      const r = await api('/v1/search/illust', withParam);
      const j = jsonOf(r);
      const list = j?.illusts ?? [];
      const looksFiltered = list.length > 0 && list.every((w) => (w.total_bookmarks ?? 0) >= 5000);
      record(
        'auth',
        '服务端参数 bookmark_num_min',
        r.status === 200 ? (looksFiltered ? 'PASS' : 'WARN') : 'WARN',
        r.status !== 200
          ? `HTTP ${r.status}（参数可能不被支持；注意该参数通常仅 Premium 生效）`
          : looksFiltered
            ? `生效：${list.length} 条全部 ≥5000 收藏`
            : `返回 ${list.length} 条，但未按收藏数过滤（非 Premium 或该接口行为变化；本地过滤才是正确性来源）`,
      );
    } catch (e) {
      record('auth', '服务端参数 bookmark_num_min', 'WARN', `请求失败: ${e.cause?.message ?? e.message}`);
    }
  }

  // 4.4 Premium 热门排序（若账号为 premium，可用 popular_desc 提前止损）
  if (opt.premium) {
    try {
      const r = await api('/v1/search/illust', {
        word: opt.tag,
        search_target: 'partial_match_for_tags',
        sort: 'popular_desc',
        filter: 'for_ios',
        duration: 'within_last_month',
      });
      const j = jsonOf(r);
      const list = j?.illusts ?? [];
      const desc = list.length > 1 && list.every((w, i) => i === 0 || (list[i - 1].total_bookmarks ?? 0) >= (w.total_bookmarks ?? 0));
      record('auth', 'popular_desc 热门排序', r.status === 200 && desc ? 'PASS' : 'WARN', r.status !== 200 ? `HTTP ${r.status}（可能仅限 premium 或参数不适用）` : `${list.length} 条, 收藏数${desc ? '递减' : '非递减'}（首条 ${list[0]?.total_bookmarks}）`);
    } catch (e) {
      record('auth', 'popular_desc 热门排序', 'WARN', `请求失败: ${e.cause?.message ?? e.message}`);
    }
  }

  // 4.4 offset 上限（文档/社区称 5000）
  try {
    const r = await api('/v1/search/illust', {
      word: opt.tag,
      search_target: 'partial_match_for_tags',
      sort: 'date_desc',
      filter: 'for_ios',
      offset: '4980',
    });
    const j = jsonOf(r);
    const list = j?.illusts ?? [];
    record('auth', 'offset=4980', r.status === 200 && list.length > 0 ? 'PASS' : 'WARN', `HTTP ${r.status}, ${list.length} 条${j?.next_url ? ', next_url 有' : ', next_url 无'}`);
  } catch (e) {
    record('auth', 'offset=4980', 'WARN', `请求失败: ${e.cause?.message ?? e.message}`);
  }

  // 4.5 offset=5010：确认 5000 是硬上限（预期返回 0 条）
  try {
    const r = await api('/v1/search/illust', {
      word: opt.tag,
      search_target: 'partial_match_for_tags',
      sort: 'date_desc',
      filter: 'for_ios',
      offset: '5010',
    });
    const list = jsonOf(r)?.illusts ?? [];
    record('auth', 'offset=5010（硬上限）', r.status === 200 && list.length === 0 ? 'PASS' : 'WARN', `HTTP ${r.status}, ${list.length} 条（预期 0 条 = 5000 处硬截断）`);
  } catch (e) {
    record('auth', 'offset=5010（硬上限）', 'WARN', `请求失败: ${e.cause?.message ?? e.message}`);
  }

  // 4.5 限流实测（可选）
  if (opt.rateTest) {
    const times = [];
    let statuses = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      try {
        const r = await api('/v1/search/illust', { word: opt.tag, search_target: 'partial_match_for_tags', sort: 'date_desc', filter: 'for_ios' });
        statuses.push(r.status);
      } catch {
        statuses.push('ERR');
      }
      times.push(Date.now() - t0);
    }
    record(
      'auth',
      '连续 5 次请求（无限速）',
      statuses.includes(429) ? 'WARN' : 'PASS',
      `状态=${statuses.join(',')}, 耗时=${times.join('/')}ms`,
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

(async () => {
  const started = Date.now();
  if (!opt.json) {
    console.log('Pixiv 可行性探针');
    console.log(`Node ${process.version} | 代理 ${proxyOf() || '(未设置)'} | 标签「${opt.tag}」| ${new Date().toISOString()}`);
  }

  const networkOk = await checkNetwork();
  if (networkOk) {
    await checkAnonymous();
    await checkUgoira();
    await checkAuthenticated();
  } else {
    if (!opt.json) console.log('\n网络不通，跳过后续检查。请先确认代理已开启，且运行方式包含 --use-env-proxy（或设置 NODE_USE_ENV_PROXY=1）。');
  }

  const fail = results.filter((r) => r.status === 'FAIL');
  const warn = results.filter((r) => r.status === 'WARN');
  if (!opt.json) {
    console.log('\n== 结果 ==');
    console.log(`PASS ${results.filter((r) => r.status === 'PASS').length} / WARN ${warn.length} / FAIL ${fail.length} / SKIP ${results.filter((r) => r.status === 'SKIP').length}`);
    if (fail.length) console.log('FAIL 项：\n' + fail.map((r) => `  - [${r.group}] ${r.name}: ${r.evidence}`).join('\n'));
    console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } else {
    console.log(JSON.stringify({ ok: fail.length === 0, results }, null, 2));
  }
  process.exit(fail.length ? 1 : 0);
})();

#!/usr/bin/env node
/**
 * Pixiv 本地登录（PKCE），获取 refresh_token —— 只在本机运行，token 只落本地。
 *
 * 原理（2026-11 实测可用）：
 *   1. 生成 code_verifier / code_challenge(S256)
 *   2. 打开 https://app-api.pixiv.net/web/v1/login?code_challenge=…&client=pixiv-android
 *   3. 浏览器登录后，Pixiv 会回调
 *      https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback?code=…
 *      （页面打不开是正常的，关键是 URL 里的 code；有效期约 30 秒）
 *   4. 把 code（或整条回调 URL）粘贴到本终端
 *   5. 用 authorization_code + code_verifier 换 refresh_token，保存到 .secrets/
 *
 * 用法（本机代理已配置时）：
 *   set HTTPS_PROXY=http://127.0.0.1:10090
 *   set HTTP_PROXY=http://127.0.0.1:10090
 *   set NODE_USE_ENV_PROXY=1
 *   node scripts/login.mjs
 *
 * 可选参数：
 *   --code <code或回调URL>   跳过浏览器与输入，直接兑换（code 30 秒内有效）
 *   --open                   自动用默认浏览器打开登录页（默认只打印 URL）
 *   --out <path>             token 保存路径，默认 .secrets/pixiv-refresh-token.txt
 *   --print                  额外把 token 打印到 stdout（不建议在共享终端使用）
 *   --check                  只验证已有 token 是否可用，不重新登录
 *
 * 安全提示：refresh_token 等价于账号的“长期登录凭证”，不要提交到 git、不要发给他人。
 */

import process from 'node:process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
const REDIRECT_URI = 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback';
const LOGIN_URL = 'https://app-api.pixiv.net/web/v1/login';
const TOKEN_URL = 'https://oauth.secure.pixiv.net/auth/token';
const UA_APP = 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const opt = {
  code: null,
  open: false,
  out: null, // null = <repo>/.secrets/pixiv-refresh-token.txt（与运行目录无关）
  print: false,
  check: false,
  cookie: null,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--code') opt.code = argv[++i];
  else if (a === '--open') opt.open = true;
  else if (a === '--out') opt.out = argv[++i];
  else if (a === '--print') opt.print = true;
  else if (a === '--check') opt.check = true;
  else if (a === '--cookie') opt.cookie = argv[++i];
  else if (a === '--help' || a === '-h') {
    console.log('用法: node scripts/login.mjs [--open] [--code <code或回调URL>] [--cookie <PHPSESSID或完整Cookie>] [--out <path>] [--print] [--check]');
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const base64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function warnProxy() {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  const flag = process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy');
  if (!proxy) {
    console.warn('⚠ 未检测到 HTTPS_PROXY/HTTP_PROXY。若直连 Pixiv 不通，请先设置代理后再运行。');
  } else if (!flag) {
    console.warn('⚠ 检测到代理变量，但未启用 --use-env-proxy / NODE_USE_ENV_PROXY=1，Node 内置 fetch 不会走代理。');
  }
  return flag;
}

function parseCode(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  // 支持整条回调 URL、以及只有 query 的片段
  const qi = s.indexOf('?');
  if (qi >= 0) {
    try {
      const code = new URLSearchParams(s.slice(qi + 1)).get('code');
      if (code) return code;
    } catch {
      /* ignore */
    }
  }
  // 支持 "code=xxx" 或裸 code
  const m = s.match(/(?:^|[?&])code=([^&\s]+)/);
  if (m) return decodeURIComponent(m[1]);
  return s;
}

function openBrowser(url) {
  try {
    // 注意：Windows 上不能用 cmd.exe /c start —— URL 里的 & 会被 cmd 当作命令分隔符，
    // 导致 URL 在第一个 & 处被截断，Pixiv 会直接返回「不正确的请求。」。
    // explorer.exe 接收单个参数，不做 shell 解析，安全。
    if (process.platform === 'win32') {
      spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

async function readLine(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolveLine) => {
    const { stdin } = process;
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0) {
        stdin.off('data', onData);
        stdin.pause();
        resolveLine(buf.slice(0, i).replace(/\r$/, ''));
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function codeFromCookie(cookieHeader, challenge) {
  const startUrl = `https://app-api.pixiv.net/web/v1/users/auth/pixiv/start?code_challenge=${challenge}&code_challenge_method=S256&client=pixiv-android&via=login`;
  let url = startUrl;
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Cookie: cookieHeader,
      },
    });
    const loc = res.headers.get('location');
    if (!loc) {
      const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 160);
      return { error: `start 请求返回 HTTP ${res.status}，无跳转：${text}` };
    }
    const m = loc.match(/[?&]code=([^&\s]+)/);
    if (m) return { code: decodeURIComponent(m[1]), via: loc };
    if (loc.includes('accounts.pixiv.net/login')) {
      return { error: 'start 跳回了登录页：说明 Cookie 无效/不完整，或浏览器登录的会话未同步' };
    }
    if (loc.startsWith('pixiv://')) {
      return { error: '跳转到 pixiv:// 但没有 code（可能是会话无效）' };
    }
    url = new URL(loc, 'https://app-api.pixiv.net').toString();
  }
  return { error: `跳转链超过 4 层仍未取到 code（最后跳转：${url.slice(0, 120)}）` };
}

async function tokenRequest(data) {
  const t = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const hash = createHash('md5')
    .update(t + '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c')
    .digest('hex');
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    get_secure_url: '1',
    ...data,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA_APP,
      'App-OS': 'ios',
      'App-OS-Version': '16.7.2',
      'X-Client-Time': t,
      'X-Client-Hash': hash,
    },
    body,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const started = Date.now();
console.log('Pixiv 本地登录（PKCE）');
console.log(`Node ${process.version} | 代理 ${process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '(未设置)'}`);
warnProxy();

const outPath = opt.out ? resolve(opt.out) : join(REPO_ROOT, '.secrets', 'pixiv-refresh-token.txt');

// --check：只验证已有 token
if (opt.check) {
  if (!existsSync(outPath)) {
    console.error(`✗ 未找到 token 文件：${outPath}`);
    process.exit(2);
  }
  const token = readFileSync(outPath, 'utf8').trim();
  const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token });
  if (r.status === 200 && r.json?.response?.access_token) {
    const u = r.json.response.user || {};
    console.log(`✓ token 可用：${u.name ?? '?'} (id=${u.id ?? '?'}, premium=${u.is_premium ?? '?'})，耗时 ${Date.now() - started}ms`);
    process.exit(0);
  }
  console.error(`✗ token 不可用：HTTP ${r.status} ${JSON.stringify(r.json?.error ?? r.json).slice(0, 160)}`);
  process.exit(3);
}

// 1) 生成 PKCE 参数
const verifier = base64url(randomBytes(32)); // 43 chars, RFC 7636 要求 43-128
const challenge = base64url(createHash('sha256').update(verifier).digest());
const loginUrl = `${LOGIN_URL}?code_challenge=${challenge}&code_challenge_method=S256&client=pixiv-android`;

// 2) 拿 code（三种方式：--code / --cookie / 浏览器抓包粘贴）
let raw;
if (opt.code) {
  raw = opt.code;
} else if (opt.cookie) {
  console.log('\n尝试用 PHPSESSID 直接换取 code（不需要手动抓包）…');
  const c = await codeFromCookie(opt.cookie, challenge);
  if (c.code) {
    console.log('✓ 已通过 cookie 拿到 code');
    raw = c.code;
  } else {
    console.error(`✗ cookie 方式失败：${c.error}`);
    console.error('  退回手动粘贴方式。');
  }
}
if (!raw) {
  console.log('\n第 1 步：在浏览器完成 Pixiv 登录（已登录会直接复用会话）。');
  console.log('第 2 步：登录前先按 F12 → Network(网络)，勾选「保留日志 / Preserve log」。');
  console.log('第 3 步：点登录后，Pixiv 最后一步会跳转 pixiv://account/login?code=...（唤起 App 的协议）。');
  console.log('        本机没有注册 pixiv:// 处理器时，浏览器会停在 accounts.pixiv.net/post-redirect —— 这是正常的。');
  console.log('        请在 Network 里找到对 app-api.pixiv.net/web/v1/users/auth/pixiv/start 的请求，');
  console.log('        看它的 Response Headers，复制 location 里的 pixiv://account/login?code=...（或其中的 code）。');
  console.log('        找不到 start 请求时：按 F5 刷新当前 post-redirect 页面，再找一次。');
  console.log('        也可以复制 pixiv.net 的 PHPSESSID cookie，改用 --cookie 方式（见 README）。');
  console.log('        注意：code 约 30 秒内有效，且只能用一次。\n');
  console.log('登录地址：');
  console.log(loginUrl + '\n');
  if (opt.open) {
    const ok = openBrowser(loginUrl);
    console.log(ok ? '（已尝试用默认浏览器打开）\n' : '（自动打开失败，请手动复制上面的 URL）\n');
  }
  raw = await readLine('粘贴 pixiv:// 链接 / 回调 URL / code，然后回车：');
}

const code = parseCode(raw);
if (!code) {
  if (String(raw).includes('post-redirect')) {
    console.error('✗ 你粘贴的是 accounts.pixiv.net/post-redirect 中转页地址，它不含 code。');
    console.error('  请在 DevTools → Network 里找 start 请求的 Response Headers → location（pixiv://account/login?code=...）再复制。');
  } else {
    console.error('✗ 没解析到 code，请重试。');
  }
  process.exit(2);
}

// 3) 换 refresh_token
const r = await tokenRequest({
  grant_type: 'authorization_code',
  code,
  code_verifier: verifier,
  redirect_uri: REDIRECT_URI,
  include_policy: 'true',
});

if (r.status !== 200 || !r.json?.refresh_token) {
  const err = JSON.stringify(r.json?.error ?? r.json).slice(0, 300);
  console.error(`✗ 兑换失败：HTTP ${r.status} ${err}`);
  console.error('  原始响应：' + JSON.stringify(r.json).slice(0, 500));
  if (err.includes('invalid_grant') || err.includes('invalid_request')) {
    console.error('  常见原因（按概率排序）：');
    console.error('  1) code 已过期 —— 只有约 30 秒；请先在 F12 → Network 面板准备，再登录，复制后立刻粘贴；');
    console.error('  2) code 已被使用 —— 同一 URL 只能兑换一次，重试要重新登录；');
    console.error('  3) 复制的 URL 不完整（缺少 code= 之后的内容）；');
    console.error('  4) 若登录页本身就报「不正确的请求。」，说明登录 URL 被截断/篡改，');
    console.error('     请重新运行本脚本，手动复制脚本打印的完整登录地址（不要用旧窗口里的地址）。');
  }
  process.exit(3);
}

const user = r.json.response?.user || {};
const refreshToken = r.json.refresh_token;

// 4) 保存（尽量收紧权限）
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, refreshToken + '\n', { mode: 0o600 });
writeFileSync(
  outPath.replace(/\.txt$/, '') + '-account.json',
  JSON.stringify({ id: user.id, name: user.name, account: user.account, is_premium: user.is_premium, saved_at: new Date().toISOString() }, null, 2) + '\n',
);

console.log(`\n✓ 登录成功：${user.name ?? '?'} (id=${user.id ?? '?'}, premium=${user.is_premium ?? '?'})`);
console.log(`  refresh_token 已保存：${outPath}`);
console.log('  用法：');
console.log(`    $env:PIXIV_REFRESH_TOKEN = Get-Content "${outPath}"`);
console.log('    node --use-env-proxy scripts/probe.mjs --tag 初音ミク --rate-test');
console.log('  或：  node scripts/login.mjs --check   # 验证 token 是否可用');
if (opt.print) console.log(`\nrefresh_token: ${refreshToken}`);

// 5) 顺手验证一次 access_token 可用
await sleep(200);
const v = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
console.log(v.status === 200 && v.json?.response?.access_token ? '✓ 刷新验证通过（后续运行可直接用该 token）' : `⚠ 刷新验证失败：HTTP ${v.status}`);
